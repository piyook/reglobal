#!/usr/bin/env node
// reglobal: after switching to a new Node version, reinstall the global npm
// packages you had in an older one. Reads the old version's global
// node_modules folder directly, so the old npm (or Node) never has to run.
// No dependencies on purpose: it must work in a fresh Node with no globals.
//
// Scaffold only: --help and --version work, the rest is still to write.

import { readFileSync } from 'node:fs';

const VERSION = JSON.parse(readFileSync(new URL('./package.json', import.meta.url))).version;

const HELP = `Usage: reglobal [options]

Reinstall the global npm packages from another Node version into this one.

Options:
  -h, --help      show this help
  -v, --version   print the version

Not built yet: --from <version|path>, --list, --dry-run, --yes, --json,
--keep-versions, export, import.`;

export function main(argv) {
  const args = argv.slice(2);
  if (args.includes('-h') || args.includes('--help')) {
    console.log(HELP);
    return 0;
  }
  if (args.includes('-v') || args.includes('--version')) {
    console.log(VERSION);
    return 0;
  }
  if (args.length) {
    console.error(`reglobal: unknown option ${args[0]} (see reglobal --help)`);
    return 1;
  }
  console.log(HELP);
  return 0;
}

process.exitCode = main(process.argv);
