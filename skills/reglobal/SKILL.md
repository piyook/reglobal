---
name: reglobal
description: Reinstall the global npm packages from an older Node version into the current one with the reglobal CLI. Use when the user has upgraded or switched Node (fnm, nvm, nvm-windows, mise, asdf, n) and their global commands are missing.
---

# Moving global packages to a new Node version with reglobal

1. Find the old and new versions (the user's words, or `node --version` for the one in use). `reglobal <old> <new>` moves from one to the other; with only `<old>`, it installs into the Node in use.
2. Preview with `reglobal 24 26 --dry-run --json`. Nothing is installed. Exit `2` means there is nothing to install.
3. Show the user the `plan`: each package with its old `version` and the `latest` it will get (at `@latest` unless `--keep-versions`). Point out every `"majorUpdate": true`, since a new major version can break things, and every entry in `warnings`: npm links and packages from a local file are not reinstalled, and git packages come back from git. Ask which, if any, to leave out.
4. Run the same command with `--yes` in place of `--dry-run`, adding `--skip a,b` for the ones left out (or `--only a,b`). Report `installed`, and `failed` if it isn't empty. Never pipe `y` into the prompt, and don't use `-i`: it's a checklist for a person at a terminal.

For a new machine, or when the old version is gone: `reglobal export globals.json` on the old one (add `--yes` only if the user agrees to overwrite an existing file), then `reglobal import globals.json --dry-run --json` and steps 3 and 4 on the new one.

If it exits 1 with `NO_OLD_VERSION` or `NOT_FOUND`, the message lists the versions it found; for another manager, pass `--from <path to that version's folder>`. `reglobal --list --json` is the read-only comparison.

The full reference (options, JSON shape, exit codes) is `llms.txt`.
