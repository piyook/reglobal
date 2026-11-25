// Tests for reglobal, run as a real CLI. No dependencies: node:test only.
// Run with `npm test`. Tests that install packages must use a throwaway npm
// prefix in the OS temp folder, never the real global folder.
//
// Each test builds fake version-manager folders in a temp directory and points
// HOME and the managers' variables at it, so the real machine is never read.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REGLOBAL = fileURLToPath(new URL('../reglobal.js', import.meta.url));
const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version;
const WIN = process.platform === 'win32';
const LIB = WIN ? '' : 'lib';

const baseEnv = {};
for (const [k, v] of Object.entries(process.env)) {
  // Leave out anything that would point reglobal at the real machine.
  if (/^(npm_config_|ELECTRON_RUN_AS_NODE$|FNM_|NVM_|MISE_|ASDF_|N_PREFIX$|XDG_DATA_HOME$|APPDATA$|LOCALAPPDATA$|HOME$|USERPROFILE$)/i.test(k)) continue;
  baseEnv[k] = v;
}
baseEnv.NO_COLOR = '1';

const temps = [];

// A fake npm registry in its own process (spawnSync blocks this one, so a
// server here could never answer). It knows a few packages' latest versions,
// answers 404 for the rest, and logs every name it is asked for.
const REGISTRY = {
  typescript: '5.9.3',
  '@scope/tool': '3.0.0',
  cowsay: '1.8.0',
  'zero-dot': '0.7.0',
};
const REGISTRY_SERVER = `
import { appendFileSync } from 'node:fs';
import http from 'node:http';
const versions = JSON.parse(process.env.FAKE_REGISTRY);
http.createServer((req, res) => {
  const name = decodeURIComponent(req.url).replace(/^\\//, '').replace(/\\/latest$/, '');
  appendFileSync(process.env.FAKE_REGISTRY_LOG, name + '\\n');
  if (!versions[name]) { res.writeHead(404).end('{}'); return; }
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ name, version: versions[name] }));
}).listen(0, '127.0.0.1', function () { console.log(this.address().port); });
`;
let registry;
let registryLog;

before(async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'reglobal-registry-'));
  temps.push(dir);
  writeFileSync(path.join(dir, 'server.mjs'), REGISTRY_SERVER);
  registryLog = path.join(dir, 'requests.log');
  writeFileSync(registryLog, '');
  registry = spawn(process.execPath, [path.join(dir, 'server.mjs')], {
    env: { ...baseEnv, FAKE_REGISTRY: JSON.stringify(REGISTRY), FAKE_REGISTRY_LOG: registryLog },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const [port] = await once(registry.stdout, 'data');
  baseEnv.npm_config_registry = `http://127.0.0.1:${String(port).trim()}/`;
});

after(() => {
  registry?.kill();
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});

const registryAsked = () => readFileSync(registryLog, 'utf8').split('\n').filter(Boolean);

// A fresh fake machine: an empty home, and an npm prefix for "this" Node.
function machine() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'reglobal-test-'));
  temps.push(root);
  const home = path.join(root, 'home');
  const prefix = path.join(root, 'current');
  const env = { ...baseEnv, HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming'), N_PREFIX: path.join(root, 'n') };
  env.NPM_CONFIG_PREFIX = prefix;
  mkdirSync(home, { recursive: true });
  const current = path.join(prefix, LIB, 'node_modules');
  mkdirSync(current, { recursive: true });
  return { root, home, env, current };
}

function pkg(modules, name, version, extra = {}) {
  const dir = path.join(modules, ...name.split('/'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version, ...extra }));
  return dir;
}

function fnmVersion(m, v) {
  const dir = path.join(m.root, 'fnm', 'node-versions', `v${v}`, 'installation', LIB, 'node_modules');
  mkdirSync(dir, { recursive: true });
  m.env.FNM_DIR = path.join(m.root, 'fnm');
  return dir;
}

