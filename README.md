# reglobal

> Work in progress: not on npm yet. The badges below start working after the repo is public and the first release is out.

[![GitHub Release](https://img.shields.io/github/v/release/piyook/reglobal)](https://github.com/piyook/reglobal/releases)
[![checks workflow](https://github.com/piyook/reglobal/actions/workflows/checks.yaml/badge.svg)](https://github.com/piyook/reglobal/actions/workflows/checks.yaml)
[![npm version](https://img.shields.io/npm/v/reglobal)](https://www.npmjs.com/package/reglobal)
[![node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org)
[![dependencies: 0](https://img.shields.io/badge/dependencies-0-brightgreen)](package.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Moved to a new Node version and lost your global packages? reglobal reinstalls them in one command.

```sh
fnm install 26 && fnm use 26
npx reglobal --from 24
```

It finds the global packages you had in the old version, by reading that version's folder directly, and reinstalls them in the new one at their latest versions (or at the same versions, with `--keep-versions`).

- Works with fnm, nvm, nvm-windows, mise, asdf and n, or any other manager with `--from <path>`.
- `export` and `import` move the list between machines.
- Made for agents too: `--json` output, `--dry-run`, `--yes`, and exit codes an agent can act on.

No dependencies. Needs Node 22 or newer. Works on Windows, macOS and Linux.

## Install

```sh
npm install -g reglobal
```

Or run it without installing: `npx reglobal`.

## License

MIT
