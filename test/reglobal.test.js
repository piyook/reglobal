// Tests for reglobal, run as a real CLI. No dependencies: node:test only.
// Run with `npm test`. Tests that install packages must use a throwaway npm
// prefix in the OS temp folder, never the real global folder.
//
// Each test builds fake version-manager folders in a temp directory and points
// HOME and the managers' variables at it, so the real machine is never read.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
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
after(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});

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

function reglobal(args, env = baseEnv) {
  const r = spawnSync(process.execPath, [REGLOBAL, ...args], { encoding: 'utf8', env });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function listJson(m, ...args) {
  const r = reglobal(['--list', '--json', ...args], m.env);
  assert.equal(r.code, 0, r.stderr || r.stdout);
  return JSON.parse(r.stdout);
}

const byName = (result) => Object.fromEntries(result.packages.map((p) => [p.name, p]));

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

  test('no arguments prints usage', () => {
    assert.match(reglobal([]).stdout, /^Usage: reglobal/);
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

  test('installing is not built yet', () => {
    const r = reglobal(['--from', '24']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /not built yet/);
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
    assert.deepEqual(r.summary, { install: 2, present: 1, skipped: 2, linked: 0, broken: 0 });
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
    assert.match(r.stdout, /^From Node 24\.3\.0 \(fnm\): /);
    assert.match(r.stdout, /to install {2}typescript 5\.4\.0/);
    assert.match(r.stdout, /installed {3}cowsay 1\.6\.0 \(here: 1\.7\.0\)/);
    assert.match(r.stdout, /skipped {5}npm 10\.0\.0 \(comes with Node\)/);
    assert.match(r.stdout, /1 to install, 1 already here, 1 skipped\./);
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
    assert.match(text.stdout, /linked {6}my-tool -> .+ \(npm link\)/);
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
    assert.equal(p['from-url'].source, 'url');
    assert.equal(p['from-registry'].source, 'registry');
    assert.equal(p['from-registry'].resolved, undefined);
    const text = reglobal(['--list'], m.env);
    assert.match(text.stdout, /from-git 1\.0\.0 \(from git: git\+ssh/);
    assert.match(text.stderr, /from-git was installed from git/);
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