// `input` is typed into reglobal's stdin (with REGLOBAL_ASSUME_TTY to answer prompts).
function reglobal(args, env = baseEnv, input = '') {
  const r = spawnSync(process.execPath, [REGLOBAL, ...args], { encoding: 'utf8', env, input });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function listJson(m, ...args) {
  const r = reglobal(['--list', '--json', ...args], m.env);
  assert.equal(r.code, 0, r.stderr || r.stdout);
  return JSON.parse(r.stdout);
}

function listJsonInstall(m, args) {
  const r = reglobal([...args, '--json'], m.env);
  return { code: r.code, json: JSON.parse(r.stdout), stderr: r.stderr };
}

const byName = (result) => Object.fromEntries(result.packages.map((p) => [p.name, p]));

// A stand-in for npm-cli.js: it logs its arguments, prints to stdout (which
// reglobal must send to stderr), and "installs" each spec by making its folder
// in the npm prefix. FAKE_NPM_SKIP leaves some out; FAKE_NPM_EXIT sets the exit code.
const FAKE_NPM = `
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_NPM_LOG, JSON.stringify(args) + '\\n');
console.log('fake npm output');
const modules = path.join(process.env.NPM_CONFIG_PREFIX, process.platform === 'win32' ? '' : 'lib', 'node_modules');
const skip = (process.env.FAKE_NPM_SKIP || '').split(',');
for (const spec of args.slice(args.indexOf('--') + 1)) {
  const name = spec.includes('://') ? spec.match(/\\/([^/#]+?)(?:\\.git)?(?:#.*)?$/)[1] : spec.replace(/(.)@[^@]*$/, '$1');
  if (skip.includes(name)) continue;
  const dir = path.join(modules, ...name.split('/'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '9.9.9' }));
}
process.exit(Number(process.env.FAKE_NPM_EXIT || 0));
`;

function withFakeNpm(m) {
  const cli = path.join(m.root, 'fake-npm.mjs');
  writeFileSync(cli, FAKE_NPM);
  m.env.REGLOBAL_NPM_CLI = cli;
  m.env.FAKE_NPM_LOG = path.join(m.root, 'npm-calls.log');
  return () => {
    try {
      return readFileSync(m.env.FAKE_NPM_LOG, 'utf8').trim().split('\n').map(JSON.parse);
    } catch {
      return [];
    }
  };
}

describe('cli basics', () => {
  test('--version prints the package version', () => {
    const r = reglobal(['--version']);
    assert.equal(r.code, 0);
    assert.equal(r.stdout.trim(), VERSION);
  });

  test('--help prints usage', () => {
    const r = reglobal(['--help']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /^Usage: reglobal/);
  });

  test('an unknown option exits 1', () => {
    const r = reglobal(['--bogus']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /unknown option --bogus/);
  });

  test('a stray word exits 1', () => {
    const r = reglobal(['frobnicate']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /unknown command frobnicate/);
  });

  test('--from without a value exits 1', () => {
    const r = reglobal(['--list', '--from']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /--from/);
  });

  test('--list does not take the install options', () => {
    const r = reglobal(['--list', '--yes']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /--yes does not go with --list/);
  });

  test('errors are JSON with --json', () => {
    const r = reglobal(['--bogus', '--json']);
    assert.equal(r.code, 1);
    const out = JSON.parse(r.stdout);
    assert.equal(out.schemaVersion, 1);
    assert.equal(out.error.code, 'UNKNOWN_OPTION');
  });
});

describe('finding the old version', () => {
  test('picks the newest version other than this one by default', () => {
    const m = machine();
    fnmVersion(m, '22.1.0');
    fnmVersion(m, '24.3.0');
    const r = listJson(m);
    assert.equal(r.from.version, '24.3.0');
    assert.equal(r.from.manager, 'fnm');
  });

  test('--from 22 picks the newest 22.x', () => {
    const m = machine();
    fnmVersion(m, '22.1.0');
    fnmVersion(m, '22.10.2');
    fnmVersion(m, '24.3.0');
    assert.equal(listJson(m, '--from', '22').from.version, '22.10.2');
    assert.equal(listJson(m, '--from', 'v22.1').from.version, '22.1.0');
    assert.equal(listJson(m, '--from', '22.1.0').from.version, '22.1.0');
  });

  test('leaves out the version running now', () => {
    const m = machine();
    const only = fnmVersion(m, '24.3.0');
    m.env.NPM_CONFIG_PREFIX = path.dirname(LIB ? path.dirname(only) : only);
    const r = reglobal(['--list'], m.env);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /no other Node version found \(installed: 24\.3\.0 \(fnm\)\)/);
  });

  test('a version that is not installed exits 1 and lists what is', () => {
    const m = machine();
    fnmVersion(m, '24.3.0');
    const r = reglobal(['--list', '--json', '--from', '20'], m.env);
    assert.equal(r.code, 1);
    const out = JSON.parse(r.stdout);
    assert.equal(out.error.code, 'NOT_FOUND');
    assert.match(out.error.message, /installed: 24\.3\.0 \(fnm\)/);
  });

  test('--from that is neither a version nor a path exits 1', () => {
    const m = machine();
    const r = reglobal(['--list', '--from', 'latest'], m.env);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /not a version/);
  });

  test('no versions at all exits 1', () => {
    const r = reglobal(['--list'], machine().env);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /installed: none/);
  });

  test('finds nvm, nvm-windows, mise, asdf and n', () => {
    const m = machine();
    const layouts = {
      nvm: ['NVM_DIR', 'nvm', ['versions', 'node', 'v18.0.0'], '18.0.0'],
      'nvm-windows': ['NVM_HOME', 'nvmw', ['v18.1.0'], '18.1.0'],
      mise: ['MISE_DATA_DIR', 'mise', ['installs', 'node', '18.2.0'], '18.2.0'],
      asdf: ['ASDF_DATA_DIR', 'asdf', ['installs', 'nodejs', '18.3.0'], '18.3.0'],
    };
    for (const [, [envVar, folder, parts]] of Object.entries(layouts)) {
      m.env[envVar] = path.join(m.root, folder);
      mkdirSync(path.join(m.root, folder, ...parts, LIB, 'node_modules'), { recursive: true });
    }
    mkdirSync(path.join(m.env.N_PREFIX, 'n', 'versions', 'node', '18.4.0', LIB, 'node_modules'), { recursive: true });
    layouts.n = [null, null, null, '18.4.0'];
    for (const [manager, [, , , version]] of Object.entries(layouts)) {
      const r = listJson(m, '--from', version);
      assert.equal(r.from.manager, manager);
      assert.equal(r.from.version, version);
    }
  });

  test('finds fnm and nvm in their default folders', () => {
    const m = machine();
    const fnmDefault = WIN
      ? path.join(m.env.APPDATA, 'fnm')
      : process.platform === 'darwin'
        ? path.join(m.home, 'Library', 'Application Support', 'fnm')
        : path.join(m.home, '.local', 'share', 'fnm');
    mkdirSync(path.join(fnmDefault, 'node-versions', 'v20.0.0', 'installation', LIB, 'node_modules'), { recursive: true });
    mkdirSync(path.join(m.home, '.nvm', 'versions', 'node', 'v20.1.0', LIB, 'node_modules'), { recursive: true });
    assert.equal(listJson(m, '--from', '20.0.0').from.manager, 'fnm');
    assert.equal(listJson(m, '--from', '20.1.0').from.manager, 'nvm');
  });

  test('ignores folders that are not versions, or have no node_modules', () => {
    const m = machine();
    fnmVersion(m, '24.3.0');
    mkdirSync(path.join(m.env.FNM_DIR, 'node-versions', '.downloads'), { recursive: true });
    mkdirSync(path.join(m.env.FNM_DIR, 'node-versions', 'v25.0.0'), { recursive: true });
    assert.equal(listJson(m).from.version, '24.3.0');
  });

  test('--from <path> takes an install folder or a node_modules folder', () => {
    const m = machine();
    const install = path.join(m.root, 'custom', 'node-v21.0.0');
    const modules = path.join(install, LIB, 'node_modules');
    pkg(modules, 'cowsay', '1.6.0');
    const viaInstall = listJson(m, '--from', install);
    assert.equal(viaInstall.from.dir, modules);
    assert.equal(viaInstall.from.manager, null);
    assert.equal(listJson(m, '--from', modules).packages[0].name, 'cowsay');
  });

  test('--from <path> reads the version from a parent folder', () => {
    const m = machine();
    const modules = fnmVersion(m, '23.4.5');
    assert.equal(listJson(m, '--from', modules).from.version, '23.4.5');
    const plain = path.join(m.root, 'plain', 'node_modules');
    mkdirSync(plain, { recursive: true });
    assert.equal(listJson(m, '--from', plain).from.version, null);
  });

  test('--from <path> with no node_modules exits 1', () => {
    const m = machine();
    const r = reglobal(['--list', '--from', path.join(m.root, 'nothing')], m.env);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /no global node_modules folder/);
  });
});

