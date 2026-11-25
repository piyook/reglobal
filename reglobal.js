#!/usr/bin/env node
// reglobal: after switching to a new Node version, reinstall the global npm
// packages you had in an older one. Reads the old version's global
// node_modules folder directly, so the old npm (or Node) never has to run.
// No dependencies on purpose: it must work in a fresh Node with no globals.
// `export` and `import` move the list through a JSON file instead.

import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { emitKeypressEvents } from 'node:readline';
import { createInterface } from 'node:readline/promises';
import { parseArgs, stripVTControlCharacters } from 'node:util';

const VERSION = JSON.parse(readFileSync(new URL('./package.json', import.meta.url))).version;
const SCHEMA_VERSION = 1;

const HELP = `Usage: reglobal [<old> [<new>]] [--dry-run | --yes | -i] [--skip <names> | --only <names>]
                [--keep-versions] [--offline] [--json]
       reglobal --list [<version>] [--json]
       reglobal --compare [<old> [<new>]] [--offline] [--json]
       reglobal export [<file>] [--from <version>] [--yes] [--json]
       reglobal import <file> [<new>] [the install options above]
       reglobal import <file> --list
       reglobal import <file> [<new>] --compare

Reinstall the global npm packages from an old Node version into a new one.
Asks before installing.

  reglobal 24.22.3 26.13.1   from Node 24.22.3 into Node 26.13.1
  reglobal 24 26             the newest installed 24.x into the newest 26.x
  reglobal 24                from the newest 24.x into the Node in use
  reglobal                   from the newest other version into the Node in use

  reglobal export globals.json    save the Node in use's globals to a file
                                  (--from 24 for another version; no file: stdout)
  reglobal import globals.json    install them from the file, on any machine

  reglobal --list            the globals of the Node in use (--list 24 for Node 24)
  reglobal --compare 24 26   what Node 24 has and Node 26 hasn't, installing nothing

<old> and <new> are versions (24, 24.1, 24.1.0) or a version's install folder.
<new> defaults to the Node in use; installing into another one runs that
version's own node and npm.

Options:
  --from <v|path>  the same as <old>. Default: the newest installed version
                   other than <new>.
  --to <v|path>    the same as <new>. Default: the Node in use.
  --dry-run        show what would be installed, install nothing
  -y, --yes        install without asking (needed with --json or no terminal)
  --keep-versions  install the same versions as before, not the latest
  --skip <names>   leave these packages out (comma separated, or repeat it)
  --only <names>   install only these packages
  -i, --interactive  tick and untick packages in a checklist before installing
  --offline        don't look up the latest versions on the registry
  --list           show one version's globals, or a file's (read-only)
  --compare        show the old version's globals next to the new one's (read-only)
  --json           print JSON on stdout

At the question, answer e to type the names of packages to leave out.
  -h, --help       show this help
  -v, --version    print the version

Finds versions installed by fnm, nvm, nvm-windows, mise, asdf and n.

Exit codes: 0 done, 1 error, 2 nothing to install, 3 cancelled.`;

// Packages that come with Node itself: never reinstall them.
const BUNDLED = new Set(['npm', 'corepack']);

class UsageError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// ---------------------------------------------------------------- versions

const VERSION_DIR = /^v?(\d+)\.(\d+)\.(\d+)$/;

function parseVersion(s) {
  const m = VERSION_DIR.exec(s);
  return m ? m.slice(1).map(Number) : null;
}

function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

// Each manager keeps one folder per version under `root`. `modules` lists the
// places the global node_modules can sit inside it: lib/ on POSIX, none on Windows.
function managerRoots(env) {
  const home = os.homedir();
  const win = process.platform === 'win32';
  const appData = env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const localAppData = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const xdgData = env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  const fnmDefault = win
    ? path.join(appData, 'fnm')
    : process.platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support', 'fnm')
      : path.join(xdgData, 'fnm');
  const fnmDirs = env.FNM_DIR ? [env.FNM_DIR] : [fnmDefault, path.join(home, '.fnm')];
  const misedir = env.MISE_DATA_DIR || (win ? path.join(localAppData, 'mise') : path.join(xdgData, 'mise'));
  const both = ['lib/node_modules', 'node_modules'];
  return [
    ...fnmDirs.map((d) => ({ manager: 'fnm', root: path.join(d, 'node-versions'), modules: both.map((m) => `installation/${m}`) })),
    { manager: 'nvm', root: path.join(env.NVM_DIR || path.join(home, '.nvm'), 'versions', 'node'), modules: both },
    { manager: 'nvm-windows', root: env.NVM_HOME || path.join(appData, 'nvm'), modules: both },
    { manager: 'mise', root: path.join(misedir, 'installs', 'node'), modules: both },
    { manager: 'asdf', root: path.join(env.ASDF_DATA_DIR || path.join(home, '.asdf'), 'installs', 'nodejs'), modules: both },
    { manager: 'n', root: path.join(env.N_PREFIX || '/usr/local', 'n', 'versions', 'node'), modules: both },
  ];
}

