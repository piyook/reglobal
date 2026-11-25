// Tests for reglobal, run as a real CLI. No dependencies: node:test only.
// Run with `npm test`. Tests that install packages must use a throwaway npm
// prefix in the OS temp folder, never the real global folder.
//
// Each test builds fake version-manager folders in a temp directory and points
// HOME and the managers' variables at it, so the real machine is never read.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { copyFileSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
// The npm prefix that holds a global node_modules: <prefix>/lib/node_modules
// on POSIX, <prefix>/node_modules on Windows.
const prefixOfModules = (modules) => (LIB ? path.dirname(path.dirname(modules)) : path.dirname(modules));

// Give a fake version's folder a real node (a hard link to this one, or a copy),
// so reglobal can run "its" npm. Returns the version's prefix.
function withNode(modules) {
  const prefix = prefixOfModules(modules);
  const node = WIN ? path.join(prefix, 'node.exe') : path.join(prefix, 'bin', 'node');
  mkdirSync(path.dirname(node), { recursive: true });
  try {
    linkSync(process.execPath, node);
  } catch {
    copyFileSync(process.execPath, node);
  }
  return prefix;
}

function reglobal(args, env = baseEnv, input = '') {
  const r = spawnSync(process.execPath, [REGLOBAL, ...args], { encoding: 'utf8', env, input });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function compareJson(m, ...args) {
  const r = reglobal(['--compare', '--json', ...args], m.env);
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
const modules = path.join(process.env.npm_config_prefix, process.platform === 'win32' ? '' : 'lib', 'node_modules');
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
    const r = reglobal(['--compare', '--from']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /--from/);
  });

  test('--compare does not take the install options', () => {
    const r = reglobal(['--compare', '--yes']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /--yes does not go with --compare/);
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
    const r = compareJson(m);
    assert.equal(r.from.version, '24.3.0');
    assert.equal(r.from.manager, 'fnm');
  });

  test('--from 22 picks the newest 22.x', () => {
    const m = machine();
    fnmVersion(m, '22.1.0');
    fnmVersion(m, '22.10.2');
    fnmVersion(m, '24.3.0');
    assert.equal(compareJson(m, '--from', '22').from.version, '22.10.2');
    assert.equal(compareJson(m, '--from', 'v22.1').from.version, '22.1.0');
    assert.equal(compareJson(m, '--from', '22.1.0').from.version, '22.1.0');
  });

  test('leaves out the version running now', () => {
    const m = machine();
    const only = fnmVersion(m, '24.3.0');
    m.env.NPM_CONFIG_PREFIX = prefixOfModules(only);
    const r = reglobal(['--compare'], m.env);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /no other Node version found \(installed: 24\.3\.0 \(fnm\)\)/);
  });

  test('a version that is not installed exits 1 and lists what is', () => {
    const m = machine();
    fnmVersion(m, '24.3.0');
    const r = reglobal(['--compare', '--json', '--from', '20'], m.env);
    assert.equal(r.code, 1);
    const out = JSON.parse(r.stdout);
    assert.equal(out.error.code, 'NOT_FOUND');
    assert.match(out.error.message, /installed: 24\.3\.0 \(fnm\)/);
  });

  test('--from that is neither a version nor a path exits 1', () => {
    const m = machine();
    const r = reglobal(['--compare', '--from', 'latest'], m.env);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /not a version/);
  });

  test('no versions at all exits 1', () => {
    const r = reglobal(['--compare'], machine().env);
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
      const r = compareJson(m, '--from', version);
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
    assert.equal(compareJson(m, '--from', '20.0.0').from.manager, 'fnm');
    assert.equal(compareJson(m, '--from', '20.1.0').from.manager, 'nvm');
  });

  test('ignores folders that are not versions, or have no node_modules', () => {
    const m = machine();
    fnmVersion(m, '24.3.0');
    mkdirSync(path.join(m.env.FNM_DIR, 'node-versions', '.downloads'), { recursive: true });
    mkdirSync(path.join(m.env.FNM_DIR, 'node-versions', 'v25.0.0'), { recursive: true });
    assert.equal(compareJson(m).from.version, '24.3.0');
  });

  test('--from <path> takes an install folder or a node_modules folder', () => {
    const m = machine();
    const install = path.join(m.root, 'custom', 'node-v21.0.0');
    const modules = path.join(install, LIB, 'node_modules');
    pkg(modules, 'cowsay', '1.6.0');
    const viaInstall = compareJson(m, '--from', install);
    assert.equal(viaInstall.from.dir, modules);
    assert.equal(viaInstall.from.manager, null);
    assert.equal(compareJson(m, '--from', modules).packages[0].name, 'cowsay');
  });

  test('--from <path> reads the version from a parent folder', () => {
    const m = machine();
    const modules = fnmVersion(m, '23.4.5');
    assert.equal(compareJson(m, '--from', modules).from.version, '23.4.5');
    const plain = path.join(m.root, 'plain', 'node_modules');
    mkdirSync(plain, { recursive: true });
    assert.equal(compareJson(m, '--from', plain).from.version, null);
  });

  test('--from <path> with no node_modules exits 1', () => {
    const m = machine();
    const r = reglobal(['--compare', '--from', path.join(m.root, 'nothing')], m.env);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /no global node_modules folder/);
  });
});

