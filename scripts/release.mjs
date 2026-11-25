#!/usr/bin/env node
// Publish reglobal to npm, from main.
//
//   npm run release                  publish the version in package.json
//   npm run release -- --dry-run     run every check and show the package, publish nothing
//
// main only changes through pull requests, so the version is bumped in one
// (`npm version minor --no-git-tag-version`, then a PR), and this script
// publishes what was merged.
//
// Steps: check git is clean, on main and in sync with origin -> smoke tests ->
// check npm doesn't have this version yet -> show the package contents and confirm ->
// tag vX.Y.Z and push the tag -> npm login if needed (you type your credentials /
// one-time code) -> npm publish.

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const step = (s) => console.log(`\n${bold(`▸ ${s}`)}`);

function die(msg) {
  console.error(`\n${red(`✗ ${msg}`)}`);
  process.exit(1);
}

// Run a command. `capture` returns trimmed stdout; otherwise output goes to
// the terminal (needed for npm login / one-time-password prompts).
// On Windows npm is npm.cmd, which only runs through a shell.
function run(cmd, cmdArgs, { capture = false, allowFail = false, env } = {}) {
  const r = spawnSync(cmd, cmdArgs, {
    cwd: ROOT,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    encoding: 'utf8',
    shell: process.platform === 'win32' && cmd === 'npm',
    env: env ?? process.env,
  });
  if (r.status !== 0 && !allowFail) {
    die(`${cmd} ${cmdArgs.join(' ')} failed${capture ? `:\n${(r.stderr || r.stdout || '').trim()}` : ''}`);
  }
  return capture ? (r.stdout || '').trim() : r.status;
}

const git = (...a) => run('git', a, { capture: true });
const version = () => JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const name = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).name;

async function ask(q) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(q)).trim();
  } finally {
    rl.close();
  }
}

// ---------------------------------------------------------------- 1. git

step('Checking git');
// In a dry run these are warnings, so you can check a release before committing.
const gitProblem = (msg) => (dryRun ? console.log(`\x1b[33m! ${msg} (a real release stops here)\x1b[0m`) : die(msg));
const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
if (branch !== 'main') gitProblem(`on branch ${branch}: switch to main first`);
const dirty = Boolean(git('status', '--porcelain'));
if (dirty) gitProblem('there are uncommitted changes: commit or stash them first');
run('git', ['fetch', '--quiet', 'origin'], { capture: true });
const [behind, ahead] = git('rev-list', '--left-right', '--count', 'origin/main...HEAD').split(/\s+/).map(Number);
if (behind) gitProblem(`main is ${behind} commit(s) behind origin/main: git pull first`);
console.log(`${branch}${dirty ? ', uncommitted changes' : ', clean'}${ahead ? `, ${ahead} commit(s) to push` : ', in sync with origin'}`);

// ---------------------------------------------------------------- 2. smoke tests

step('Smoke tests');
const nodeEnv = { ...process.env };
delete nodeEnv.ELECTRON_RUN_AS_NODE;
const reglobal = (...a) => spawnSync(process.execPath, [path.join(ROOT, 'reglobal.js'), ...a], { encoding: 'utf8', env: nodeEnv });

run(process.execPath, ['--check', path.join(ROOT, 'reglobal.js')]);
run(process.execPath, ['--test', path.join(ROOT, 'test', 'reglobal.test.js')]);
const check = (ok, label) => {
  if (!ok) die(`smoke test failed: ${label}`);
  console.log(`${green('✓')} ${label}`);
};

check(reglobal('--version').stdout.trim() === version(), '--version prints the package version');
check(reglobal('--help').stdout.includes('Usage: reglobal'), '--help prints usage');
check(reglobal('--bogus').status === 1, 'an unknown option exits 1');

