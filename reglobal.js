#!/usr/bin/env node
// reglobal: after switching to a new Node version, reinstall the global npm
// packages you had in an older one. Reads the old version's global
// node_modules folder directly, so the old npm (or Node) never has to run.
// No dependencies on purpose: it must work in a fresh Node with no globals.
//
// Still to write: export and import.

import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { emitKeypressEvents } from 'node:readline';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';

const VERSION = JSON.parse(readFileSync(new URL('./package.json', import.meta.url))).version;
const SCHEMA_VERSION = 1;

const HELP = `Usage: reglobal [--from <version|path>] [--dry-run | --yes | -i] [--skip <names> | --only <names>]
                [--keep-versions] [--offline] [--json]
       reglobal --list [--from <version|path>] [--offline] [--json]

Reinstall the global npm packages from another Node version into this one,
the Node that runs reglobal. Asks before installing.

Options:
  --from <v|path>  the old Node version: 24, 24.1 or 24.1.0 picks the newest
                   installed match; a path is that version's install folder
                   or its global node_modules. Default: the newest installed
                   version other than this one.
  --dry-run        show what would be installed, install nothing
  -y, --yes        install without asking (needed with --json or no terminal)
  --keep-versions  install the same versions as before, not the latest
  --skip <names>   leave these packages out (comma separated, or repeat it)
  --only <names>   install only these packages
  -i, --interactive  tick and untick packages in a checklist before installing
  --offline        don't look up the latest versions on the registry
  --list           show the old version's globals next to this one's (read-only)
  --json           print JSON on stdout

At the question, answer e to type the names of packages to leave out.
  -h, --help       show this help
  -v, --version    print the version

Finds versions installed by fnm, nvm, nvm-windows, mise, asdf and n.

Exit codes: 0 done, 1 error, 2 nothing to install, 3 cancelled.

Not built yet: export, import.`;

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
  if (here) return 'present';
  // A file: path was relative to the old folder, so it can't be installed again from here.
  return pkg.source === 'file' ? 'manual' : 'install';
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

// "typescript 5.4.0 -> 5.9.3 (major)": the old version, and the one @latest gets.
function versionLabel(p) {
  const v = p.version ? ` ${p.version}` : '';
  const arrow = p.latest && p.latest !== p.version ? ` -> ${p.latest}${p.majorUpdate ? ' (major)' : ''}` : '';
  return `${p.name}${v}${arrow}`;
}

function describe(p) {
  if (p.status === 'present') return `${versionLabel(p)} (here: ${p.currentVersion})`;
  if (p.status === 'skipped') return `${versionLabel(p)} (comes with Node)`;
  if (p.status === 'linked') return `${p.name} -> ${p.link} (npm link)`;
  if (p.source && p.source !== 'registry') return `${versionLabel(p)} (from ${p.source}: ${p.resolved})`;
  return versionLabel(p);
}