describe('--compare', () => {
  test('sorts old globals into install, present and skipped', () => {
    const m = machine();
    const old = fnmVersion(m, '24.3.0');
    pkg(old, 'typescript', '5.4.0');
    pkg(old, 'cowsay', '1.6.0');
    pkg(old, '@scope/tool', '2.0.0');
    pkg(old, 'npm', '10.0.0');
    pkg(old, 'corepack', '0.30.0');
    pkg(m.current, 'cowsay', '1.7.0');
    const r = compareJson(m);
    assert.equal(r.schemaVersion, 1);
    assert.equal(r.command, 'compare');
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
    const r = reglobal(['--compare'], m.env);
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
    const r = reglobal(['--compare'], m.env);
    assert.match(r.stdout, /no global packages/);
  });

  test('changes nothing', () => {
    const m = machine();
    const old = fnmVersion(m, '24.3.0');
    pkg(old, 'typescript', '5.4.0');
    const snapshot = () => [old, m.current].map((d) => readdirSync(d, { recursive: true }).sort());
    const before = snapshot();
    compareJson(m);
    assert.deepEqual(snapshot(), before);
    assert.equal(compareJson(m).summary.install, 1);
  });

  test('npm link symlinks are reported, not installed', () => {
    const m = machine();
    const old = fnmVersion(m, '24.3.0');
    const target = pkg(path.join(m.root, 'src'), 'my-tool', '0.1.0');
    symlinkSync(target, path.join(old, 'my-tool'), 'junction');
    const r = compareJson(m);
    assert.equal(r.packages[0].status, 'linked');
    assert.equal(r.summary.linked, 1);
    assert.match(r.warnings[0], /my-tool is an npm link/);
    const text = reglobal(['--compare'], m.env);
    assert.match(text.stdout, /linked +my-tool +0\.1\.0 +\(npm link to .+\)/);
    assert.match(text.stderr, /^WARNING: my-tool is an npm link/);
  });

  test('a package with no package.json is reported as broken', () => {
    const m = machine();
    const old = fnmVersion(m, '24.3.0');
    mkdirSync(path.join(old, 'half-gone'));
    const r = compareJson(m);
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
    const p = byName(compareJson(m));
    assert.equal(p['from-git'].source, 'git');
    assert.equal(p['from-git'].resolved, 'git+ssh://git@github.com/someone/from-git.git#abc123');
    assert.equal(p['from-file'].source, 'file');
    assert.equal(p['from-file'].status, 'manual');
    assert.equal(p['from-url'].source, 'url');
    assert.equal(p['from-registry'].source, 'registry');
    assert.equal(p['from-registry'].resolved, undefined);
    const text = reglobal(['--compare'], m.env);
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
    const p = byName(compareJson(m));
    assert.equal(p['from-git'].source, 'git');
    assert.equal(p.linked.status, 'linked');
    // npm keeps it relative to the folder holding node_modules; reglobal makes it absolute.
    assert.equal(p.linked.link, path.resolve(path.dirname(old), '../../src/linked'));
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

  test('--compare shows what @latest is, and flags major updates', () => {
    const { m } = setup();
    const p = byName(compareJson(m));
    assert.equal(p.typescript.latest, '5.9.3');
    assert.equal(p.typescript.majorUpdate, false);
    assert.equal(p['@scope/tool'].latest, '3.0.0');
    assert.equal(p['@scope/tool'].majorUpdate, true);
    assert.equal(p['zero-dot'].majorUpdate, true, '0.5 -> 0.7 can break too');
    assert.equal(p['not-on-registry'].latest, null);
    const text = reglobal(['--compare'], m.env);
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
    const r = compareJson(m, '--offline');
    assert.equal('latest' in r.packages[0], false);
    listJsonInstall(m, ['--dry-run', '--keep-versions']);
    assert.equal(registryAsked().includes('offline-probe'), false);
    compareJson(m);
    assert.equal(registryAsked().includes('offline-probe'), true);
  });

  test('a registry that cannot be reached is a warning, not an error', () => {
    const { m } = setup();
    m.env.npm_config_registry = 'http://127.0.0.1:9/';
    const r = compareJson(m);
    assert.equal(r.packages[0].latest, null);
    assert.match(r.warnings.at(-1), /could not get the latest versions from http:\/\/127\.0\.0\.1:9\/: pass --offline/);
  });

  // The fake registry logs every name it is asked for, so a name that must go
  // elsewhere can be checked never to reach it.
  function scoped(names) {
    const m = machine();
    const old = fnmVersion(m, '24.3.0');
    for (const name of names) pkg(old, name, '1.0.0');
    return m;
  }
  const NOWHERE = 'http://127.0.0.1:9/';

  test("a scope's own registry in the user's .npmrc keeps its names off the default one", () => {
    const m = scoped(['@private-a/tool', 'npmrc-public-a']);
    writeFileSync(path.join(m.home, '.npmrc'), `; a comment\n@private-a:registry=${NOWHERE}\n`);
    compareJson(m);
    assert.equal(registryAsked().includes('@private-a/tool'), false);
    assert.equal(registryAsked().includes('npmrc-public-a'), true);
  });

  test('the global npmrc of the Node installed into, and npm_config_ variables, count too', () => {
    const m = scoped(['@private-b/tool', '@private-c/tool']);
    const etc = path.join(prefixOfModules(m.current), 'etc');
    mkdirSync(etc, { recursive: true });
    writeFileSync(path.join(etc, 'npmrc'), `@private-b:registry=${NOWHERE}\n`);
    m.env['npm_config_@private-c:registry'] = NOWHERE;
    compareJson(m);
    assert.equal(registryAsked().includes('@private-b/tool'), false);
    assert.equal(registryAsked().includes('@private-c/tool'), false);
  });

  test("the registry in the user's .npmrc is used when no variable sets one, with variables filled in", () => {
    const m = scoped(['npmrc-public-d']);
    const port = new URL(m.env.npm_config_registry).port;
    delete m.env.npm_config_registry;
    m.env.REGISTRY_PORT = port;
    // biome-ignore lint/suspicious/noTemplateCurlyInString: npm's own ${VAR} syntax, not a template
    writeFileSync(path.join(m.home, '.npmrc'), 'registry="http://127.0.0.1:${REGISTRY_PORT}/"\n');
    compareJson(m);
    assert.equal(registryAsked().includes('npmrc-public-d'), true);
    writeFileSync(path.join(m.home, '.npmrc'), `registry=${NOWHERE}\n`);
    assert.match(compareJson(m).warnings.at(-1), /could not get the latest versions from http:\/\/127\.0\.0\.1:9\//);
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
    const r = reglobal(['--compare'], m.env);
    assert.ok(r.stdout.includes(`${ESC}[32mto install${ESC}[39m`), r.stdout);
    assert.ok(r.stdout.includes(`2.0.0${ESC}[22m → ${ESC}[32m3.0.0${ESC}[39m ${ESC}[33m(major)`), r.stdout);
  });

  test('NO_COLOR wins over FORCE_COLOR, and a pipe gets plain text', () => {
    const m = setup();
    assert.equal(reglobal(['--compare'], m.env).stdout.includes(ESC), false);
    m.env.FORCE_COLOR = '1';
    m.env.NO_COLOR = '1';
    assert.equal(reglobal(['--compare'], m.env).stdout.includes(ESC), false);
  });

  test('--json never has colour', () => {
    const m = setup();
    m.env.FORCE_COLOR = '1';
    assert.equal(reglobal(['--compare', '--json'], m.env).stdout.includes(ESC), false);
  });
});

describe('reglobal <old> <new>', () => {
  // An fnm with Node 24.3.0 (two globals) and 26.1.0, which gets a real node
  // (a hard link to this one), so reglobal can run "its" npm.
  function setup() {
    const m = machine();
    const old = fnmVersion(m, '24.3.0');
    pkg(old, 'typescript', '5.4.0');
    pkg(old, 'pnpm', '9.0.0');
    const target = fnmVersion(m, '26.1.0');
    const prefix = withNode(target);
    const calls = withFakeNpm(m);
    return { m, target, prefix, calls };
  }

  test('installs from the first version into the second', () => {
    const { m, target, calls } = setup();
    const out = listJsonInstall(m, ['24.3.0', '26.1.0', '--yes']);
    assert.equal(out.code, 0, out.stderr);
    assert.equal(out.json.from.version, '24.3.0');
    assert.deepEqual(out.json.to, { version: '26.1.0', manager: 'fnm', dir: target });
    assert.deepEqual(out.json.installed, ['pnpm', 'typescript']);
    assert.deepEqual(calls()[0].slice(3), ['pnpm@latest', 'typescript@latest']);
    assert.equal(compareJson(m, '24', '26').summary.present, 2, 'they are in 26.1.0 now');
  });

  test("hands npm the new version's prefix, whatever npx passed down", () => {
    const { m, prefix } = setup();
    m.env.npm_config_global_prefix = path.join(m.root, 'wrong');
    m.env.NPM_CONFIG_PREFIX = path.join(m.root, 'wrong');
    assert.equal(reglobal(['24', '26', '--yes'], m.env).code, 0);
    assert.ok(readdirSync(path.join(prefix, LIB, 'node_modules')).includes('typescript'));
  });

  test('one version installs into the Node in use, and --compare takes them too', () => {
    const { m } = setup();
    const r = compareJson(m, '24');
    assert.equal(r.from.version, '24.3.0');
    assert.equal(r.to.dir, m.current);
    assert.equal(r.to.version, process.versions.node);
    assert.equal(r.to.manager, null, "the prefix here is not one of fnm's versions");
    assert.equal(compareJson(m, '24', '26').to.version, '26.1.0');
    m.env.NPM_CONFIG_PREFIX = prefixOfModules(fnmVersion(m, '26.1.0'));
    assert.equal(compareJson(m, '24').to.manager, 'fnm', "the Node in use is fnm's 26.1.0");
  });

  test('with only the new version given, the old one is the newest other', () => {
    const { m } = setup();
    fnmVersion(m, '22.0.0');
    const r = compareJson(m, '--to', '26');
    assert.equal(r.from.version, '24.3.0');
    assert.equal(r.to.version, '26.1.0');
  });

  test('the old version is never the new one', () => {
    const { m } = setup();
    const r = reglobal(['26', '26', '--compare'], m.env);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /no installed Node 26 other than the one installed into/);
  });

  test('a new version that is not installed, or has no node, exits 1', () => {
    const { m } = setup();
    assert.match(reglobal(['24', '27', '--compare'], m.env).stderr, /no installed Node 27 to install into/);
    fnmVersion(m, '25.0.0');
    const out = listJsonInstall(m, ['24', '25', '--dry-run']);
    assert.equal(out.json.error.code, 'NO_NODE');
  });

  test('a new version with no npm of its own exits 1', () => {
    const { m } = setup();
    delete m.env.REGLOBAL_NPM_CLI;
    const out = listJsonInstall(m, ['24', '26', '--yes']);
    assert.equal(out.code, 1);
    assert.equal(out.json.error.code, 'NO_NPM');
    assert.match(out.json.error.message, /Node 26\.1\.0 has no npm/);
  });

  test('bad arguments exit 1', () => {
    const { m } = setup();
    assert.match(reglobal(['24', '26', '22'], m.env).stderr, /too many versions: 24 26 22/);
    assert.match(reglobal(['24', '--from', '22'], m.env).stderr, /give the old version once: 24 or --from 22/);
    assert.match(reglobal(['24', 'latest'], m.env).stderr, /unknown command latest/);
    assert.match(reglobal(['24', '26', '--to', '25'], m.env).stderr, /give the new version once: 26 or --to 25/);
  });
});

describe('export', () => {
  function setup() {
    const m = machine();
    pkg(m.current, 'typescript', '5.4.0');
    pkg(m.current, '@scope/tool', '2.0.0');
    pkg(m.current, 'from-git', '1.0.0', { _resolved: 'git+https://github.com/someone/from-git.git#abc' });
    pkg(m.current, 'npm', '10.0.0');
    mkdirSync(path.join(m.current, 'half-gone'));
    return m;
  }

  test('writes the globals of the Node in use, without npm or broken folders', () => {
    const m = setup();
    const file = path.join(m.root, 'globals.json');
    const r = reglobal(['export', file], m.env);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Exported 3 packages from Node .+ to .+globals\.json/);
    const data = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(data.kind, 'reglobal-export');
    assert.equal(data.schemaVersion, 1);
    assert.equal(data.from.version, process.versions.node);
    assert.match(data.exportedAt, /^\d{4}-\d\d-\d\dT/);
    assert.deepEqual(data.packages, [
      { name: '@scope/tool', version: '2.0.0', source: 'registry' },
      { name: 'from-git', version: '1.0.0', source: 'git', resolved: 'git+https://github.com/someone/from-git.git#abc' },
      { name: 'typescript', version: '5.4.0', source: 'registry' },
    ]);
  });

  test('with no file, prints the export on stdout', () => {
    const m = setup();
    const r = reglobal(['export'], m.env);
    assert.equal(r.code, 0);
    assert.equal(JSON.parse(r.stdout).packages.length, 3);
  });

  test('--from exports another version, and keeps npm links', () => {
    const m = setup();
    const old = fnmVersion(m, '24.3.0');
    pkg(old, 'pnpm', '9.0.0');
    const target = pkg(path.join(m.root, 'src'), 'my-tool', '0.1.0');
    symlinkSync(target, path.join(old, 'my-tool'), 'junction');
    const data = JSON.parse(reglobal(['export', '--from', '24'], m.env).stdout);
    assert.deepEqual(data.from, { version: '24.3.0', manager: 'fnm' });
    assert.deepEqual(
      data.packages.map((p) => [p.name, p.status ?? p.source]),
      [
        ['my-tool', 'linked'],
        ['pnpm', 'registry'],
      ],
    );
  });

  test('will not overwrite a file without --yes', () => {
    const m = setup();
    const file = path.join(m.root, 'package.json');
    writeFileSync(file, '{"precious":true}');
    const r = listJsonInstall(m, ['export', file]);
    assert.equal(r.code, 1);
    assert.equal(r.json.error.code, 'FILE_EXISTS');
    assert.equal(readFileSync(file, 'utf8'), '{"precious":true}');
    const forced = listJsonInstall(m, ['export', file, '--yes']);
    assert.equal(forced.code, 0);
    assert.equal(forced.json.command, 'export');
    assert.equal(forced.json.packages, 3);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).kind, 'reglobal-export');
  });

  test('bad arguments exit 1', () => {
    const m = setup();
    assert.match(reglobal(['export', 'a.json', 'b.json'], m.env).stderr, /export takes one file/);
    assert.match(reglobal(['export', '--dry-run'], m.env).stderr, /--dry-run does not go with export/);
    assert.match(reglobal(['export', '--from', '19'], m.env).stderr, /no installed Node 19/);
  });
});

