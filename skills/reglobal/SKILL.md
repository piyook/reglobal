---
name: reglobal
description: Reinstall the global npm packages from an older Node version into the current one with the reglobal CLI. Use when the user has upgraded or switched Node (fnm, nvm, nvm-windows, mise, asdf, n) and their global commands are missing.
---

# Moving global packages to a new Node version with reglobal

1. Make sure the new Node version is the one in use (`node --version`). reglobal installs into the Node that runs it.
2. Preview with `reglobal --dry-run --json`, or `reglobal --dry-run --json --from 24` to name the old version. Nothing is installed. Exit `2` means there is nothing to install.
3. Show the user the `plan` (what will be installed, at `@latest` unless `--keep-versions`) and every entry in `warnings`: npm links and packages from a local file are not reinstalled, and git packages come back from git. Get their agreement.
4. Run the same command with `--yes` in place of `--dry-run`. Report `installed`, and `failed` if it isn't empty. Never pipe `y` into the prompt.

If it exits 1 with `NO_OLD_VERSION` or `NOT_FOUND`, the message lists the versions it found; for another manager, pass `--from <path to that version's folder>`. `reglobal --list --json` is the read-only comparison.

The full reference (options, JSON shape, exit codes) is `llms.txt`.