function printList(r) {
  const from = `Node ${r.from.version ?? '?'}${r.from.manager ? ` (${r.from.manager})` : ''}`;
  console.log(`From ${from}: ${r.from.dir}`);
  console.log(`To   Node ${r.to.version}: ${r.to.dir}\n`);
  if (!r.packages.length) console.log('  no global packages');
  for (const p of r.packages) console.log(`  ${LABELS[p.status].padEnd(11)} ${describe(p)}`);
  const s = r.summary;
  const leftOut = s.excluded ? `${s.excluded} left out, ` : '';
  console.log(`\n${s.install} to install, ${leftOut}${s.present} already here, ${s.skipped + s.linked + s.manual + s.broken} skipped.`);
  for (const w of r.warnings) console.error(`WARNING: ${w}`);
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

async function list(opts, env = process.env) {
  const current = currentGlobalDir(env);
  const from = resolveFrom(opts.from, findVersions(env), current);
  const packages = compare(readGlobals(from.dir), readGlobals(current));
  const r = {
    schemaVersion: SCHEMA_VERSION,
    command: 'list',
    from: { version: from.version, manager: from.manager, dir: from.dir },
    to: { version: process.versions.node, dir: current },
    packages,
    summary: summarize(packages),
    warnings: warningsFor(packages),
  };
  if (!opts.offline && !opts['keep-versions']) await addLatest(r, env);
  return r;
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

// The npm of the Node running now: the one that came with it, or the first on
// PATH. It is run as `node npm-cli.js`, never through a shell, so nothing in a
// package name or URL is read by cmd.exe or sh. REGLOBAL_NPM_CLI overrides it.
function findNpmCli(env) {
  if (env.REGLOBAL_NPM_CLI) {
    if (!existsSync(env.REGLOBAL_NPM_CLI)) throw new UsageError('NO_NPM', `REGLOBAL_NPM_CLI is set to ${env.REGLOBAL_NPM_CLI}, which does not exist`);
    return env.REGLOBAL_NPM_CLI;
  }
  const pathDirs = (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  const cli = firstExisting([path.dirname(process.execPath), ...pathDirs].map(npmCliIn));
  if (!cli) throw new UsageError('NO_NPM', 'npm was not found next to this Node or on PATH');
  return cli;
}

function runNpm(cli, specs, env) {
  // npm's own output goes to stderr, so stdout stays clean for --json.
  const r = spawnSync(process.execPath, [cli, 'install', '--global', '--', ...specs], { stdio: ['ignore', 2, 2], env });
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
    const why = pkg ? `its status is ${pkg.status}` : `Node ${r.from.version ?? '(old)'} has no global package by that name`;
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
      const answer = (await p.ask(`Install ${r.plan.length} package(s) into Node ${r.to.version}? [y/N, e to leave some out] `)) ?? '';
      if (/^y(es)?$/i.test(answer)) return true;
      if (!/^e(dit)?$/i.test(answer)) return false;
      const names = splitNames([(await p.ask('Names to leave out (space or comma separated): ')) ?? '']);
      try {
        leaveOut(r, names);
      } catch (err) {
        console.error(`reglobal: ${err.message}`);
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
  const on = items.map(() => true);
  let cursor = 0;
  let drawn = 0;
  const draw = () => {
    if (drawn) out.write(`\x1b[${drawn}A\x1b[0J`);
    const lines = [
      'Choose what to install: up/down to move, space to tick or untick, a for all or none, enter to go on, q to cancel.',
      ...items.map((p, i) => `${i === cursor ? '>' : ' '} [${on[i] ? 'x' : ' '}] ${versionLabel(p)}`),
    ];
    out.write(`${lines.join('\n')}\n`);
    drawn = lines.length;
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
    stdin.on('keypress', onKey);
    stdin.on('end', onEnd);
    stdin.resume();
    draw();
  });
}

// ---------------------------------------------------------------- install flow

function printRun(r) {
  console.log(`\n${r.dryRun ? 'Would run' : 'Runs'}: npm install --global ${r.plan.map((p) => p.spec).join(' ')}`);
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
  console.log(message);
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
  const r = { ...(await list(opts, env)), command: 'install', dryRun: Boolean(opts['dry-run']), keepVersions: Boolean(opts['keep-versions']) };
  makePlan(r);
  applyFilters(r, opts);
  const report = (code) => {
    if (json) console.log(JSON.stringify(r, null, 2));
    return code;
  };
  if (!json) printList(r);
  if (!r.plan.length) {
    if (!json) console.log('\nNothing to install.');
    return report(2);
  }
  if (!json && !opts.interactive) printRun(r);
  const stop = await choose(r, opts, json, env);
  if (stop !== null) return stop;
  if (r.dryRun) return report(0);
  r.npmExitCode = runNpm(
    findNpmCli(env),
    r.plan.map((p) => p.spec),
    env,
  );
  const after = new Set(readGlobals(r.to.dir).map((p) => p.name));
  r.installed = r.plan.filter((p) => after.has(p.name)).map((p) => p.name);
  r.failed = r.plan.filter((p) => !after.has(p.name)).map((p) => p.name);
  if (r.npmExitCode === 0 && !r.failed.length) {
    if (!json) console.log(`Installed ${r.installed.length} package(s) into Node ${r.to.version}.`);
    return report(0);
  }
  const message = `npm exited with ${r.npmExitCode}; not installed: ${r.failed.join(', ') || 'none'}`;
  r.error = { code: 'INSTALL_FAILED', message };
  if (!json) console.error(`reglobal: ${message}`);
  return report(1);
}

// ---------------------------------------------------------------- cli

const INSTALL_ONLY = ['dry-run', 'yes', 'keep-versions', 'skip', 'only', 'interactive'];

const OPTIONS = {
  from: { type: 'string' },
  list: { type: 'boolean' },
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
    if (!opts.list) return await install(opts, json);
    const extra = INSTALL_ONLY.find((o) => opts[o]);
    if (extra) throw new UsageError('BAD_OPTION', `--${extra} does not go with --list, which installs nothing`);
    const result = await list(opts);
    if (json) console.log(JSON.stringify(result, null, 2));
    else printList(result);
    return 0;
  } catch (err) {
    return fail(err, json);
  }
}

process.exitCode = await main(process.argv);