describe('--list', () => {
  test('sorts old globals into install, present and skipped', () => {
    const m = machine();
    const old = fnmVersion(m, '24.3.0');
    pkg(old, 'typescript', '5.4.0');
    pkg(old, 'cowsay', '1.6.0');
    pkg(old, '@scope/tool', '2.0.0');
    pkg(old, 'npm', '10.0.0');
    pkg(old, 'corepack', '0.30.0');
    pkg(m.current, 'cowsay', '1.7.0');
    const r = listJson(m);
    assert.equal(r.schemaVersion, 1);
    assert.equal(r.command, 'list');
    assert.equal(r.to.version, process.versions.node);
    assert.equal(r.to.dir, m.current);
    const p = byName(r);
    assert.equal(p.typescript.status, 'install');
    assert.equal(p.typescript.source, 'registry');
    assert.equal(p['@scope/tool'].status, 'install');
    assert.equal(p.cowsay.status, 'present');
    assert.equal(p.cowsay.currentVersion, '1.7.0');
    assert.equal(p.npm.status, 'skipped');
    assert.equal(p.corepack.status, 'skipped');
    assert.deepEqual(r.summary, { install: 2, excluded: 0, present: 1, skipped: 2, linked: 0, manual: 0, broken: 0 });
    assert.deepEqual(r.warnings, []);
  });

  test('prints a readable list without --json', () => {
    const m = machine();
    const old = fnmVersion(m, '24.3.0');
    pkg(old, 'typescript', '5.4.0');
    pkg(old, 'npm', '10.0.0');
    pkg(old, 'cowsay', '1.6.0');
    pkg(m.current, 'cowsay', '1.7.0');
    const r = reglobal(['--list'], m.env);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /^From Node 24\.3\.0 \(fnm\) {2}.+node_modules\nTo {3}Node /);
    assert.match(r.stdout, /to install +typescript +5\.4\.0/);
    assert.match(r.stdout, /installed +cowsay +1\.6\.0 +\(here: 1\.7\.0\)/);
    assert.match(r.stdout, /skipped +npm +10\.0\.0 +\(comes with Node\)/);
    assert.match(r.stdout, /1 to install, 1 already here, 1 skipped\n/);
    assert.equal(r.stderr, '');
  });

  test('says so when the old version has no globals', () => {
    const m = machine();
    fnmVersion(m, '24.3.0');
    const r = reglobal(['--list'], m.env);
    assert.match(r.stdout, /no global packages/);
  });

  test('changes nothing', () => {
    const m = machine();
    const old = fnmVersion(m, '24.3.0');
    pkg(old, 'typescript', '5.4.0');
    const snapshot = () => [old, m.current].map((d) => readdirSync(d, { recursive: true }).sort());
    const before = snapshot();
    listJson(m);
    assert.deepEqual(snapshot(), before);
    assert.equal(listJson(m).summary.install, 1);
  });

  test('npm link symlinks are reported, not installed', () => {
    const m = machine();
    const old = fnmVersion(m, '24.3.0');
    const target = pkg(path.join(m.root, 'src'), 'my-tool', '0.1.0');
    symlinkSync(target, path.join(old, 'my-tool'), 'junction');
    const r = listJson(m);
    assert.equal(r.packages[0].status, 'linked');
    assert.equal(r.summary.linked, 1);
    assert.match(r.warnings[0], /my-tool is an npm link/);
    const text = reglobal(['--list'], m.env);
    assert.match(text.stdout, /linked +my-tool +0\.1\.0 +\(npm link to .+\)/);
    assert.match(text.stderr, /^WARNING: my-tool is an npm link/);
  });

  test('a package with no package.json is reported as broken', () => {
    const m = machine();
    const old = fnmVersion(m, '24.3.0');
    mkdirSync(path.join(old, 'half-gone'));
    const r = listJson(m);
    assert.equal(r.packages[0].status, 'broken');
    assert.match(r.warnings[0], /half-gone has no readable package.json/);
  });

  test('git and tarball installs are flagged from _resolved', () => {
    const m = machine();
    const old = fnmVersion(m, '24.3.0');
    pkg(old, 'from-git', '1.0.0', { _resolved: 'git+ssh://git@github.com/someone/from-git.git#abc123' });
    pkg(old, 'from-file', '1.0.0', { _resolved: 'file:../from-file-1.0.0.tgz' });
    pkg(old, 'from-url', '1.0.0', { _resolved: 'https://example.com/from-url.tgz' });
    pkg(old, 'from-registry', '1.0.0', { _resolved: 'https://registry.npmjs.org/from-registry/-/from-registry-1.0.0.tgz' });
    const p = byName(listJson(m));
    assert.equal(p['from-git'].source, 'git');
    assert.equal(p['from-git'].resolved, 'git+ssh://git@github.com/someone/from-git.git#abc123');
    assert.equal(p['from-file'].source, 'file');
    assert.equal(p['from-file'].status, 'manual');
    assert.equal(p['from-url'].source, 'url');
    assert.equal(p['from-registry'].source, 'registry');
    assert.equal(p['from-registry'].resolved, undefined);
    const text = reglobal(['--list'], m.env);
    assert.match(text.stdout, /from-git +1\.0\.0 +\(from git: git\+ssh/);
    assert.match(text.stderr, /from-git is reinstalled from git/);
    assert.match(text.stderr, /from-file was installed from a file .+ Install it again by hand/);
  });

  test("npm's hidden lockfile gives the source and links", () => {
    const m = machine();
    const old = fnmVersion(m, '24.3.0');
    pkg(old, 'from-git', '1.0.0');
    pkg(old, 'linked', '1.0.0');
    writeFileSync(
      path.join(old, '.package-lock.json'),
      JSON.stringify({
        packages: {
          'node_modules/from-git': { version: '1.0.0', resolved: 'git+https://github.com/someone/from-git.git#abc' },
          'node_modules/linked': { resolved: '../../src/linked', link: true },
        },
      }),
    );
    const p = byName(listJson(m));
    assert.equal(p['from-git'].source, 'git');
    assert.equal(p.linked.status, 'linked');
    assert.equal(p.linked.link, '../../src/linked');
  });
});