function listDir(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function firstExisting(dirs) {
  return dirs.find((d) => existsSync(d));
}

// Every installed Node version we can find, newest first. Symlinked version
// folders (mise makes `24` -> `24.1.0`) and duplicates are left out.
function findVersions(env = process.env) {
  const seen = new Set();
  const found = [];
  for (const { manager, root, modules } of managerRoots(env)) {
    for (const entry of listDir(root)) {
      const parsed = parseVersion(entry.name);
      if (!parsed || !entry.isDirectory()) continue;
      const dir = firstExisting(modules.map((m) => path.join(root, entry.name, m)));
      if (!dir) continue;
      const real = realpathSync(dir);
      if (seen.has(real)) continue;
      seen.add(real);
      found.push({ version: parsed.join('.'), manager, dir, parsed });
    }
  }
  return found.sort((a, b) => compareVersions(b.parsed, a.parsed));
}

// The global node_modules of the Node running now. An npm prefix set in the
// environment wins; otherwise it sits next to node (Windows) or in ../lib.
function currentGlobalDir(env = process.env) {
  // npm sets npm_config_global_prefix (and npm_config_prefix) under npx and npm run.
  const prefix = env.npm_config_global_prefix || env.npm_config_prefix || env.NPM_CONFIG_PREFIX;
  if (prefix) return path.join(prefix, process.platform === 'win32' ? 'node_modules' : path.join('lib', 'node_modules'));
  const bin = path.dirname(process.execPath);
  return process.platform === 'win32' ? path.join(bin, 'node_modules') : path.join(bin, '..', 'lib', 'node_modules');
}

function sameDir(a, b) {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

function fromPath(p) {
  const candidates =
    path.basename(p) === 'node_modules'
      ? [p]
      : [path.join(p, 'lib', 'node_modules'), path.join(p, 'node_modules'), path.join(p, 'installation', 'node_modules')];
  const dir = firstExisting(candidates);
  if (!dir) throw new UsageError('NOT_FOUND', `no global node_modules folder in ${p}`);
  return { version: versionInPath(dir), manager: null, dir };
}

// The nearest folder above a node_modules whose name is a version, if any.
function versionInPath(dir) {
  for (let d = path.resolve(dir); d !== path.dirname(d); d = path.dirname(d)) {
    const v = parseVersion(path.basename(d));
    if (v) return v.join('.');
  }
  return null;
}

function looksLikePath(s) {
  return /[\\/]/.test(s) || s.startsWith('.') || s.startsWith('~');
}

const installedList = (versions) => (versions.length ? versions.map((v) => `${v.version} (${v.manager})`).join(', ') : 'none');
const expandHome = (p) => p.replace(/^~(?=$|[\\/])/, os.homedir());

// The newest of `candidates` matching 24, 24.1 or 24.1.0 (a leading v is fine).
function matchVersion(spec, candidates, label) {
  const want = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(spec);
  if (!want) throw new UsageError('BAD_VERSION', `${label} ${spec} is not a version (24, 24.1, 24.1.0) or a path`);
  const parts = want
    .slice(1)
    .filter((p) => p !== undefined)
    .map(Number);
  return candidates.find((v) => parts.every((n, i) => v.parsed[i] === n));
}

// Pick the old version: the one asked for, or the newest one other than the target.
function resolveFrom(from, versions, target) {
  if (from && looksLikePath(from)) return fromPath(expandHome(from));
  const others = versions.filter((v) => !sameDir(v.dir, target));
  if (!from) {
    if (!others.length)
      throw new UsageError('NO_OLD_VERSION', `no other Node version found (installed: ${installedList(versions)}). Use --from <path> for another manager.`);
    return others[0];
  }
  const match = matchVersion(from, others, 'the old version');
  if (!match) throw new UsageError('NOT_FOUND', `no installed Node ${from} other than the one installed into (installed: ${installedList(versions)})`);
  return match;
}

// Where a Node install keeps node, from its global node_modules folder.
function prefixOf(dir) {
  return process.platform === 'win32' ? path.dirname(dir) : path.dirname(path.dirname(dir));
}

function nodeIn(prefix) {
  return process.platform === 'win32' ? path.join(prefix, 'node.exe') : path.join(prefix, 'bin', 'node');
}

// The Node in use: its version, and its manager when it is one we found.
function currentNode(versions, env) {
  const dir = currentGlobalDir(env);
  const known = versions.find((v) => sameDir(v.dir, dir));
  return { version: process.versions.node, manager: known?.manager ?? null, dir };
}

// The Node to install into: the one asked for, or the one running reglobal.
// `node` is that version's own node, which runs its own npm.
function resolveTarget(spec, versions, env) {
  if (!spec) return { ...currentNode(versions, env), node: process.execPath, current: true };
  const found = looksLikePath(spec) ? fromPath(expandHome(spec)) : matchVersion(spec, versions, 'the new version');
  if (!found) throw new UsageError('NOT_FOUND', `no installed Node ${spec} to install into (installed: ${installedList(versions)})`);
  const dir = found.dir;
  const current = sameDir(dir, currentGlobalDir(env));
  const node = current ? process.execPath : nodeIn(prefixOf(dir));
  if (!existsSync(node)) throw new UsageError('NO_NODE', `no node in ${prefixOf(dir)}: is Node ${spec} installed there?`);
  return { version: current ? process.versions.node : found.version, manager: found.manager, dir, node, current };
}

// The Node to export from: the one asked for (any installed version, or a
// folder), or the one in use. Its node never runs, so it needn't work.
function resolveSource(spec, versions, env) {
  if (!spec) return currentNode(versions, env);
  if (looksLikePath(spec)) return fromPath(expandHome(spec));
  const found = matchVersion(spec, versions, 'the version to export');
  if (!found) throw new UsageError('NOT_FOUND', `no installed Node ${spec} (installed: ${installedList(versions)})`);
  return found;
}

// ---------------------------------------------------------------- packages

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// Where a package came from: the registry, git or a file/tarball. npm 7+ keeps
// this in node_modules/.package-lock.json; older npm wrote _resolved/_from into
// the package's own package.json. With neither, assume the registry.
function sourceOf(resolved) {
  if (!resolved) return 'registry';
  if (/^(git\+|git:|github:|gitlab:|bitbucket:)/.test(resolved)) return 'git';
  if (/^https?:\/\/.+\/-\/[^/]+\.tgz$/.test(resolved)) return 'registry';
  if (/^https?:/.test(resolved)) return 'url';
  return 'file';
}

function packageDirs(dir) {
  const out = [];
  for (const entry of listDir(dir)) {
    if (entry.name.startsWith('.')) continue;
    if (entry.name.startsWith('@') && entry.isDirectory()) {
      for (const sub of listDir(path.join(dir, entry.name))) if (!sub.name.startsWith('.')) out.push(`${entry.name}/${sub.name}`);
    } else out.push(entry.name);
  }
  return out;
}

function readPackage(dir, name, lock) {
  const full = path.join(dir, ...name.split('/'));
  const pkg = readJson(path.join(full, 'package.json'));
  const locked = lock?.packages?.[`node_modules/${name}`] ?? {};
  const info = { name, version: pkg?.version ?? locked.version ?? null };
  if (lstatSync(full).isSymbolicLink() || locked.link) {
    info.status = 'linked';
    // Always absolute, so the path still means something in an export: the
    // lockfile's is relative to the folder holding node_modules, and a
    // symlink's to the folder the link sits in.
    info.link = locked.resolved ? path.resolve(path.dirname(dir), locked.resolved) : path.resolve(path.dirname(full), readlinkSync(full));
    return info;
  }
  if (!pkg) {
    info.status = 'broken';
    return info;
  }
  const resolved = locked.resolved ?? pkg._resolved ?? null;
  info.source = sourceOf(resolved);
  if (info.source !== 'registry') info.resolved = resolved;
  return info;
}

// The global packages in one node_modules folder, sorted by name.
function readGlobals(dir) {
  const lock = readJson(path.join(dir, '.package-lock.json'));
  return packageDirs(dir)
    .sort()
    .map((name) => readPackage(dir, name, lock));
}

// ---------------------------------------------------------------- compare

function statusOf(pkg, here) {
  if (pkg.status) return pkg.status;
  if (BUNDLED.has(pkg.name)) return 'skipped';
  if (here) return 'present';
  // A file: path was relative to the old folder, so it can't be installed again from here.
  return pkg.source === 'file' ? 'manual' : 'install';
}

function matchUp(oldPkgs, currentPkgs) {
  const current = new Map(currentPkgs.map((p) => [p.name, p]));
  return oldPkgs.map((p) => {
    const here = current.get(p.name);
    const out = { ...p, status: statusOf(p, here) };
    if (here && out.status !== 'linked' && out.status !== 'broken') out.currentVersion = here.version;
    return out;
  });
}

function summarize(packages) {
  const summary = { install: 0, excluded: 0, present: 0, skipped: 0, linked: 0, manual: 0, broken: 0 };
  for (const p of packages) summary[p.status]++;
  return summary;
}

function warningsFor(packages) {
  const warnings = [];
  for (const p of packages) {
    if (p.status === 'linked') warnings.push(`${p.name} is an npm link to ${p.link}: not reinstalled. Run npm link again in that folder.`);
    if (p.status === 'broken') warnings.push(`${p.name} has no readable package.json: not reinstalled.`);
    if (p.status === 'manual') warnings.push(`${p.name} was installed from a file (${p.resolved}): not reinstalled. Install it again by hand.`);
    if (p.status === 'install' && p.source !== 'registry') warnings.push(`${p.name} is reinstalled from ${p.source} (${p.resolved}), not the registry.`);
  }
  return warnings;
}

const LABELS = {
  install: 'to install',
  excluded: 'left out',
  present: 'installed',
  skipped: 'skipped',
  linked: 'linked',
  manual: 'manual',
  broken: 'broken',
};

// ---------------------------------------------------------------- styling

// Colour and Unicode symbols only on a terminal. NO_COLOR turns them off and
// FORCE_COLOR on. Pipes, logs and agents get plain ASCII.
function makeStyle(stream, env = process.env) {
  const on = !env.NO_COLOR && (env.FORCE_COLOR ? env.FORCE_COLOR !== '0' : Boolean(stream.isTTY) && env.TERM !== 'dumb');
  const sgr = (open, close) => (text) => (on ? `\x1b[${open}m${text}\x1b[${close}m` : String(text));
  return {
    bold: sgr(1, 22),
    dim: sgr(2, 22),
    red: sgr(31, 39),
    green: sgr(32, 39),
    yellow: sgr(33, 39),
    cyan: sgr(36, 39),
    arrow: on ? '→' : '->',
    pointer: on ? '❯' : '>',
    ticked: on ? '◉' : '[x]',
    unticked: on ? '◯' : '[ ]',
    ok: on ? '✔ ' : '',
    ask: on ? '? ' : '',
    sep: on ? ' · ' : ', ',
  };
}

const OUT = makeStyle(process.stdout);
const ERR = makeStyle(process.stderr);

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

const STATUS_COLOR = { install: 'green', excluded: 'dim', present: 'dim', skipped: 'dim', linked: 'yellow', manual: 'yellow', broken: 'red' };

// "5.4.0 -> 5.9.3 (major)": the old version, and the one @latest gets.
function versionPart(p, s) {
  const v = p.version ?? '';
  if (!p.latest || p.latest === p.version) return v;
  return `${s.dim(v)} ${s.arrow} ${s.green(p.latest)}${p.majorUpdate ? ` ${s.yellow('(major)')}` : ''}`;
}

function noteFor(p) {
  if (p.status === 'present') return `(here: ${p.currentVersion})`;
  if (p.status === 'skipped' || p.status === 'bundled') return '(comes with Node)';
  if (p.status === 'linked') return `(npm link to ${p.link})`;
  if (p.status === 'broken') return '(no package.json)';
  if (p.source && p.source !== 'registry') return `(from ${p.source}: ${p.resolved})`;
  return '';
}

const nameWidth = (pkgs) => Math.min(40, Math.max(0, ...pkgs.map((p) => p.name.length)));

// Pad styled text by what shows on screen, not counting the colour codes.
const visible = (text) => stripVTControlCharacters(text).length;
const padStyled = (text, width) => text + ' '.repeat(Math.max(0, width - visible(text)));

function row(p, widths, s) {
  const label = s[STATUS_COLOR[p.status]](LABELS[p.status].padEnd(10));
  const name = p.status === 'install' ? s.bold(p.name.padEnd(widths.name)) : p.name.padEnd(widths.name);
  const note = noteFor(p);
  const version = versionPart(p, s);
  return `  ${label}  ${name}  ${note ? `${padStyled(version, widths.version)}  ${s.dim(note)}` : version}`.trimEnd();
}

const nodeName = (v) => `Node ${v.version ?? '?'}${v.manager ? ` (${v.manager})` : ''}`;
// "Node 24.3.0 (fnm)", or "globals.json (Node 22.1.0 (nvm))" for an export file.
const sideName = (v) => (v.file ? `${path.basename(v.file)} (${nodeName(v)})` : nodeName(v));

function printComparison(r) {
  const s = OUT;
  const from = sideName(r.from);
  const to = nodeName(r.to);
  const w = Math.max(from.length, to.length);
  console.log(`${s.bold('From')} ${from.padEnd(w)}  ${s.dim(r.from.file ?? r.from.dir)}`);
  console.log(`${s.bold('To')}   ${to.padEnd(w)}  ${s.dim(r.to.dir)}\n`);
  if (!r.packages.length) console.log(s.dim('  no global packages'));
  const widths = { name: nameWidth(r.packages), version: Math.max(0, ...r.packages.map((p) => visible(versionPart(p, s)))) };
  for (const p of r.packages) console.log(row(p, widths, s));
  const c = r.summary;
  const parts = [s.green(`${c.install} to install`)];
  if (c.excluded) parts.push(`${c.excluded} left out`);
  parts.push(`${c.present} already here`, `${c.skipped + c.linked + c.manual + c.broken} skipped`);
  console.log(`\n${parts.join(s.sep)}`);
  for (const w of r.warnings) console.error(`${ERR.yellow('WARNING:')} ${w}`);
}

// ---------------------------------------------------------------- latest versions

// A move to a new major version (or, below 1.0, a new minor) can break things.
function isMajorUpdate(from, to) {
  const a = /^(\d+)\.(\d+)/.exec(from ?? '');
  const b = /^(\d+)\.(\d+)/.exec(to ?? '');
  if (!a || !b) return false;
  if (a[1] !== b[1]) return Number(b[1]) > Number(a[1]);
  return a[1] === '0' && Number(b[2]) > Number(a[2]);
}

async function latestVersion(registry, name) {
  try {
    const url = `${registry.replace(/\/+$/, '')}/${name.replace('/', '%2F')}/latest`;
    const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const { version } = await res.json();
    return typeof version === 'string' ? version : null;
  } catch {
    return null;
  }
}

// Look up what @latest is for each registry package to install. Only public
// package names are sent, never a token. npm_config_registry picks the registry.
async function addLatest(r, env) {
  const targets = r.packages.filter((p) => p.status === 'install' && p.source === 'registry');
  if (!targets.length) return;
  const registry = env.npm_config_registry || env.NPM_CONFIG_REGISTRY || 'https://registry.npmjs.org/';
  const found = await Promise.all(targets.map((p) => latestVersion(registry, p.name)));
  targets.forEach((p, i) => {
    p.latest = found[i];
    p.majorUpdate = isMajorUpdate(p.version, found[i]);
  });
  if (found.every((v) => v === null)) r.warnings.push(`could not get the latest versions from ${registry}: pass --offline to skip the lookup`);
}

// The old side: an export file, or an installed version's globals.
function oldSide(opts, versions, target) {
  if (opts.import) return readExport(opts.import);
  const from = resolveFrom(opts.from, versions, target.dir);
  return { from: { version: from.version, manager: from.manager, dir: from.dir }, packages: readGlobals(from.dir) };
}

async function comparison(opts, env = process.env) {
  const versions = findVersions(env);
  const target = resolveTarget(opts.to, versions, env);
  const old = oldSide(opts, versions, target);
  const packages = matchUp(old.packages, readGlobals(target.dir));
  const r = {
    schemaVersion: SCHEMA_VERSION,
    command: 'compare',
    from: old.from,
    to: { version: target.version, manager: target.manager, dir: target.dir },
    packages,
    summary: summarize(packages),
    warnings: warningsFor(packages),
  };
  if (!opts.offline && !opts['keep-versions']) await addLatest(r, env);
  // Not enumerable, so it stays out of the JSON: install needs the node to run.
  Object.defineProperty(r, 'target', { value: target });
  return r;
}

// ---------------------------------------------------------------- list

// One version's globals, or an export file's, as they are: nothing compared,
// nothing looked up. npm and corepack are marked as coming with Node.
function listing(opts, env = process.env) {
  let side;
  if (opts.import) side = readExport(opts.import);
  else {
    const src = resolveSource(opts.from, findVersions(env), env);
    side = { from: { version: src.version, manager: src.manager, dir: src.dir }, packages: readGlobals(src.dir) };
  }
  const packages = side.packages.map((p) => (!p.status && BUNDLED.has(p.name) ? { ...p, status: 'bundled' } : p));
  const count = (status) => packages.filter((p) => p.status === status).length;
  return {
    schemaVersion: SCHEMA_VERSION,
    command: 'list',
    node: side.from,
    packages,
    summary: { packages: packages.length, bundled: count('bundled'), linked: count('linked'), broken: count('broken') },
  };
}

function printListing(r) {
  const s = OUT;
  console.log(`${s.bold(sideName(r.node))}  ${s.dim(r.node.file ?? r.node.dir)}\n`);
  if (!r.packages.length) console.log(s.dim('  no global packages'));
  const widths = { name: nameWidth(r.packages), version: Math.max(0, ...r.packages.map((p) => (p.version ?? '').length)) };
  for (const p of r.packages) {
    const note = noteFor(p);
    const color = p.status === 'broken' ? s.red : p.status === 'linked' ? s.yellow : String;
    console.log(`  ${color(p.name.padEnd(widths.name))}  ${(p.version ?? '').padEnd(widths.version)}  ${s.dim(note)}`.trimEnd());
  }
  console.log(`\n${plural(r.packages.length, 'package')}`);
}

// --list with a second version, or --to, most likely meant the comparison.
function checkListOptions(opts) {
  if (opts.offline) throw new UsageError('BAD_OPTION', '--offline does not go with --list, which never asks the registry');
  if (!opts.to) return;
  if (opts.import)
    throw new UsageError('BAD_OPTION', `--list shows the file alone: to compare it with Node ${opts.to}, use import ${opts.import} --compare ${opts.to}`);
  throw new UsageError('BAD_OPTION', `--list shows one version: to compare two, use --compare ${opts.from ?? '<old>'} ${opts.to}`);
}

// ---------------------------------------------------------------- export and import

const EXPORT_KIND = 'reglobal-export';

// One package as it goes in an export file. npm and corepack come with every
// Node, and a broken folder has nothing to say, so they are left out.
function exportEntry(p) {
  const e = { name: p.name, version: p.version };
  if (p.status === 'linked') return Object.assign(e, { status: 'linked', link: p.link });
  return Object.assign(e, { source: p.source }, p.resolved ? { resolved: p.resolved } : {});
}

const EXPORT_CONFLICTS = ['to', 'list', 'compare', 'dry-run', 'keep-versions', 'skip', 'only', 'interactive', 'offline'];

// 0 written. With no file the export goes to stdout; a file that exists is
// only overwritten with --yes, so `reglobal export package.json` can't destroy it.
function exportCmd(opts, json, env = process.env) {
  const extra = EXPORT_CONFLICTS.find((o) => opts[o]);
  if (extra) throw new UsageError('BAD_OPTION', `--${extra} does not go with export`);
  const src = resolveSource(opts.from, findVersions(env), env);
  const packages = readGlobals(src.dir)
    .filter((p) => p.status !== 'broken' && !BUNDLED.has(p.name))
    .map(exportEntry);
  const data = {
    schemaVersion: SCHEMA_VERSION,
    kind: EXPORT_KIND,
    exportedAt: new Date().toISOString(),
    from: { version: src.version, manager: src.manager },
    packages,
  };
  const text = `${JSON.stringify(data, null, 2)}\n`;
  if (!opts.file) {
    process.stdout.write(text);
    return 0;
  }
  const file = path.resolve(expandHome(opts.file));
  writeExport(file, text, opts.yes);
  if (json) console.log(JSON.stringify({ schemaVersion: SCHEMA_VERSION, command: 'export', file, from: data.from, packages: packages.length }, null, 2));
  else console.log(OUT.green(`${OUT.ok}Exported ${plural(packages.length, 'package')} from Node ${src.version ?? '?'} to ${file}`));
  return 0;
}

// 'wx' creates the file only if nothing is there, checked and created in one
// step. On POSIX it also fails on a symlink that points nowhere, but Windows
// follows the link and creates its target, so a symlink is refused first.
// --yes overwrites.
function writeExport(file, text, overwrite) {
  const exists = () => new UsageError('FILE_EXISTS', `${file} already exists: pass --yes to overwrite it, or pick another name`);
  if (!overwrite) {
    let isLink = false;
    try {
      isLink = lstatSync(file).isSymbolicLink();
    } catch {
      // nothing there: 'wx' below creates it
    }
    if (isLink) throw exists();
  }
  try {
    writeFileSync(file, text, { flag: overwrite ? 'w' : 'wx' });
  } catch (err) {
    if (err.code === 'EEXIST') throw exists();
    if (err.code === 'ENOENT') throw new UsageError('NOT_FOUND', `the folder ${path.dirname(file)} does not exist`);
    if (err.code === 'EISDIR') throw new UsageError('BAD_OPTION', `${file} is a folder: give a file name`);
    throw err;
  }
}

// npm package names: an optional @scope/, then letters, digits and - . _ ~,
// never starting with - or . (so a name can't pass for an npm option).
const PACKAGE_NAME = /^(@[a-z0-9][\w.~-]*\/)?[a-z0-9][\w.~-]*$/i;
const VERSION_TEXT = /^[0-9A-Za-z.+-]+$/;

function badFile(file, why) {
  return new UsageError('BAD_FILE', `${file} ${why}`);
}

// Control characters (C0, DEL and C1) in text from a file could move the
// cursor or recolour the terminal, and hide a warning before the question.
const isControl = (ch) => {
  const n = ch.codePointAt(0);
  return n < 32 || (n >= 127 && n < 160);
};
const hasControl = (s) => [...s].some(isControl);
const stripControl = (s) => [...s].filter((ch) => !isControl(ch)).join('');

// An export file could come from anywhere: keep only what reglobal itself
// would have written, and work out each source again from `resolved`.
function importEntry(e, i, file) {
  if (!e || typeof e.name !== 'string' || !PACKAGE_NAME.test(e.name)) throw badFile(file, `has no valid package name in entry ${i + 1}`);
  const version = typeof e.version === 'string' && VERSION_TEXT.test(e.version) ? e.version : null;
  if (e.status === 'linked') return { name: e.name, version, status: 'linked', link: stripControl(String(e.link ?? '?')) };
  const resolved = typeof e.resolved === 'string' ? e.resolved : null;
  // A URL is handed to npm, so a bad one is refused rather than tidied up.
  if (resolved && hasControl(resolved)) throw badFile(file, `has control characters in the source of ${e.name}`);
  const source = sourceOf(resolved);
  return { name: e.name, version, source, ...(source === 'registry' ? {} : { resolved }) };
}

// Text as Windows tools save it too: PowerShell 5.1's `>` writes UTF-16 with
// a byte order mark, and other tools put a BOM before UTF-8.
function decodeText(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf[0] === 0xfe && buf[1] === 0xff) return Buffer.from(buf.subarray(2)).swap16().toString('utf16le');
  const text = buf.toString('utf8');
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function checkSchema(data, file) {
  if (data?.kind !== EXPORT_KIND || !Array.isArray(data.packages)) throw badFile(file, 'is not a reglobal export (make one with reglobal export <file>)');
  const v = data.schemaVersion;
  if (!Number.isInteger(v) || v < 1) throw badFile(file, 'has no valid schemaVersion: make it again with reglobal export <file>');
  if (v > SCHEMA_VERSION) throw badFile(file, 'was made by a newer reglobal: update reglobal');
}

function readExport(spec) {
  const file = path.resolve(expandHome(spec));
  let data;
  try {
    data = JSON.parse(decodeText(readFileSync(file)));
  } catch (err) {
    if (err.code === 'ENOENT') throw new UsageError('NOT_FOUND', `no file ${file}`);
    throw badFile(file, 'is not a JSON file');
  }
  checkSchema(data, file);
  const byName = new Map();
  data.packages.forEach((e, i) => {
    const p = importEntry(e, i, file);
    if (!byName.has(p.name)) byName.set(p.name, p);
  });
  const text = (v) => (typeof v === 'string' && v.length < 40 ? stripControl(v) : null);
  return {
    from: { version: text(data.from?.version), manager: text(data.from?.manager), dir: null, file },
    packages: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

// ---------------------------------------------------------------- install

// What to give npm for one package: the registry name at the latest (or the
// same) version, or the git URL / tarball URL it came from. A git URL loses its
// #commit unless --keep-versions, so it gets the branch's latest.
function specFor(p, keep) {
  if (p.source === 'git') return keep ? p.resolved : p.resolved.replace(/#.*$/, '');
  if (p.source === 'url') return p.resolved;
  return `${p.name}@${keep && p.version ? p.version : 'latest'}`;
}

function npmCliIn(binDir) {
  const lib = process.platform === 'win32' ? '' : path.join('..', 'lib');
  return path.join(binDir, lib, 'node_modules', 'npm', 'bin', 'npm-cli.js');
}

// The npm of the Node installed into. For the Node running now, the one that
// came with it or the first on PATH; for another version, the one in its own
// global folder. It is run as `node npm-cli.js`, never through a shell, so
// nothing in a package name or URL is read by cmd.exe or sh.
// REGLOBAL_NPM_CLI overrides it.
function findNpmCli(target, env) {
  if (env.REGLOBAL_NPM_CLI) {
    if (!existsSync(env.REGLOBAL_NPM_CLI)) throw new UsageError('NO_NPM', `REGLOBAL_NPM_CLI is set to ${env.REGLOBAL_NPM_CLI}, which does not exist`);
    return env.REGLOBAL_NPM_CLI;
  }
  const pathDirs = (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  const candidates = target.current ? [path.dirname(process.execPath), ...pathDirs].map(npmCliIn) : [path.join(target.dir, 'npm', 'bin', 'npm-cli.js')];
  const cli = firstExisting(candidates);
  if (!cli)
    throw new UsageError('NO_NPM', target.current ? 'npm was not found next to this Node or on PATH' : `Node ${target.version} has no npm in ${target.dir}`);
  return cli;
}

// npm installs into the prefix it is given. Under npx, npm passes its own
// prefix down in npm_config_*, which would point at the Node npx runs in, so
// every spelling of it is replaced with the target's.
function npmEnv(target, env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) if (!/^npm_config_(global_)?prefix$/i.test(k)) out[k] = v;
  out.npm_config_prefix = prefixOf(target.dir);
  return out;
}

function runNpm(target, specs, env) {
  const cli = findNpmCli(target, env);
  // npm's own output goes to stderr, so stdout stays clean for --json.
  const r = spawnSync(target.node, [cli, 'install', '--global', '--', ...specs], { stdio: ['ignore', 2, 2], env: npmEnv(target, env) });
  if (r.error) throw r.error;
  return r.status ?? 1;
}

// ---------------------------------------------------------------- choosing

function makePlan(r) {
  r.plan = r.packages
    .filter((p) => p.status === 'install')
    .map((p) => {
      const entry = { name: p.name, version: p.version, source: p.source, spec: specFor(p, r.keepVersions) };
      if ('latest' in p) Object.assign(entry, { latest: p.latest, majorUpdate: p.majorUpdate });
      return entry;
    });
  r.summary = summarize(r.packages);
}

function splitNames(values) {
  return values
    .flatMap((v) => v.split(/[\s,]+/))
    .map((v) => v.trim())
    .filter(Boolean);
}

// Every name must be one of the packages to install: a typo in --skip would
// otherwise install the very package it was meant to leave out.
function checkNames(r, names) {
  const plan = new Set(r.plan.map((p) => p.name));
  for (const name of names) {
    if (plan.has(name)) continue;
    const pkg = r.packages.find((p) => p.name === name);
    const old = r.from.file ? path.basename(r.from.file) : `Node ${r.from.version ?? '(old)'}`;
    const why = pkg ? `its status is ${pkg.status}` : `${old} has no global package by that name`;
    throw new UsageError('BAD_NAME', `${name} is not one of the packages to install: ${why}`);
  }
}

function leaveOut(r, names) {
  checkNames(r, names);
  const drop = new Set(names);
  for (const p of r.packages) if (drop.has(p.name)) p.status = 'excluded';
  makePlan(r);
}

function applyFilters(r, opts) {
  const skip = splitNames(opts.skip ?? []);
  const only = splitNames(opts.only ?? []);
  if (skip.length && only.length) throw new UsageError('BAD_OPTION', '--skip and --only do not go together: use one of them');
  if (skip.length) leaveOut(r, skip);
  if (only.length) {
    checkNames(r, only);
    leaveOut(
      r,
      r.plan.map((p) => p.name).filter((n) => !only.includes(n)),
    );
  }
}

// One readline for every question, so typed-ahead answers aren't lost.
function prompter() {
  const rl = createInterface({ input: process.stdin, terminal: Boolean(process.stdin.isTTY) });
  const lines = rl[Symbol.asyncIterator]();
  return {
    async ask(question) {
      process.stderr.write(question);
      const { value, done } = await lines.next();
      return done ? null : value.trim();
    },
    close: () => rl.close(),
  };
}

// y installs, e asks which names to leave out and asks again, anything else cancels.
async function confirm(r) {
  const p = prompter();
  try {
    for (;;) {
      const s = ERR;
      const question = `Install ${plural(r.plan.length, 'package')} into Node ${r.to.version}?`;
      const answer = (await p.ask(`\n${s.cyan(s.ask)}${s.bold(question)} ${s.dim('[y/N, e to leave some out]')} `)) ?? '';
      if (/^y(es)?$/i.test(answer)) return true;
      if (!/^e(dit)?$/i.test(answer)) return false;
      const names = splitNames([(await p.ask(`${s.cyan(s.ask)}${s.bold('Names to leave out')} ${s.dim('(space or comma separated)')} `)) ?? '']);
      try {
        leaveOut(r, names);
      } catch (err) {
        console.error(`${s.red('reglobal:')} ${err.message}`);
        continue;
      }
      if (!r.plan.length) return false;
      printRun(r);
    }
  } finally {
    p.close();
  }
}

// The arrow-key checklist for -i. It draws on stderr and redraws in place.
// Returns the names left ticked, or null when cancelled.
function checklist(items) {
  const { stdin, stderr: out } = process;
  const s = ERR;
  const on = items.map(() => true);
  const width = nameWidth(items);
  const keyHelp =
    s.arrow === '->' ? 'up/down move, space tick, a all or none, enter go on, q cancel' : '↑/↓ move · space tick · a all/none · enter go on · q cancel';
  let cursor = 0;
  let drawn = 0;
  const line = (p, i) => {
    const here = i === cursor;
    const box = on[i] ? s.green(s.ticked) : s.dim(s.unticked);
    const name = p.name.padEnd(width);
    return `${here ? s.cyan(s.pointer) : ' '} ${box} ${here ? s.bold(s.cyan(name)) : on[i] ? name : s.dim(name)}  ${versionPart(p, s)}`;
  };
  const draw = () => {
    if (drawn) out.write(`\x1b[${drawn}A\x1b[0J`);
    const ticked = on.filter(Boolean).length;
    const lines = [
      `\n${s.cyan(s.ask)}${s.bold('Choose what to install')}  ${s.dim(keyHelp)}`,
      ...items.map(line),
      s.dim(`  ${ticked} of ${items.length} ticked`),
    ];
    const text = lines.join('\n');
    out.write(`${text}\n`);
    drawn = text.split('\n').length;
  };
  const keys = {
    up: () => {
      cursor = (cursor + items.length - 1) % items.length;
    },
    down: () => {
      cursor = (cursor + 1) % items.length;
    },
    space: () => {
      on[cursor] = !on[cursor];
    },
    a: () => on.fill(!on.every(Boolean)),
  };
  Object.assign(keys, { k: keys.up, j: keys.down });
  return new Promise((resolve) => {
    const done = (value) => {
      stdin.off('keypress', onKey);
      stdin.off('end', onEnd);
      if (out.isTTY) out.write('\x1b[?25h');
      if (stdin.isTTY) stdin.setRawMode(false);
      stdin.pause();
      resolve(value);
    };
    const onEnd = () => done(null);
    const onKey = (_str, key = {}) => {
      if ((key.ctrl && key.name === 'c') || key.name === 'escape' || key.name === 'q') return done(null);
      if (key.name === 'return' || key.name === 'enter') return done(items.filter((_, i) => on[i]).map((p) => p.name));
      keys[key.name]?.();
      draw();
    };
    emitKeypressEvents(stdin);
    if (stdin.isTTY) stdin.setRawMode(true);
    if (out.isTTY) out.write('\x1b[?25l'); // hide the cursor while the list is up
    stdin.on('keypress', onKey);
    stdin.on('end', onEnd);
    stdin.resume();
    draw();
  });
}

// ---------------------------------------------------------------- install flow

function printRun(r) {
  const s = OUT;
  console.log(`\n${s.bold(r.dryRun ? 'Would run:' : 'Runs:')} ${s.dim('npm install --global')} ${s.cyan(r.plan.map((p) => p.spec).join(' '))}`);
}

// A terminal to ask in. REGLOBAL_ASSUME_TTY=1 lets the tests answer through a pipe.
function canAsk(env) {
  return Boolean(process.stdin.isTTY) || env.REGLOBAL_ASSUME_TTY === '1';
}

function checkInstallOptions(opts, json, env) {
  if (!opts.interactive) return;
  if (json) throw new UsageError('BAD_OPTION', '--interactive does not go with --json: use --skip or --only');
  if (opts.yes) throw new UsageError('BAD_OPTION', '--interactive does not go with --yes: the checklist is the question');
  if (!canAsk(env)) throw new UsageError('NEEDS_TERMINAL', '--interactive needs a terminal: use --skip or --only');
}

function cancelled(message) {
  console.log(OUT.yellow(message));
  return 3;
}

// Ask, if asking is needed: the checklist for -i, otherwise y/N/e unless --yes.
// Returns an exit code to stop with, or null to go on.
async function choose(r, opts, json, env) {
  if (opts.interactive) {
    const picked = await checklist(r.plan);
    if (!picked) return cancelled('Cancelled: nothing installed.');
    leaveOut(
      r,
      r.plan.map((p) => p.name).filter((n) => !picked.includes(n)),
    );
    if (!r.plan.length) return cancelled('Nothing ticked: nothing installed.');
    printRun(r);
    return null;
  }
  if (r.dryRun || opts.yes) return null;
  if (json || !canAsk(env)) throw new UsageError('NEEDS_YES', 'nothing installed: pass --yes to install without asking, or --dry-run to preview');
  return (await confirm(r)) ? null : cancelled('Cancelled: nothing installed.');
}

// 0 installed, 1 failed, 2 nothing to install, 3 cancelled.
async function install(opts, json, env = process.env) {
  checkInstallOptions(opts, json, env);
  const r = Object.assign(await comparison(opts, env), { command: 'install', dryRun: Boolean(opts['dry-run']), keepVersions: Boolean(opts['keep-versions']) });
  makePlan(r);
  applyFilters(r, opts);
  const report = (code) => {
    if (json) console.log(JSON.stringify(r, null, 2));
    return code;
  };
  if (!json) printComparison(r);
  if (!r.plan.length) {
    if (!json) console.log(`\n${OUT.green(`${OUT.ok}Nothing to install.`)}`);
    return report(2);
  }
  if (!json && !opts.interactive) printRun(r);
  const stop = await choose(r, opts, json, env);
  if (stop !== null) return stop;
  if (r.dryRun) return report(0);
  r.npmExitCode = runNpm(
    r.target,
    r.plan.map((p) => p.spec),
    env,
  );
  const after = new Set(readGlobals(r.to.dir).map((p) => p.name));
  r.installed = r.plan.filter((p) => after.has(p.name)).map((p) => p.name);
  r.failed = r.plan.filter((p) => !after.has(p.name)).map((p) => p.name);
  if (r.npmExitCode === 0 && !r.failed.length) {
    if (!json) console.log(`\n${OUT.green(`${OUT.ok}Installed ${plural(r.installed.length, 'package')} into Node ${r.to.version}.`)}`);
    return report(0);
  }
  const message = `npm exited with ${r.npmExitCode}; not installed: ${r.failed.join(', ') || 'none'}`;
  r.error = { code: 'INSTALL_FAILED', message };
  if (!json) console.error(`${ERR.red('reglobal:')} ${message}`);
  return report(1);
}

// ---------------------------------------------------------------- cli

const INSTALL_ONLY = ['dry-run', 'yes', 'keep-versions', 'skip', 'only', 'interactive'];

const OPTIONS = {
  from: { type: 'string' },
  to: { type: 'string' },
  list: { type: 'boolean' },
  compare: { type: 'boolean' },
  'dry-run': { type: 'boolean' },
  yes: { type: 'boolean', short: 'y' },
  'keep-versions': { type: 'boolean' },
  skip: { type: 'string', multiple: true },
  only: { type: 'string', multiple: true },
  interactive: { type: 'boolean', short: 'i' },
  offline: { type: 'boolean' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
};

// `reglobal 24 26` is `--from 24` into Node 26; `reglobal 24` is `--from 24`.
function parse(args) {
  let parsed;
  try {
    parsed = parseArgs({ args, options: OPTIONS, strict: true, allowPositionals: true });
  } catch (e) {
    const opt = /'([^']+)'/.exec(e.message)?.[1] ?? args[0];
    if (e.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') throw new UsageError('UNKNOWN_OPTION', `unknown option ${opt} (see reglobal --help)`);
    throw new UsageError('BAD_OPTION', `${e.message.split('\n')[0]} (see reglobal --help)`);
  }
  const { values, positionals } = parsed;
  const [first, ...rest] = positionals;
  if (first === 'export') return parseExport(values, rest);
  if (first === 'import') return parseImport(values, rest);
  return parseVersions(values, positionals);
}

function setTarget(values, target) {
  if (target === undefined) return;
  if (values.to) throw new UsageError('BAD_OPTION', `give the new version once: ${target} or --to ${values.to}`);
  values.to = target;
}

function parseExport(values, rest) {
  if (rest.length > 1) throw new UsageError('BAD_OPTION', 'export takes one file: reglobal export [<file>] [--from <version>]');
  // `reglobal export 24` most likely means Node 24, not a file called 24.
  if (/^v?\d+(\.\d+){0,2}$/.test(rest[0] ?? '')) {
    throw new UsageError('BAD_OPTION', `${rest[0]} looks like a version: use --from ${rest[0]} to export it (or ./${rest[0]} for a file by that name)`);
  }
  return Object.assign(values, { command: 'export', file: rest[0] });
}

function parseImport(values, rest) {
  const [file, target, ...extra] = rest;
  if (file === undefined) throw new UsageError('BAD_OPTION', 'import needs a file: reglobal import <file> [<new>]');
  if (values.from) throw new UsageError('BAD_OPTION', '--from does not go with import: the file is the old version');
  if (extra.length) throw new UsageError('BAD_OPTION', 'too many arguments: import takes a file, then the new version');
  setTarget(values, target);
  return Object.assign(values, { import: file });
}

function parseVersions(values, positionals) {
  const [old, target, ...extra] = positionals;
  const notVersion = positionals.find((p) => !looksLikePath(p) && !/^v?\d+(\.\d+){0,2}$/.test(p));
  if (notVersion) throw new UsageError('UNKNOWN_COMMAND', `unknown command ${notVersion} (see reglobal --help)`);
  if (extra.length) throw new UsageError('BAD_OPTION', `too many versions: ${positionals.join(' ')}. Give the old one, then the new one.`);
  if (old !== undefined && values.from) throw new UsageError('BAD_OPTION', `give the old version once: ${old} or --from ${values.from}`);
  if (old !== undefined) values.from = old;
  setTarget(values, target);
  return values;
}

function fail(err, json) {
  const code = err instanceof UsageError ? err.code : 'ERROR';
  if (json) console.log(JSON.stringify({ schemaVersion: SCHEMA_VERSION, error: { code, message: err.message } }, null, 2));
  else console.error(`${ERR.red('reglobal:')} ${err.message}`);
  return 1;
}

export async function main(argv) {
  const args = argv.slice(2);
  const json = args.includes('--json');
  try {
    const opts = parse(args);
    if (opts.help) {
      console.log(HELP);
      return 0;
    }
    if (opts.version) {
      console.log(VERSION);
      return 0;
    }
    if (opts.command === 'export') return exportCmd(opts, json);
    if (opts.list && opts.compare) throw new UsageError('BAD_OPTION', '--list and --compare do not go together: --list shows one version, --compare two');
    const mode = opts.list ? 'list' : opts.compare ? 'compare' : null;
    if (!mode) return await install(opts, json);
    const extra = INSTALL_ONLY.find((o) => opts[o]);
    if (extra) throw new UsageError('BAD_OPTION', `--${extra} does not go with --${mode}, which installs nothing`);
    if (mode === 'list') checkListOptions(opts);
    const result = mode === 'list' ? listing(opts) : await comparison(opts);
    if (json) console.log(JSON.stringify(result, null, 2));
    else if (mode === 'list') printListing(result);
    else printComparison(result);
    return 0;
  } catch (err) {
    return fail(err, json);
  }
}

process.exitCode = await main(process.argv);