describe('import', () => {
  // An export file, as another machine would have written it.
  function setup(packages, extra = {}) {
    const m = machine();
    const file = path.join(m.root, 'globals.json');
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, kind: 'reglobal-export', from: { version: '22.1.0', manager: 'nvm' }, packages, ...extra }));
    const calls = withFakeNpm(m);
    return { m, file, calls };
  }
  const BASIC = [
    { name: 'typescript', version: '5.4.0', source: 'registry' },
    { name: 'cowsay', version: '1.6.0', source: 'registry' },
    { name: 'npm', version: '10.0.0', source: 'registry' },
  ];

  test('installs from the file into the Node in use', () => {
    const { m, file, calls } = setup(BASIC);
    pkg(m.current, 'cowsay', '1.7.0');
    const r = reglobal(['import', file, '--yes'], m.env);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^From globals\.json \(Node 22\.1\.0 \(nvm\)\) +.+globals\.json/);
    assert.deepEqual(calls()[0].slice(3), ['typescript@latest']);
  });

  test('--dry-run --json shows the file as the old side', () => {
    const { file } = setup(BASIC);
    const out = listJsonInstall(setup(BASIC).m, ['import', file, '--dry-run']);
    assert.equal(out.code, 0, out.stderr);
    assert.deepEqual(out.json.from, { version: '22.1.0', manager: 'nvm', dir: null, file });
    assert.deepEqual(
      out.json.plan.map((p) => p.spec),
      ['cowsay@latest', 'typescript@latest'],
    );
  });

  test('--keep-versions, --skip and --compare work as usual', () => {
    const { m, file, calls } = setup(BASIC);
    assert.equal(reglobal(['import', file, '--yes', '--keep-versions', '--skip', 'cowsay'], m.env).code, 0);
    assert.deepEqual(calls()[0].slice(3), ['typescript@5.4.0']);
    const listed = listJsonInstall(m, ['import', file, '--compare']);
    assert.equal(listed.json.command, 'compare');
    assert.equal(byName(listed.json).typescript.status, 'present');
  });

  test('imports into another version', () => {
    const { m, file } = setup(BASIC);
    withNode(fnmVersion(m, '26.1.0'));
    const out = listJsonInstall(m, ['import', file, '26', '--compare']);
    assert.equal(out.json.to.version, '26.1.0');
    assert.equal(listJsonInstall(m, ['import', file, '--to', '26', '--compare']).json.to.version, '26.1.0');
  });

  test('works the source out again, and warns about git and links', () => {
    const { m, file } = setup([
      { name: 'sneaky', version: '1.0.0', source: 'registry', resolved: 'git+https://example.com/sneaky.git#abc' },
      { name: 'my-tool', version: '0.1.0', status: 'linked', link: '/home/someone/src/my-tool' },
      { name: 'local', version: '1.0.0', resolved: 'file:../local-1.0.0.tgz' },
    ]);
    const out = listJsonInstall(m, ['import', file, '--dry-run']);
    const p = byName(out.json);
    assert.equal(p.sneaky.source, 'git', 'the file said registry, but the URL is git');
    assert.equal(p['my-tool'].status, 'linked');
    assert.equal(p.local.status, 'manual');
    assert.deepEqual(
      out.json.plan.map((x) => x.spec),
      ['git+https://example.com/sneaky.git'],
    );
    assert.match(out.json.warnings.join('\n'), /sneaky is reinstalled from git/);
  });

  test('only https, git over https or ssh, and host shorthands are installed from a file', () => {
    const ok = [
      'git+https://github.com/someone/a.git#abc',
      'git+ssh://git@github.com/someone/a.git#abc',
      'https://example.com/a-1.0.0.tgz',
      'github:someone/a#main',
      'gitlab:someone/a',
      'bitbucket:some-one/a.b',
    ];
    for (const resolved of ok) {
      const { m, file } = setup([{ name: 'a', version: '1.0.0', resolved }]);
      const out = listJsonInstall(m, ['import', file, '--dry-run']);
      assert.equal(out.code, 0, `${resolved}: ${JSON.stringify(out.json.error)}`);
    }
    const bad = [
      'http://example.com/a-1.0.0.tgz',
      'git://github.com/someone/a.git',
      'git+http://github.com/someone/a.git',
      'git+ssh://-oProxyCommand=calc/a.git',
      'git+ssh://-oProxyCommand=calc@github.com/a.git',
      'git+file:///tmp/a.git',
      'github:-x/a',
      'https://example.com/a b.tgz',
    ];
    for (const resolved of bad) {
      const { m, file } = setup([{ name: 'a', version: '1.0.0', resolved }]);
      const out = listJsonInstall(m, ['import', file, '--dry-run']);
      assert.equal(out.code, 1, resolved);
      assert.equal(out.json.error.code, 'BAD_FILE', resolved);
      assert.match(out.json.error.message, /has a source for a that reglobal will not install/, resolved);
    }
  });

  test('a version that is not a plain version is dropped, not passed to npm', () => {
    const { m, file } = setup([{ name: 'typescript', version: '5.4.0 --registry=http://evil', source: 'registry' }]);
    const out = listJsonInstall(m, ['import', file, '--dry-run', '--keep-versions']);
    assert.equal(out.json.plan[0].spec, 'typescript@latest');
  });

  test('a file that is missing, not JSON, not an export or too new exits 1', () => {
    const { m, file } = setup(BASIC);
    const err = (args) => listJsonInstall(m, args).json.error;
    assert.equal(err(['import', path.join(m.root, 'nope.json'), '--dry-run']).code, 'NOT_FOUND');
    writeFileSync(file, 'not json');
    assert.match(err(['import', file, '--dry-run']).message, /is not a JSON file/);
    writeFileSync(file, '{"packages":[]}');
    assert.match(err(['import', file, '--dry-run']).message, /is not a reglobal export/);
    writeFileSync(file, JSON.stringify({ schemaVersion: 2, kind: 'reglobal-export', packages: [] }));
    assert.match(err(['import', file, '--dry-run']).message, /made by a newer reglobal/);
  });

  test('a bad package name exits 1, so it never reaches npm', () => {
    for (const name of ['--global-style', '../escape', 'a b', '']) {
      const { m, file, calls } = setup([{ name, version: '1.0.0' }]);
      const out = listJsonInstall(m, ['import', file, '--yes']);
      assert.equal(out.code, 1, name);
      assert.equal(out.json.error.code, 'BAD_FILE');
      assert.deepEqual(calls(), []);
    }
  });

  test('bad arguments exit 1', () => {
    const { m, file } = setup(BASIC);
    assert.match(reglobal(['import'], m.env).stderr, /import needs a file/);
    assert.match(reglobal(['import', file, '--from', '24'], m.env).stderr, /--from does not go with import/);
    assert.match(reglobal(['import', file, '26', '22'], m.env).stderr, /too many arguments/);
  });

  test('round trip: export on one machine, import on another', () => {
    const a = machine();
    pkg(a.current, 'typescript', '5.4.0');
    pkg(a.current, 'pnpm', '9.0.0');
    const file = path.join(a.root, 'globals.json');
    assert.equal(reglobal(['export', file], a.env).code, 0);
    const b = machine();
    const calls = withFakeNpm(b);
    assert.equal(reglobal(['import', file, '--yes', '--keep-versions'], b.env).code, 0);
    assert.deepEqual(calls()[0].slice(3), ['pnpm@9.0.0', 'typescript@5.4.0']);
    assert.equal(reglobal(['import', file, '--yes'], b.env).code, 2, 'run again: nothing left to install');
  });
});

