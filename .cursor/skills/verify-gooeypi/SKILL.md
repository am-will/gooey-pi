---
name: verify-gooeypi
description: Launch and drive the GooeyPi desktop (Electron) app to prove user-facing behavior — sidebar navigation, Settings, and Capabilities — capturing screenshots and ARIA snapshots. Reach for this when verifying a GooeyPi UI change or confirming the app still works end to end.
---

# Verify GooeyPi

GooeyPi is a **desktop Electron app** — that window is the only surface a user
touches (there is no user-facing web page, CLI, or API). This skill launches the
built app in an isolated, disposable profile, drives one user-facing feature the
way a person would, and captures evidence. The driver mirrors the repo's own
Playwright Electron harness (`tests/e2e/app.spec.ts`) but runs as a standalone
controller you can invoke directly.

The maintained feature list lives in [`features/`](./features/README.md); read
its index before driving, then use the matching feature file as the recipe.

## Launch

- **Rebuild before verification.** Run `npm run build` after source changes.
  The driver launches `out/main/index.js` and does not rebuild it.
- **Toolchain.** Select the toolchain described in the
  [validation guide](../../../docs/validation.md#reproducible-setup).
- **Display.** Linux needs an X display. On headless Linux, prefix commands
  with `xvfb-run -a`. macOS and Windows use their native desktop session.
- **Isolation.** Every drive launches its own app instance with a throwaway
  `HOME` and Electron `--user-data-dir`. It replaces XDG and Windows profile
  locations and omits inherited harness overrides, Node version managers, and
  credential variables. It does not read or write your real
  `~/.prime` / `~/.omp` / `~/.pi` state and never drives an instance it did not
  start. Readiness is `.app-shell[data-ready="true"]`. A fresh `HOME` has no
  configured sessions. The driver dismisses the `No Pi family harness detected`
  modal when it appears. System-wide harness binaries may still be detected.
- **Command.** `node .cursor/skills/verify-gooeypi/control.mjs drive <scenario> --out <dir>`

## Doctor

Answer "is this instance worth driving?" before anything else, or whenever the
app looks wrong:

```
node .cursor/skills/verify-gooeypi/control.mjs doctor --out /tmp/gooeypi-verify/doctor
```

It launches the app, asserts `.app-shell[data-ready="true"]`, prints the window
title (expect `GooeyPi`), and screenshots. A non-zero exit means the build is
broken or the app never became ready — fix that before driving features.

## Drive

- **Harness:** Playwright's `_electron` driving the built app. Prefer stable
  handles over coordinates: sidebar items are buttons with accessible names
  `New session`, `Search`, `Projects`, `Activity`, `Scheduled`, `Capabilities`;
  each page asserts its level-1 heading; Settings opens from the
  `.sidebar__footer` `Settings` button and lands on the `General` heading, with
  sections as buttons named `Appearance`, `Pets`, `Harness`, etc.
- **Scenarios:** `node .cursor/skills/verify-gooeypi/control.mjs list` →
  `navigation`, `settings`, `capabilities`. Each is one self-contained
  launch → drive → capture → teardown. The [feature map](./features/README.md)
  documents these plus features (session messaging) that need the repo's
  hermetic fixture rather than this driver.

## Evidence

- Each scenario writes PNG screenshots and `.aria.txt` ARIA snapshots to
  `--out DIR` (default `/tmp/gooeypi-verify/<scenario>-<timestamp>`) and prints a
  `PROVEN:` list of the assertions it checked.
- **Proof standard:** drive the real user path and capture both the action and
  the resulting page state (heading + ARIA), not just a final screen. For a
  mutation (creating a schedule or sending a message), also verify the side
  effect — a file written under the harness `HOME`, or a second read-only view —
  not just a toast. Record the feature ID and the entry point used.
- Artifacts survive teardown. Copy any you want to keep into
  `/opt/cursor/artifacts` for a PR walkthrough.

## Cleanup

- The driver closes only the app instance it launched and removes only the
  throwaway fixture `HOME`/`user-data-dir` it created. It never deletes evidence
  dirs. **Never** kill Electron by name (`pkill electron`); the driver owns its
  own child process and tears it down.

## Helpers

- [`control.mjs`](./control.mjs) (executable). Subcommands: `doctor`,
  `drive <scenario>`, `list`. Invoke exactly as shown above; run under
  `xvfb-run` on headless Linux.
