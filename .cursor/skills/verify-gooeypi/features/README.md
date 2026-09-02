# GooeyPi verification map

This directory is the maintained source for verifying the user-facing behavior
of GooeyPi (a desktop Electron app). Read this index before driving the app,
then use the matching feature file as the recipe. Keep it honest as the app
changes — a proof that drives one convenient entry point is incomplete when the
map lists others.

## Baseline preconditions

- The app is built (`out/main/index.js` exists); if not, run `npm run build`.
- `node -v` is `v24.15.0` (load nvm first if not: `. "$HOME/.nvm/nvm.sh"; nvm use`).
- A display is available; on a headless machine prefix commands with `xvfb-run -a`.
- Drives run against a throwaway `HOME` + Electron `--user-data-dir`, so the real
  `~/.prime` / `~/.omp` / `~/.pi` state is never touched.
- The driver dismisses the `No Pi family harness detected` modal automatically
  (a fresh `HOME` has no harness).
- Never drive an app instance this verification run did not start.

## Driving conventions

- Start every recipe from a fresh launch unless its preconditions say otherwise.
- Prefer roles and accessible names over CSS selectors or DOM position.
- Treat every command as literal. Keep quoted names and flags unchanged.
- Run scenarios through `node .cursor/skills/verify-gooeypi/control.mjs`.
- The driver removes the fixture it created and keeps every evidence artifact.

## Proof and skip reporting

- Capture the user action and the resulting page state (heading + ARIA), not
  only the final screen.
- UI proof includes a screenshot with the app identity visible and the `PROVEN:`
  assertion list from stdout.
- Mutation proof includes a second read-only view of the stored value (a file
  under the harness `HOME`, or the item re-read from the list).
- Record the feature ID and entry point used with every artifact.
- Report an unreachable path with the attempted command and the unmet
  precondition. Do not report a skipped entry point as verified through another.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the
user-visible behavior, then uses exactly four H2 sections in this order:

1. `Sub-features` — short IDs with one line each.
2. `How to get to it (user POV)` — every user entry point.
3. `Driving it with gooeypi-control` — starts with `Preconditions:` and pairs
   each user action with an exact command and observable result.
4. `Gotchas` — traps that can waste or invalidate a verification run.

## Features

- [Sidebar navigation](./navigation.md) — moving between Projects, Activity,
  Scheduled, and Capabilities and proving each route by its heading.
- [Settings](./settings.md) — opening Settings, switching sections, and closing.
- [Capabilities](./capabilities.md) — the capabilities/skills directory for the
  active harness.
- [Sessions and messaging](./sessions-and-messaging.md) — selecting a session
  and sending/queueing a prompt. Needs the repo's hermetic fixture (fake harness
  binaries); not drivable by `control.mjs` alone.
