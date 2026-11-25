# Security

## Reporting a vulnerability

Please don't open a public issue. Report it privately through GitHub: on the repository's **Security** tab, choose **Report a vulnerability**. You should hear back within a week.

## Supported versions

Fixes go into the latest release only.

## What reglobal does that matters for security

- It runs `npm install --global` with the names and URLs it found, and npm runs those packages' install scripts. With `import`, they come from a file: only import files you trust.
- To show `@latest`, it sends package names, never a token, to the registry npm would install each one from, read from `npm_config_*` variables and the npmrc files. `--offline` turns that off.
- It never runs the old Node or npm. It reads their folders.