describe('export and import: hardening', () => {
  function exportFile(m, packages, extra = {}) {
    const file = path.join(m.root, 'globals.json');
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, kind: 'reglobal-export', from: { version: '22.1.0', manager: 'nvm' }, packages, ...extra }));
    return file;
  }
  const ONE = [{ name: 'typescript', version: '5.4.0', source: 'registry' }];

  test('reads exports saved with a BOM, or as UTF-16 by Windows PowerShell', () => {
    const m = machine();
    const json = JSON.stringify({ schemaVersion: 1, kind: 'reglobal-export', packages: ONE });
    const file = path.join(m.root, 'g.json');
    for (const bytes of [
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(json, 'utf8')]),
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(json, 'utf16le')]),
      Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(json, 'utf16le').swap16()]),
    ]) {
      writeFileSync(file, bytes);
      const out = listJsonInstall(m, ['import', file, '--compare']);
      assert.equal(out.code, 0, out.stdout);
      assert.equal(out.json.packages[0].name, 'typescript');
    }
  });

  test('control characters in a file never reach the terminal', () => {
    const m = machine();
    const ESC = '\u001b';
    const file = exportFile(m, [{ name: 'my-tool', status: 'linked', link: `/src/my-tool${ESC}[2K${ESC}[1A` }], {
      from: { version: `22${ESC}[2J`, manager: `nvm\u009b2J` },
    });
    const r = reglobal(['import', file, '--compare'], m.env);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.includes(ESC) || r.stderr.includes(ESC) || r.stdout.includes('\u009b'), false);
    assert.match(r.stderr, /my-tool is an npm link to \/src\/my-tool\[2K\[1A/);
    const url = exportFile(m, [{ name: 'x', resolved: `git+https://example.com/x.git${ESC}[2K` }]);
    const out = listJsonInstall(m, ['import', url, '--dry-run']);
    assert.equal(out.json.error.code, 'BAD_FILE');
    assert.match(out.json.error.message, /control characters in the source of x/);
  });

  test('a missing or bad schemaVersion is not called "newer"', () => {
    const m = machine();
    for (const schemaVersion of [undefined, 0, 1.5, '1']) {
      const out = listJsonInstall(m, ['import', exportFile(m, ONE, { schemaVersion }), '--compare']);
      assert.match(out.json.error.message, /has no valid schemaVersion/, String(schemaVersion));
    }
  });

  test('a --skip typo under import names the file, not a Node version', () => {
    const m = machine();
    const out = listJsonInstall(m, ['import', exportFile(m, ONE), '--yes', '--skip', 'typscript']);
    assert.match(out.json.error.message, /typscript is not one of the packages to install: globals\.json has no global package by that name/);
  });

  test('export 24 asks for --from rather than writing a file called 24', () => {
    const m = machine();
    const r = reglobal(['export', '24'], { ...m.env });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /24 looks like a version: use --from 24 to export it \(or \.\/24 for a file by that name\)/);
  });

  test('export into a missing folder or onto a folder exits 1 with a clear message', () => {
    const m = machine();
    assert.match(listJsonInstall(m, ['export', path.join(m.root, 'no', 'such', 'g.json')]).json.error.message, /the folder .+ does not exist/);
    assert.match(listJsonInstall(m, ['export', m.root, '--yes']).json.error.message, /is a folder: give a file name/);
  });

  test('export does not write through a symlink that points nowhere', (t) => {
    const m = machine();
    const link = path.join(m.root, 'link.json');
    const target = path.join(m.root, 'elsewhere.json');
    try {
      symlinkSync(target, link, 'file');
    } catch {
      t.skip('this account cannot make file symlinks');
      return;
    }
    const out = listJsonInstall(m, ['export', link]);
    assert.equal(out.json.error.code, 'FILE_EXISTS');
    assert.throws(() => readFileSync(target), /ENOENT/);
  });
});