describe('install', () => {
  // An old version with two registry packages, npm, and one already here.
  function setup() {
    const m = machine();
    const old = fnmVersion(m, '24.3.0');
    pkg(old, 'typescript', '5.4.0');
    pkg(old, '@scope/tool', '2.0.0');
    pkg(old, 'npm', '10.0.0');
    pkg(old, 'cowsay', '1.6.0');
    pkg(m.current, 'cowsay', '1.7.0');
    const calls = withFakeNpm(m);
    return { m, old, calls };
  }

  test('--yes installs the missing packages at @latest in one npm call', () => {
    const { m, calls } = setup();
    const r = reglobal(['--yes'], m.env);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(calls(), [['install', '--global', '--', '@scope/tool@latest', 'typescript@latest']]);
    assert.match(r.stdout, /Runs: npm install --global @scope\/tool@latest typescript@latest/);
    assert.match(r.stdout, /Installed 2 packages into Node /);
    assert.doesNotMatch(r.stdout, /fake npm output/);
    assert.match(r.stderr, /fake npm output/);
  });

  test('--keep-versions installs the same versions', () => {
    const { m, calls } = setup();
    assert.equal(reglobal(['--yes', '--keep-versions'], m.env).code, 0);
    assert.deepEqual(calls()[0].slice(3), ['@scope/tool@2.0.0', 'typescript@5.4.0']);
  });

  test('--dry-run shows the plan and runs nothing', () => {
    const { m, calls } = setup();
    const r = reglobal(['--dry-run', '--from', '24'], m.env);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Would run: npm install --global @scope\/tool@latest typescript@latest/);
    assert.deepEqual(calls(), []);
  });

  test('--dry-run --json gives the plan', () => {
    const { m, calls } = setup();
    const out = listJsonInstall(m, ['--dry-run', '--keep-versions']);
    assert.equal(out.code, 0);
    assert.equal(out.json.command, 'install');
    assert.equal(out.json.dryRun, true);
    assert.equal(out.json.keepVersions, true);
    assert.deepEqual(out.json.plan, [
      { name: '@scope/tool', version: '2.0.0', source: 'registry', spec: '@scope/tool@2.0.0' },
      { name: 'typescript', version: '5.4.0', source: 'registry', spec: 'typescript@5.4.0' },
    ]);
    assert.equal(out.json.installed, undefined);
    assert.deepEqual(calls(), []);
  });

  test('--yes --json reports what was installed', () => {
    const { m } = setup();
    const out = listJsonInstall(m, ['--yes']);
    assert.equal(out.code, 0, out.stderr);
    assert.equal(out.json.npmExitCode, 0);
    assert.deepEqual(out.json.installed, ['@scope/tool', 'typescript']);
    assert.deepEqual(out.json.failed, []);
  });

  test('without --yes and with no terminal, installs nothing and exits 1', () => {
    const { m, calls } = setup();
    const r = reglobal([], m.env);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /to install +typescript/);
    assert.match(r.stderr, /nothing installed: pass --yes/);
    const json = listJsonInstall(m, []);
    assert.equal(json.code, 1);
    assert.equal(json.json.error.code, 'NEEDS_YES');
    assert.deepEqual(calls(), []);
  });

  test('nothing to install exits 2', () => {
    const m = machine();
    const old = fnmVersion(m, '24.3.0');
    pkg(old, 'npm', '10.0.0');
    const calls = withFakeNpm(m);
    const r = reglobal(['--yes'], m.env);
    assert.equal(r.code, 2);
    assert.match(r.stdout, /Nothing to install\./);
    assert.equal(listJsonInstall(m, ['--yes']).code, 2);
    assert.deepEqual(calls(), []);
  });

  test('an npm failure exits 1 and names what is missing', () => {
    const { m } = setup();
    m.env.FAKE_NPM_EXIT = '1';
    m.env.FAKE_NPM_SKIP = 'typescript,@scope/tool';
    const r = reglobal(['--yes'], m.env);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /npm exited with 1; not installed: @scope\/tool, typescript/);
    const out = listJsonInstall(m, ['--yes']);
    assert.equal(out.code, 1);
    assert.equal(out.json.error.code, 'INSTALL_FAILED');
    assert.deepEqual(out.json.failed, ['@scope/tool', 'typescript']);
  });

  test('a package npm did not install is a failure even when npm exits 0', () => {
    const { m } = setup();
    m.env.FAKE_NPM_SKIP = 'typescript';
    const out = listJsonInstall(m, ['--yes']);
    assert.equal(out.code, 1);
    assert.deepEqual(out.json.installed, ['@scope/tool']);
    assert.deepEqual(out.json.failed, ['typescript']);
    assert.match(out.json.error.message, /npm exited with 0; not installed: typescript/);
  });

  test('git installs come back from git, at the latest commit unless --keep-versions', () => {
    const m = machine();
    const old = fnmVersion(m, '24.3.0');
    const url = 'git+ssh://git@github.com/someone/from-git.git';
    pkg(old, 'from-git', '1.0.0', { _resolved: `${url}#abc123` });
    pkg(old, 'from-file', '1.0.0', { _resolved: 'file:../from-file-1.0.0.tgz' });
    const calls = withFakeNpm(m);
    const r = reglobal(['--yes'], m.env);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /manual +from-file +1\.0\.0 +\(from file: file:\.\.\/from-file-1\.0\.0\.tgz\)/);
    assert.deepEqual(calls()[0].slice(3), [url]);
    rmSync(path.join(m.current, 'from-git'), { recursive: true });
    assert.equal(reglobal(['--yes', '--keep-versions'], m.env).code, 0);
    assert.deepEqual(calls()[1].slice(3), [`${url}#abc123`]);
  });

  test('a tarball URL is installed from that URL', () => {
    const m = machine();
    const old = fnmVersion(m, '24.3.0');
    pkg(old, 'from-url', '1.0.0', { _resolved: 'https://example.com/pkgs/from-url.tgz' });
    const calls = withFakeNpm(m);
    reglobal(['--dry-run'], m.env);
    const out = listJsonInstall(m, ['--dry-run']);
    assert.equal(out.json.plan[0].spec, 'https://example.com/pkgs/from-url.tgz');
    assert.deepEqual(calls(), []);
  });

  test('a REGLOBAL_NPM_CLI that does not exist exits 1', () => {
    const { m } = setup();
    m.env.REGLOBAL_NPM_CLI = path.join(m.root, 'no-such-npm.js');
    const out = listJsonInstall(m, ['--yes']);
    assert.equal(out.code, 1);
    assert.equal(out.json.error.code, 'NO_NPM');
  });
});

