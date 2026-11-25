---
name: reglobal
description: Reinstall the global npm packages from an older Node version into the current one with the reglobal CLI. Use when the user has upgraded or switched Node (fnm, nvm, nvm-windows, mise, asdf, n) and their global commands are missing.
---

# Moving global packages to a new Node version with reglobal

Work in progress: only the read-only list works so far.

1. Make sure the new Node version is the one in use (`node --version`).
2. Run `reglobal --list --json`, or `reglobal --list --json --from 24` to name the old version. It changes nothing.
3. Show the user the packages with `"status": "install"`, and point out every entry in `warnings` (npm links and packages from git or a file are not reinstalled from the registry).

If it exits 1 with `NO_OLD_VERSION` or `NOT_FOUND`, the message lists the versions it found; for another manager, pass `--from <path to that version's folder>`.

The full reference (options, JSON shape, exit codes) is `llms.txt`.