describe('review fixes', () => {
  // A Node folder that is not a manager's and has no version in its path,
  // with its node_modules straight under it: <prefix>/node_modules.
  function plainNode(m) {
    const prefix = path.join(m.root, 'plain');
    const modules = path.join(prefix, 'node_modules');
    mkdirSync(modules, { recursive: true });
    const node = WIN ? path.join(prefix, 'node.exe') : path.join(prefix, 'bin', 'node');
    mkdirSync(path.dirname(node), { recursive: true });
    copyFileSync(process.execPath, node);
    return { prefix, modules };
  }

  test('a <prefix>/node_modules folder finds the node in <prefix>, and the question names the folder', () => {
    const m = machine();
    pkg(fnmVersion(m, '24.3.0'), 'typescript', '5.4.0');
    const { prefix, modules } = plainNode(m);
    const r = reglobal(['--compare', '24', modules, '--json', '--offline'], m.env);
    assert.equal(r.code, 0, r.stdout);
    assert.equal(JSON.parse(r.stdout).to.version, null);
    const asked = reglobal(['24', modules, '--offline'], { ...m.env, REGLOBAL_ASSUME_TTY: '1' }, 'n\n');
    assert.equal(asked.code, 3, asked.stderr);
    assert.ok(asked.stderr.includes(`Install 1 package into the Node in ${prefix}?`), asked.stderr);
    assert.equal(asked.stderr.includes('Node null'), false);
  });

  test('a registry tarball from another registry than npm uses now is a warning', () => {
    const m = machine();
    const old = fnmVersion(m, '24.3.0');
    pkg(old, 'moved-a', '1.0.0', { _resolved: 'https://other.example/moved-a/-/moved-a-1.0.0.tgz' });
    pkg(old, 'moved-b', '1.0.0', { _resolved: 'https://other.example/moved-b/-/moved-b-1.0.0.tgz' });
    pkg(old, 'same', '1.0.0', { _resolved: `${m.env.npm_config_registry}same/-/same-1.0.0.tgz` });
    const r = compareJson(m, '--offline');
    assert.equal(byName(r)['moved-a'].source, 'registry');
    assert.equal(byName(r)['moved-a'].resolved, undefined, 'the tarball stays out of the JSON');
    assert.deepEqual(r.warnings, [
      `moved-a, moved-b were installed from https://other.example, but npm will install from ${new URL(m.env.npm_config_registry).origin}: check it is the same package there.`,
    ]);
  });

  test('a GitHub Packages tarball is a registry package, installed at @latest', () => {
    const m = machine();
    pkg(fnmVersion(m, '24.3.0'), '@someone/tool', '1.0.0', { _resolved: 'https://npm.pkg.github.com/download/@someone/tool/1.0.0/abc123' });
    m.env['npm_config_@someone:registry'] = 'https://npm.pkg.github.com/';
    const out = listJsonInstall(m, ['--dry-run', '--offline']);
    assert.equal(out.json.plan[0].source, 'registry');
    assert.equal(out.json.plan[0].spec, '@someone/tool@latest');
    assert.deepEqual(out.json.warnings, []);
  });

  test('importing reglobal.js does not run the CLI', () => {
    const m = machine();
    const script = path.join(m.root, 'uses-reglobal.mjs');
    writeFileSync(script, `const { main } = await import(${JSON.stringify(new URL('../reglobal.js', import.meta.url).href)});\nconsole.log(typeof main);\n`);
    const r = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8', env: m.env });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'function\n');
  });

  test('--help lists -h and -v with the other options', () => {
    assert.match(
      reglobal(['--help']).stdout,
      / {2}--json +print JSON on stdout\n {2}-h, --help +show this help\n {2}-v, --version +print the version\n\nAt the question/,
    );
  });
});

