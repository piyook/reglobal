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

## See what would move

```sh
reglobal --list            # the newest other installed version vs this one
reglobal --list --from 24  # or name the old version (24, 24.1, 24.1.0, or a folder)
```

```text
From Node 24.3.0 (fnm): ~/.local/share/fnm/node-versions/v24.3.0/installation/lib/node_modules
To   Node 26.1.0: ~/.local/share/fnm/node-versions/v26.1.0/installation/lib/node_modules

  to install  typescript 5.4.0
  installed   cowsay 1.6.0 (here: 1.7.0)
  skipped     npm 10.0.0 (comes with Node)

1 to install, 1 already here, 1 skipped.
```

It only reads folders: the old Node and npm never run, so it works even when they're broken. Add `--json` for output a script or agent can read (see [llms.txt](llms.txt)).

## Reinstall them

```sh
reglobal                   # shows the list, asks, then runs one npm install --global
reglobal --dry-run         # show what it would run, install nothing
reglobal --yes             # don't ask (scripts and agents)
reglobal --keep-versions   # the same versions as before, not the latest
reglobal -i                # tick and untick packages in a checklist first
reglobal --skip eslint     # leave some out (or --only typescript,pnpm)
```

The list shows the version each package will move to, and flags a new major version:

```text
  to install  typescript 5.4.0 -> 5.9.3
  to install  eslint 8.57.0 -> 9.39.1 (major)
```

At the question, answer `e` to type the names of the ones to leave out. `--offline` skips the version lookup.

npm and corepack are left alone, since they come with Node. Packages from git come back from git. `npm link` folders and packages installed from a local file are listed, not reinstalled.

Exit codes: `0` done, `1` error, `2` nothing to install, `3` cancelled.

## License

MIT
