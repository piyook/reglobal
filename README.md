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
npx reglobal 24.22.3 26.13.1   # from Node 24.22.3 into Node 26.13.1
npx reglobal 24 26             # the same, with the newest installed 24.x and 26.x
npx reglobal 24                # from 24 into the Node you're using now
```

It finds the global packages you had in the old version, by reading that version's folder directly, and reinstalls them in the new one at their latest versions (or at the same versions, with `--keep-versions`).

- Works with fnm, nvm, nvm-windows, mise, asdf and n, or any other manager with `--from <path>`.
- Shows the version each package will move to, and lets you leave some out.
- Made for agents too: `--json` output, `--dry-run`, `--yes`, and exit codes an agent can act on.
- Coming: `export` and `import`, to move the list between machines.

No dependencies. Needs Node 22 or newer. Works on Windows, macOS and Linux.

## Run it with npx (no install needed)

```sh
npx reglobal
```

This is the way to use it. A global install of reglobal belongs to one Node version, so after a switch it is missing from the new one, like your other globals. `npx reglobal` runs in the Node you have just switched to, which is the one it installs into, and needs nothing installed first.

If you'd still like it installed, `npm install -g reglobal` works too: then run `reglobal` in place of `npx reglobal` below.

## See what would move

```sh
npx reglobal 24 26 --list      # what 24 has that 26 hasn't (read-only)
npx reglobal --list            # the newest other installed version vs the one in use
```

A version can be `24`, `24.1` or `24.1.0` (the newest installed match), or a version's folder. With no new version, reglobal installs into the Node in use; given one, it runs that version's own node and npm, so you don't have to switch to it first.

```text
From Node 24.3.0 (fnm): ~/.local/share/fnm/node-versions/v24.3.0/installation/lib/node_modules
To   Node 26.1.0: ~/.local/share/fnm/node-versions/v26.1.0/installation/lib/node_modules

  to install  typescript 5.4.0 -> 5.9.3
  to install  eslint 8.57.0 -> 9.39.1 (major)
  installed   cowsay 1.6.0 (here: 1.7.0)
  skipped     npm 10.0.0 (comes with Node)

2 to install, 1 already here, 1 skipped.
```

It only reads folders: the old Node and npm never run, so it works even when they're broken. `-> 5.9.3` is what `@latest` will install, and `(major)` flags a new major version, which can break things. Add `--json` for output a script or agent can read (see [llms.txt](llms.txt)).

## Reinstall them

```sh
npx reglobal                   # shows the list, asks, then runs one npm install --global
npx reglobal --dry-run         # show what it would run, install nothing
npx reglobal --yes             # don't ask (scripts and agents)
npx reglobal --keep-versions   # the same versions as before, not the latest
npx reglobal -i                # tick and untick packages in a checklist first
npx reglobal --skip eslint     # leave some out (or --only typescript,pnpm)
```

At the question, answer `e` to type the names of the ones to leave out. `--offline` skips the version lookup.

npm and corepack are left alone, since they come with Node. Packages from git come back from git. `npm link` folders and packages installed from a local file are listed, not reinstalled.

Exit codes: `0` done, `1` error, `2` nothing to install, `3` cancelled.

## License

MIT
