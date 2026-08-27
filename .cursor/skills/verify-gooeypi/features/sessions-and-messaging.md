# Sessions and messaging

A user selects a persistent session and sends a prompt to the active harness;
while a turn runs they can queue a follow-up or steer the turn. This is the core
product loop, but it requires a working Pi/OMP/Prime harness — so it is driven by
the repo's hermetic Playwright fixture (which installs fake harness binaries),
**not** by `control.mjs`, whose disposable `HOME` has no harness.

## Sub-features

- `msg-select` selects a session from the sidebar list.
- `msg-send` sends a prompt via the composer and starts a turn.
- `msg-queue` queues a follow-up while a turn is running.
- `msg-steer` steers the running turn with `Ctrl+Enter`.

## How to get to it (user POV)

- Click a session row in the sidebar, then type in the composer (`Message Prime`
  / `Message OMP`) and press `Enter` to send.
- While the `Stop Prime` button is visible (turn running), press `Enter` to queue
  or `Ctrl+Enter` to steer.

## Driving it with gooeypi-control

Preconditions:

- A Pi-family harness is available. `control.mjs` cannot supply one, so this
  feature is **skipped by the standalone driver** and verified through the repo
  fixture instead.

- **Run the fixture path.** Use the repo's hermetic Electron suite, which sets
  `PRIME_AGENT_BINARY` / `OMP_BINARY` / `PI_BINARY` to fake executables and drives
  the composer. Run `xvfb-run -a npx playwright test tests/e2e/app.spec.ts -g "steers the active turn with Ctrl\\+Enter" --reporter=line`.
- **Observable proof.** The fake harness writes `steer-args.json` under the
  fixture root; the test asserts `{ type: 'steer', message: 'change direction now' }`,
  i.e. the mutation (the steer reaching the harness), not just on-screen text.
- To drive this manually with `control.mjs`, you would first need real or fake
  harness binaries on `PATH` inside the driver's `HOME`; until the driver grows
  a `--harness` fixture mode, prefer the Playwright path above.

## Gotchas

- With no harness, GooeyPi shows `No Pi family harness detected` and the composer
  is disabled — messaging cannot be proven; report it skipped with this reason,
  do not substitute the navigation scenario as evidence.
- A queued/steered message is only proven by its side effect (the marker file the
  harness receives), not by the composer clearing or a message bubble appearing.
- The composer accessible name is harness-specific (`Message Prime` vs
  `Message OMP`); match the active harness shown in the top-left switcher.
