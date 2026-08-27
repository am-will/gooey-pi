# Repository engineering guidance

## File size

Keep handwritten production files at or below 750 lines when practical. Treat 750 lines as a review threshold, not a reason to create arbitrary wrapper modules or split cohesive logic.

When changing an existing production file above the threshold, avoid increasing its size unless the change cannot be separated without weakening cohesion. Prefer extracting a complete responsibility with a narrow interface, and explain any intentional exception in the pull request.

This threshold does not apply to tests, generated files, vendored code, lockfiles, fixtures, or data assets. Correctness, security boundaries, and maintainable ownership take precedence over line count.

## Cloud Agent environment

Cloud Agents provision this repo with [`.cursor/environment.json`](.cursor/environment.json),
whose `install` step runs [`.cursor/install.sh`](.cursor/install.sh) on Cursor's
default Ubuntu image. That script pins Node via `.nvmrc` (24.15.0) with `nvm`,
installs the Electron/xvfb system libraries, bootstraps the repo-pinned npm, and
runs `npm ci`. Canonical toolchain and check commands live in
[`docs/validation.md`](docs/validation.md); do not restate versions here.

`node`/`npm` come from `nvm`. A harness shell can be shadowed by another `node`
on `PATH`, so select the pinned toolchain before running `node`/`npm` if `node
-v` is not `v24.15.0`:

```
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use >/dev/null
```

GooeyPi is a GUI Electron app with no background services, so there is nothing to
auto-start. To run the app or the Playwright Electron e2e suite headlessly, wrap
the command with a virtual display:

```
xvfb-run -a npm run dev              # launch the desktop app
xvfb-run -a npm run test:e2e:hermetic # build + hermetic Electron e2e
```

Some xterm/PTY-driven e2e cases in `tests/e2e/app.spec.ts` are timing-sensitive
under headless `xvfb` and can fail where they pass on the macOS CI runner that
owns the `hermetic-e2e` gate.

## pstack

This repository vendors [pstack](https://github.com/cursor/plugins/tree/main/pstack) under `.agents/skills/pstack/` so Cloud Agents can run `/poteto-mode` and the rest of the skill set. Subagents live in `.cursor/agents/`. Per-role model overrides live in `.cursor/rules/pstack-models.mdc`.

pstack skills read `~/.cursor/rules/pstack-models.mdc`. Cloud Agents do not inherit that user-level path. If it is missing, copy the workspace rule before running a pstack skill:

```
mkdir -p ~/.cursor/rules
cp .cursor/rules/pstack-models.mdc ~/.cursor/rules/pstack-models.mdc
```

Re-run `/setup-pstack` to change role models. Only write Task `model` slugs that are available in the current session.
