// Tests for reglobal, run as a real CLI. No dependencies: node:test only.
// Run with `npm test`. Tests that install packages must use a throwaway npm
// prefix in the OS temp folder, never the real global folder.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REGLOBAL = fileURLToPath(new URL('../reglobal.js', import.meta.url));
const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version;
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE; // set in VS Code shells
env.NO_COLOR = '1';

function reglobal(args) {
  const r = spawnSync(process.execPath, [REGLOBAL, ...args], { encoding: 'utf8', env });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
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

  test('no arguments prints usage', () => {
    assert.match(reglobal([]).stdout, /^Usage: reglobal/);
  });

  test('an unknown option exits 1', () => {
    const r = reglobal(['--bogus']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /unknown option --bogus/);
  });
});