describe('latest versions', () => {
  function setup() {
    const m = machine();
    const old = fnmVersion(m, '24.3.0');
    pkg(old, 'typescript', '5.4.0');
    pkg(old, '@scope/tool', '2.0.0');
    pkg(old, 'zero-dot', '0.5.0');
    pkg(old, 'not-on-registry', '1.0.0');
    return { m, old };
  }

  test('--list shows what @latest is, and flags major updates', () => {
    const { m } = setup();
    const p = byName(listJson(m));
    assert.equal(p.typescript.latest, '5.9.3');
    assert.equal(p.typescript.majorUpdate, false);
    assert.equal(p['@scope/tool'].latest, '3.0.0');
    assert.equal(p['@scope/tool'].majorUpdate, true);
    assert.equal(p['zero-dot'].majorUpdate, true, '0.5 -> 0.7 can break too');
    assert.equal(p['not-on-registry'].latest, null);
    const text = reglobal(['--list'], m.env);
    assert.match(text.stdout, /to install +typescript +5\.4\.0 -> 5\.9\.3\n/);
    assert.match(text.stdout, /@scope\/tool +2\.0\.0 -> 3\.0\.0 \(major\)/);
    assert.match(text.stdout, /to install +not-on-registry +1\.0\.0\n/);
  });

  test('the plan carries latest and majorUpdate', () => {
    const { m } = setup();
    const plan = listJsonInstall(m, ['--dry-run']).json.plan;
    assert.deepEqual(plan[0], { name: '@scope/tool', version: '2.0.0', source: 'registry', spec: '@scope/tool@latest', latest: '3.0.0', majorUpdate: true });
  });

  test('--offline and --keep-versions do not ask the registry', () => {
    const m = machine();
    const old = fnmVersion(m, '24.3.0');
    pkg(old, 'offline-probe', '1.0.0');
    const r = listJson(m, '--offline');
    assert.equal('latest' in r.packages[0], false);
    listJsonInstall(m, ['--dry-run', '--keep-versions']);
    assert.equal(registryAsked().includes('offline-probe'), false);
    listJson(m);
    assert.equal(registryAsked().includes('offline-probe'), true);
  });

  test('a registry that cannot be reached is a warning, not an error', () => {
    const { m } = setup();
    m.env.npm_config_registry = 'http://127.0.0.1:9/';
    const r = listJson(m);
    assert.equal(r.packages[0].latest, null);
    assert.match(r.warnings.at(-1), /could not get the latest versions from http:\/\/127\.0\.0\.1:9\/: pass --offline/);
  });
});