describe('--list', () => {
  function listOne(m, args = []) {
    const r = reglobal(['--list', '--json', ...args], m.env);
    assert.equal(r.code, 0, r.stderr || r.stdout);
    return JSON.parse(r.stdout);
  }

  test("shows the Node in use's globals, and nothing from other versions", () => {
    const m = machine();
    pkg(fnmVersion(m, '24.3.0'), 'cowsay', '1.6.0');
    pkg(m.current, 'typescript', '5.4.0');
    pkg(m.current, 'npm', '10.0.0');
    const r = listOne(m);
    assert.equal(r.schemaVersion, 1);
    assert.equal(r.command, 'list');
    assert.equal(r.node.version, process.versions.node);
    assert.equal(r.node.dir, m.current);
    assert.deepEqual(
      r.packages.map((p) => p.name),
      ['npm', 'typescript'],
    );
    assert.equal(byName(r).npm.status, 'bundled');
    assert.equal(byName(r).typescript.source, 'registry');
    assert.deepEqual(r.summary, { packages: 2, bundled: 1, linked: 0, broken: 0 });
  });

  test('--list 24 (or --from 24) shows Node 24', () => {
    const m = machine();
    pkg(fnmVersion(m, '24.3.0'), 'cowsay', '1.6.0');
    pkg(m.current, 'typescript', '5.4.0');
    for (const args of [['24'], ['--from', '24'], ['24.3.0']]) {
      const r = listOne(m, args);
      assert.equal(r.node.version, '24.3.0', args.join(' '));
      assert.equal(r.node.manager, 'fnm');
      assert.deepEqual(
        r.packages.map((p) => p.name),
        ['cowsay'],
      );
    }
  });

  test('prints a readable list without --json, with links, git and broken folders noted', () => {
    const m = machine();
    const dir = fnmVersion(m, '24.3.0');
    pkg(dir, 'typescript', '5.4.0');
    pkg(dir, 'corepack', '0.30.0');
    pkg(dir, 'from-git', '1.0.0', { _resolved: 'git+https://github.com/someone/from-git.git#abc' });
    mkdirSync(path.join(dir, 'half-gone'));
    symlinkSync(pkg(path.join(m.root, 'src'), 'my-tool', '0.1.0'), path.join(dir, 'my-tool'), 'junction');
    const r = reglobal(['--list', '24'], m.env);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^Node 24\.3\.0 \(fnm\) {2}.+node_modules\n\n/);
    assert.match(r.stdout, /\n {2}typescript +5\.4\.0\n/);
    assert.match(r.stdout, /corepack +0\.30\.0 +\(comes with Node\)/);
    assert.match(r.stdout, /from-git +1\.0\.0 +\(from git: git\+https/);
    assert.match(r.stdout, /half-gone +\(no package\.json\)/);
    assert.match(r.stdout, /my-tool +0\.1\.0 +\(npm link to .+\)/);
    assert.match(r.stdout, /\n5 packages\n$/);
    assert.equal(r.stderr, '');
  });

  test('says so when there are no globals', () => {
    const m = machine();
    const r = reglobal(['--list'], m.env);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /no global packages\n\n0 packages\n$/);
  });

  test('never asks the registry, and changes nothing', () => {
    const m = machine();
    pkg(m.current, 'typescript', '5.4.0');
    const asked = registryAsked().length;
    const before = readdirSync(m.current, { recursive: true }).sort();
    listOne(m);
    assert.equal(registryAsked().length, asked);
    assert.deepEqual(readdirSync(m.current, { recursive: true }).sort(), before);
  });

  test('two versions, or --to, point to --compare', () => {
    const m = machine();
    fnmVersion(m, '24.3.0');
    fnmVersion(m, '26.1.0');
    const two = reglobal(['--list', '24', '26'], m.env);
    assert.equal(two.code, 1);
    assert.match(two.stderr, /--list shows one version: to compare two, use --compare 24 26/);
    assert.match(reglobal(['--list', '--to', '26'], m.env).stderr, /use --compare <old> 26/);
  });

  test('bad options exit 1', () => {
    const m = machine();
    const cases = [
      [['--list', '--compare'], /--list and --compare do not go together/],
      [['--list', '--yes'], /--yes does not go with --list, which installs nothing/],
      [['--list', '--skip', 'x'], /--skip does not go with --list/],
      [['--list', '--offline'], /--offline does not go with --list/],
      [['--list', '27'], /no installed Node 27/],
      [['export', '--list'], /--list does not go with export/],
      [['export', '--compare'], /--compare does not go with export/],
    ];
    for (const [args, message] of cases) {
      const r = reglobal(args, m.env);
      assert.equal(r.code, 1, args.join(' '));
      assert.match(r.stderr, message, args.join(' '));
    }
  });

  test('import <file> --list shows the file alone', () => {
    const m = machine();
    fnmVersion(m, '26.1.0');
    pkg(m.current, 'typescript', '5.4.0');
    const file = path.join(m.root, 'globals.json');
    writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 1,
        kind: 'reglobal-export',
        from: { version: '22.1.0', manager: 'nvm' },
        packages: [
          { name: 'typescript', version: '5.4.0', source: 'registry' },
          { name: 'my-tool', version: '0.1.0', status: 'linked', link: '/src/my-tool' },
        ],
      }),
    );
    const r = listOne(m, ['import', file]);
    assert.deepEqual(r.node, { version: '22.1.0', manager: 'nvm', dir: null, file });
    assert.deepEqual(
      r.packages.map((p) => [p.name, p.status]),
      [
        ['my-tool', 'linked'],
        ['typescript', undefined],
      ],
    );
    const text = reglobal(['import', file, '--list'], m.env);
    assert.match(text.stdout, /^globals\.json \(Node 22\.1\.0 \(nvm\)\) {2}.+globals\.json\n/);
    assert.match(text.stdout, /my-tool +0\.1\.0 +\(npm link to \/src\/my-tool\)/);
    const into = reglobal(['import', file, '26', '--list'], m.env);
    assert.equal(into.code, 1);
    assert.match(into.stderr, /--list shows the file alone: to compare it with Node 26, use import .+globals\.json --compare 26/);
  });
});