// The real commands, on a made-up old version in a temp folder. Nothing is
// installed: --dry-run and --list only read, and --offline keeps it off the network.
{
  const tmp = mkdtempSync(path.join(tmpdir(), 'reglobal-release-'));
  try {
    const old = path.join(tmp, 'v22.0.0', 'node_modules', 'left-pad');
    mkdirSync(old, { recursive: true });
    writeFileSync(path.join(old, 'package.json'), JSON.stringify({ name: 'left-pad', version: '1.3.0' }));
    const prefix = path.join(tmp, 'prefix');
    mkdirSync(path.join(prefix, process.platform === 'win32' ? '' : 'lib', 'node_modules'), { recursive: true });
    const env = { ...nodeEnv, npm_config_prefix: prefix, NO_COLOR: '1' };
    const cli = (...a) => spawnSync(process.execPath, [path.join(ROOT, 'reglobal.js'), ...a], { encoding: 'utf8', env });
    const from = path.join(tmp, 'v22.0.0');
    const list = cli(from, '--list', '--json', '--offline');
    check(list.status === 0 && JSON.parse(list.stdout).summary.install === 1, "--list --json finds the old version's package");
    const dry = cli(from, '--dry-run', '--offline');
    check(dry.status === 0 && dry.stdout.includes('Would run: npm install --global left-pad@latest'), '--dry-run shows the npm command');
    check(cli(from, '--offline').status === 1, 'with no terminal and no --yes, nothing is installed (exit 1)');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- 3. version

step('Version');
const published = run('npm', ['view', name, 'versions', '--json'], { capture: true, allowFail: true });
// A list (or a single string) of versions; a not-yet-published package gives
// an {"error": ...} object instead, which means none.
let onNpm = [];
try {
  const v = JSON.parse(published || '[]');
  if (Array.isArray(v) || typeof v === 'string') onNpm = [].concat(v);
} catch {
  /* not published yet */
}
console.log(onNpm.length ? `on npm: ${onNpm.slice(-5).join(', ')}` : `${name} is not on npm yet`);

const v = version();
if (onNpm.includes(v)) {
  const msg = `${v} is already on npm: bump the version in a pull request first (npm version patch|minor|major --no-git-tag-version)`;
  if (dryRun) console.log(`\x1b[33m! ${msg} (a real release stops here)\x1b[0m`);
  else die(msg);
}
console.log(`publishing ${bold(`${name}@${v}`)}`);

// ---------------------------------------------------------------- 4. contents

step('Package contents');
run('npm', ['pack', '--dry-run']);

if (dryRun) {
  console.log(`\n${green('Dry run finished.')} Nothing was published. Run without --dry-run to publish.`);
  process.exit(0);
}

const answer = await ask(`\nPublish ${bold(`${name}@${v}`)} to npm? [y/N] `);
if (!/^y(es)?$/i.test(answer)) {
  console.log('Not published. Nothing was changed.');
  process.exit(3);
}

// ---------------------------------------------------------------- tag

step(`Tag v${v}`);
// The tag may already be there, made with the GitHub release. It must point at
// this commit: publishing anything else under that version would be a lie.
const tagged = git('tag', '--list', `v${v}`);
if (tagged) {
  if (git('rev-list', '-n', '1', `v${v}`) !== git('rev-parse', 'HEAD')) die(`tag v${v} exists but is not on this commit`);
  console.log(`v${v} is already tagged on this commit`);
} else {
  run('git', ['tag', '-a', `v${v}`, '-m', `reglobal ${v}`]);
  run('git', ['push', 'origin', `v${v}`]);
}

// ---------------------------------------------------------------- 5. login + publish

step('npm login');
const who = run('npm', ['whoami'], { capture: true, allowFail: true });
if (who) console.log(`logged in as ${who}`);
else {
  console.log('Not logged in. Log in below (this opens a browser or asks for your details).');
  run('npm', ['login']);
}

step('Publishing');
// npm asks for a one-time password here if your account has 2FA on.
run('npm', ['publish']);

console.log(`\n${green(`✓ Published ${name}@${v}`)}  https://www.npmjs.com/package/${name}`);
console.log(`  Install: npm install -g ${name}`);
