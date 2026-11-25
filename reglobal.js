#!/usr/bin/env node
// reglobal: after switching to a new Node version, reinstall the global npm
// packages you had in an older one. Reads the old version's global
// node_modules folder directly, so the old npm (or Node) never has to run.
// No dependencies on purpose: it must work in a fresh Node with no globals.
//
// Built so far: finding the installed Node versions and their globals, and
// --list. Installing (--dry-run, --yes), export and import are still to write.

import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

const VERSION = JSON.parse(readFileSync(new URL('./package.json', import.meta.url))).version;
const SCHEMA_VERSION = 1;

const HELP = `Usage: reglobal --list [--from <version|path>] [--json]

Reinstall the global npm packages from another Node version into this one.

Options:
  --from <v|path>  the old Node version: 24, 24.1 or 24.1.0 picks the newest
                   installed match; a path is that version's install folder
                   or its global node_modules. Default: the newest installed
                   version other than this one.
  --list           show the old version's globals next to this one's (read-only)
  --json           print JSON on stdout
  -h, --help       show this help
  -v, --version    print the version

Finds versions installed by fnm, nvm, nvm-windows, mise, asdf and n.

Not built yet: installing (--dry-run, --yes, --keep-versions), export, import.`;

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

// Pick the old version from --from, or the newest one that isn't running now.
function resolveFrom(from, versions, current) {
  if (from && looksLikePath(from)) return fromPath(from.replace(/^~(?=$|[\\/])/, os.homedir()));
  const others = versions.filter((v) => !sameDir(v.dir, current));
  const installed = versions.length ? versions.map((v) => `${v.version} (${v.manager})`).join(', ') : 'none';
  if (!from) {
    if (!others.length) throw new UsageError('NO_OLD_VERSION', `no other Node version found (installed: ${installed}). Use --from <path> for another manager.`);
    return others[0];
  }
  const want = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(from);
  if (!want) throw new UsageError('BAD_FROM', `--from ${from} is not a version (24, 24.1, 24.1.0) or a path`);
  const parts = want
    .slice(1)
    .filter((p) => p !== undefined)
    .map(Number);
  const match = others.find((v) => parts.every((n, i) => v.parsed[i] === n));
  if (!match) throw new UsageError('NOT_FOUND', `no installed Node ${from} other than this one (installed: ${installed})`);
  return match;
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
    info.link = locked.resolved ?? readlinkSync(full);
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

// ---------------------------------------------------------------- list

function statusOf(pkg, here) {
  if (pkg.status) return pkg.status;
  if (BUNDLED.has(pkg.name)) return 'skipped';
  return here ? 'present' : 'install';
}

function compare(oldPkgs, currentPkgs) {
  const current = new Map(currentPkgs.map((p) => [p.name, p]));
  return oldPkgs.map((p) => {
    const here = current.get(p.name);
    const out = { ...p, status: statusOf(p, here) };
    if (here && out.status !== 'linked' && out.status !== 'broken') out.currentVersion = here.version;
    return out;
  });
}

function summarize(packages) {
  const summary = { install: 0, present: 0, skipped: 0, linked: 0, broken: 0 };
  for (const p of packages) summary[p.status]++;
  return summary;
}

function warningsFor(packages) {
  const warnings = [];
  for (const p of packages) {
    if (p.status === 'linked') warnings.push(`${p.name} is an npm link to ${p.link}: not reinstalled. Run npm link again in that folder.`);
    if (p.status === 'broken') warnings.push(`${p.name} has no readable package.json: not reinstalled.`);
    if (p.status === 'install' && p.source !== 'registry') warnings.push(`${p.name} was installed from ${p.source} (${p.resolved}), not the registry.`);
  }
  return warnings;
}

const LABELS = { install: 'to install', present: 'installed', skipped: 'skipped', linked: 'linked', broken: 'broken' };

function describe(p) {
  const v = p.version ? ` ${p.version}` : '';
  if (p.status === 'present') return `${p.name}${v} (here: ${p.currentVersion})`;
  if (p.status === 'skipped') return `${p.name}${v} (comes with Node)`;
  if (p.status === 'linked') return `${p.name} -> ${p.link} (npm link)`;
  if (p.status === 'install' && p.source !== 'registry') return `${p.name}${v} (from ${p.source}: ${p.resolved})`;
  return `${p.name}${v}`;
}

function printList(r) {
  const from = `Node ${r.from.version ?? '?'}${r.from.manager ? ` (${r.from.manager})` : ''}`;
  console.log(`From ${from}: ${r.from.dir}`);
  console.log(`To   Node ${r.to.version}: ${r.to.dir}\n`);
  if (!r.packages.length) console.log('  no global packages');
  for (const p of r.packages) console.log(`  ${LABELS[p.status].padEnd(11)} ${describe(p)}`);
  const s = r.summary;
  console.log(`\n${s.install} to install, ${s.present} already here, ${s.skipped + s.linked + s.broken} skipped.`);
  for (const w of r.warnings) console.error(`WARNING: ${w}`);
}

function list(opts, env = process.env) {
  const current = currentGlobalDir(env);
  const from = resolveFrom(opts.from, findVersions(env), current);
  const packages = compare(readGlobals(from.dir), readGlobals(current));
  return {
    schemaVersion: SCHEMA_VERSION,
    command: 'list',
    from: { version: from.version, manager: from.manager, dir: from.dir },
    to: { version: process.versions.node, dir: current },
    packages,
    summary: summarize(packages),
    warnings: warningsFor(packages),
  };
}

// ---------------------------------------------------------------- cli

const OPTIONS = {
  from: { type: 'string' },
  list: { type: 'boolean' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
};

function parse(args) {
  try {
    return parseArgs({ args, options: OPTIONS, strict: true, allowPositionals: false }).values;
  } catch (e) {
    const opt = /'([^']+)'/.exec(e.message)?.[1] ?? args[0];
    if (e.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') throw new UsageError('UNKNOWN_OPTION', `unknown option ${opt} (see reglobal --help)`);
    if (e.code === 'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL') throw new UsageError('UNKNOWN_COMMAND', `unknown command ${opt} (see reglobal --help)`);
    throw new UsageError('BAD_OPTION', `${e.message.split('\n')[0]} (see reglobal --help)`);
  }
}

function fail(err, json) {
  const code = err instanceof UsageError ? err.code : 'ERROR';
  if (json) console.log(JSON.stringify({ schemaVersion: SCHEMA_VERSION, error: { code, message: err.message } }, null, 2));
  else console.error(`reglobal: ${err.message}`);
  return 1;
}

export function main(argv) {
  const args = argv.slice(2);
  const json = args.includes('--json');
  try {
    const opts = parse(args);
    if (opts.version && !opts.help) {
      console.log(VERSION);
      return 0;
    }
    if (opts.list) {
      const result = list(opts);
      if (json) console.log(JSON.stringify(result, null, 2));
      else printList(result);
      return 0;
    }
    if (!opts.help && (opts.from || json)) throw new UsageError('NOT_BUILT', 'installing is not built yet: use --list to see what would be installed');
    console.log(HELP);
    return 0;
  } catch (err) {
    return fail(err, json);
  }
}

process.exitCode = main(process.argv);