describe('choosing packages', () => {
  // typescript, @scope/tool and pnpm to install; cowsay already here.
  function setup() {
    const m = machine();
    const old = fnmVersion(m, '24.3.0');
    pkg(old, 'typescript', '5.4.0');
    pkg(old, '@scope/tool', '2.0.0');
    pkg(old, 'pnpm', '9.0.0');
    pkg(old, 'cowsay', '1.6.0');
    pkg(m.current, 'cowsay', '1.7.0');
    const calls = withFakeNpm(m);
    return { m, calls, specs: () => calls().at(-1)?.slice(3) };
  }

  test('--skip leaves packages out, comma separated or repeated', () => {
    const { m, specs } = setup();
    const r = reglobal(['--yes', '--skip', 'typescript,pnpm'], m.env);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(specs(), ['@scope/tool@latest']);
    assert.match(r.stdout, /left out +typescript +5\.4\.0 -> 5\.9\.3/);
    assert.match(r.stdout, /1 to install, 2 left out, 1 already here/);
    const { m: m2, specs: specs2 } = setup();
    assert.equal(reglobal(['--yes', '--skip', 'typescript', '--skip', 'pnpm'], m2.env).code, 0);
    assert.deepEqual(specs2(), ['@scope/tool@latest']);
  });

  test('--only installs just those', () => {
    const { m, specs } = setup();
    const out = listJsonInstall(m, ['--yes', '--only', 'pnpm']);
    assert.equal(out.code, 0, out.stderr);
    assert.deepEqual(specs(), ['pnpm@latest']);
    assert.deepEqual(out.json.installed, ['pnpm']);
    assert.equal(byName(out.json).typescript.status, 'excluded');
    assert.equal(out.json.summary.excluded, 2);
  });

  test('a name that is not to be installed exits 1 and installs nothing', () => {
    const { m, calls } = setup();
    const typo = listJsonInstall(m, ['--yes', '--skip', 'typscript']);
    assert.equal(typo.code, 1);
    assert.equal(typo.json.error.code, 'BAD_NAME');
    assert.match(typo.json.error.message, /typscript is not one of the packages to install: Node 24\.3\.0 has no global package by that name/);
    const present = reglobal(['--yes', '--only', 'cowsay'], m.env);
    assert.match(present.stderr, /cowsay is not one of the packages to install: its status is present/);
    assert.deepEqual(calls(), []);
  });

  test('--skip and --only do not go together', () => {
    const { m } = setup();
    const r = reglobal(['--yes', '--skip', 'pnpm', '--only', 'typescript'], m.env);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /--skip and --only do not go together/);
  });

  test('skipping everything leaves nothing to install: exit 2', () => {
    const { m, calls } = setup();
    assert.equal(reglobal(['--yes', '--skip', 'typescript,pnpm,@scope/tool'], m.env).code, 2);
    assert.deepEqual(calls(), []);
  });
});

describe('the question', () => {
  function setup() {
    const m = machine();
    const old = fnmVersion(m, '24.3.0');
    pkg(old, 'typescript', '5.4.0');
    pkg(old, 'pnpm', '9.0.0');
    const calls = withFakeNpm(m);
    m.env.REGLOBAL_ASSUME_TTY = '1';
    return { m, calls };
  }

  test('y installs', () => {
    const { m, calls } = setup();
    const r = reglobal([], m.env, 'y\n');
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /Install 2 packages into Node .+\? \[y\/N, e to leave some out\]/);
    assert.deepEqual(calls()[0].slice(3), ['pnpm@latest', 'typescript@latest']);
  });

  test('anything else, or no answer, cancels with exit 3', () => {
    const { m, calls } = setup();
    assert.equal(reglobal([], m.env, 'n\n').code, 3);
    const r = reglobal([], m.env, '');
    assert.equal(r.code, 3);
    assert.match(r.stdout, /Cancelled: nothing installed\./);
    assert.deepEqual(calls(), []);
  });

  test('e asks which to leave out, then asks again', () => {
    const { m, calls } = setup();
    const r = reglobal([], m.env, 'e\ntypo\ne\npnpm\ny\n');
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /typo is not one of the packages to install/);
    assert.match(r.stdout, /Runs: npm install --global typescript@latest\n/);
    assert.deepEqual(calls()[0].slice(3), ['typescript@latest']);
  });

  test('leaving everything out cancels', () => {
    const { m, calls } = setup();
    assert.equal(reglobal([], m.env, 'e\npnpm typescript\n').code, 3);
    assert.deepEqual(calls(), []);
  });
});

describe('--interactive', () => {
  const DOWN = '\x1b[B';
  const UP = '\x1b[A';
  function setup() {
    const m = machine();
    const old = fnmVersion(m, '24.3.0');
    pkg(old, '@scope/tool', '2.0.0');
    pkg(old, 'pnpm', '9.0.0');
    pkg(old, 'typescript', '5.4.0');
    const calls = withFakeNpm(m);
    m.env.REGLOBAL_ASSUME_TTY = '1';
    return { m, calls, specs: () => calls().at(-1)?.slice(3) };
  }

  test('everything starts ticked: enter installs it all', () => {
    const { m, specs } = setup();
    const r = reglobal(['-i'], m.env, '\r');
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /> \[x\] @scope\/tool +2\.0\.0 -> 3\.0\.0 \(major\)/);
    assert.deepEqual(specs(), ['@scope/tool@latest', 'pnpm@latest', 'typescript@latest']);
  });

  test('space unticks the package under the cursor', () => {
    const { m, specs } = setup();
    const r = reglobal(['--interactive'], m.env, `${DOWN} ${DOWN}${DOWN}${UP} \r`);
    assert.equal(r.code, 0, r.stderr);
    // down, untick pnpm, down, down (wraps to the top), up, untick typescript
    assert.deepEqual(specs(), ['@scope/tool@latest']);
    assert.match(r.stdout, /Runs: npm install --global @scope\/tool@latest\n/);
  });

  test('a ticks none or all, j and k move', () => {
    const { m, specs } = setup();
    assert.equal(reglobal(['-i'], m.env, 'aj \r').code, 0);
    assert.deepEqual(specs(), ['pnpm@latest']);
    const { m: m2, specs: specs2 } = setup();
    assert.equal(reglobal(['-i'], m2.env, 'aak \r').code, 0);
    assert.deepEqual(specs2(), ['@scope/tool@latest', 'pnpm@latest']);
  });

  test('q, or nothing ticked, cancels with exit 3', () => {
    const { m, calls } = setup();
    assert.equal(reglobal(['-i'], m.env, 'q').code, 3);
    const none = reglobal(['-i'], m.env, 'a\r');
    assert.equal(none.code, 3);
    assert.match(none.stdout, /Nothing ticked: nothing installed\./);
    assert.equal(reglobal(['-i'], m.env, '').code, 3, 'stdin closed before enter');
    assert.deepEqual(calls(), []);
  });

  test('with --dry-run it shows the command for what was ticked', () => {
    const { m, calls } = setup();
    const r = reglobal(['-i', '--dry-run'], m.env, ' \r');
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Would run: npm install --global pnpm@latest typescript@latest/);
    assert.deepEqual(calls(), []);
  });

  test('needs a terminal, and does not go with --json or --yes', () => {
    const { m } = setup();
    assert.match(reglobal(['-i', '--json'], m.env).stdout, /"code": "BAD_OPTION"/);
    assert.match(reglobal(['-i', '--yes'], m.env).stderr, /--interactive does not go with --yes/);
    delete m.env.REGLOBAL_ASSUME_TTY;
    const r = reglobal(['-i'], m.env);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /--interactive needs a terminal: use --skip or --only/);
  });
});

describe('colour', () => {
  const ESC = '\u001b';
  function setup() {
    const m = machine();
    const old = fnmVersion(m, '24.3.0');
    pkg(old, '@scope/tool', '2.0.0');
    pkg(old, 'npm', '10.0.0');
    delete m.env.NO_COLOR;
    return m;
  }

  test('FORCE_COLOR turns on colour and symbols', () => {
    const m = setup();
    m.env.FORCE_COLOR = '1';
    const r = reglobal(['--list'], m.env);
    assert.ok(r.stdout.includes(`${ESC}[32mto install${ESC}[39m`), r.stdout);
    assert.ok(r.stdout.includes(`2.0.0${ESC}[22m → ${ESC}[32m3.0.0${ESC}[39m ${ESC}[33m(major)`), r.stdout);
  });

  test('NO_COLOR wins over FORCE_COLOR, and a pipe gets plain text', () => {
    const m = setup();
    assert.equal(reglobal(['--list'], m.env).stdout.includes(ESC), false);
    m.env.FORCE_COLOR = '1';
    m.env.NO_COLOR = '1';
    assert.equal(reglobal(['--list'], m.env).stdout.includes(ESC), false);
  });

  test('--json never has colour', () => {
    const m = setup();
    m.env.FORCE_COLOR = '1';
    assert.equal(reglobal(['--list', '--json'], m.env).stdout.includes(ESC), false);
  });
});
