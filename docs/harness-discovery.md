# Harness discovery

GooeyPi discovers Pi-family harnesses without invoking a shell or evaluating shell startup files. This keeps startup bounded and makes detection independent of whether the user prefers bash, zsh, fish, or no interactive shell at all.

## Resolution order

Each refresh checks, in order:

1. The absolute executable override saved in Harness settings.
2. The harness-specific environment override (`PRIME_AGENT_BINARY`, `OMP_BINARY`, or `PI_BINARY`).
3. Packaged application resources, when that harness can be bundled.
4. Absolute directories in the process `PATH`/`Path` snapshot.
5. Official harness-specific installer locations.
6. Shared system and package-manager locations for npm, Bun, pnpm, mise, Volta, Homebrew, and Linuxbrew. NVM version-manager directories are bounded to 64 entries and sorted by descending version.

Candidates are deduplicated and must be executable. GooeyPi then runs a bounded `--version` probe with no shell; only an exit-zero candidate is published to the renderer. A broken override therefore falls through to later automatic candidates, but its own missing, permission, spawn, exit, timeout, or output-limit reason is retained for the settings card. If no candidate works, the card reports the configured override's reason when present, otherwise the last probed candidate's reason. Probe stderr is control-character-stripped and byte-capped before it crosses IPC.

The relevant upstream install layouts are documented by [Pi](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/README.md), [OMP](https://github.com/can1357/oh-my-pi), [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent#readme), [npm](https://docs.npmjs.com/files/folders.html), [Bun](https://bun.sh/docs/installation), [pnpm](https://pnpm.io/settings/other#globalbindir), [mise](https://mise.jdx.dev/dev-tools/shims.html), and [Volta](https://docs.volta.sh/guide/getting-started).

## Prime Agent: TypeScript and Rust builds

Prime Agent shipped as a TypeScript CLI through 0.9.8 and as a Rust rewrite from the 0.9.9 betas on; 0.10.0 is the first stable Rust release. Both are called `prime-agent` and share `~/.prime/agent` (sessions, `auth.json`, `models.json`, settings), so discovery classifies the published executable and records the result as the Prime status `implementation`. The Settings card shows it next to the version, for example `v0.10.0 · Rust`.

### Layouts

- **Rust installer.** `install-rust.sh`, which `prime-agent update` also runs, writes a `/bin/sh` launcher at `$PRIME_AGENT_RUST_PREFIX/bin/prime-agent` (default `~/.local/bin`, a shared candidate) that executes the payload at `<prefix>/share/prime-agent/prime-agent`. It replaces a TypeScript install's public `~/.local/bin/prime-agent` and keeps the old tree under `share/prime-agent-legacy`.
- **TypeScript installs.** The native installer's `${XDG_DATA_HOME:-~/.local/share}/prime-agent-node/current/bin` (a Prime descriptor candidate) and npm installs whose `bin` is `prime-agent/dist/bundle/cli.js`.
- **npm bridge.** From 0.10 the npm package `prime-agent` is a launcher that migrates the install to the Rust build. Until its per-version receipt (`<prefix>/share/.prime-agent-npm-bridge/<version>`) and the Rust payload exist, every launch, `--version` included, runs the full Rust installer. GooeyPi reads the same receipts without running it. A migrated bridge is probed normally (its fast path runs the Rust payload). A bridge with a failed receipt runs its bundled TypeScript 0.9.8 fallback and classifies as TypeScript. An unmigrated bridge is never executed: the card asks the user to run `prime-agent` once in a terminal. The bridge exists for macOS and Linux only.

### Classification

1. The `--version` token decides when it parses as `major.minor.patch` (a prerelease suffix is ignored): 0.9.9 or later is Rust, anything earlier is TypeScript. This covers every published build without another process.
2. Only an unreadable version pays for a feature probe: `prime-agent --extension <path in a fresh private directory, never created> --version`. TypeScript accepts the flag and loads nothing for `--version` (exit 0); Rust exits on the unknown option.
3. An inconclusive probe counts as Rust. Leaving out `--extension` only drops capabilities, visibly, while passing it to Rust is fatal.

Discovery runs at startup and on Refresh. A start that used TypeScript argv and failed with Rust's `Unknown option: --extension` (for example after `prime-agent update` while GooeyPi was open) refreshes discovery once and retries once, with the Rust adapter if Prime now classifies as Rust. The main process then signals the window, which runs the same Refresh, so Settings, Capabilities, Scheduled and the composer show the new build without a manual Refresh.

### What the classification changes

Both builds start as `prime-agent --mode rpc --cwd <dir>` plus `--resume <session file>`, `--provider <id> --model <id>` and `--thinking <level>` when set, and one `--skill` for each GooeyPi skill the runtime is offered (schedules, browser, computer use). TypeScript Prime also gets one `--extension <file>` for each GooeyPi capability extension (browser, ask user, session collaboration). Rust Prime gets no `--extension`, and its environment carries no broker token for a capability it cannot load. An unclassified Prime keeps the TypeScript argv, which stays byte-identical for 0.7 to 0.9.

Not offered on Rust Prime, and labelled on the Settings card and the Capabilities page; Pi and OMP keep them:

- browser control, ask user and session collaboration (they ship as TypeScript extensions);
- fast mode (0.10 RPC has no service-tier command, so the composer offers no Fast toggle, even before a runtime starts);
- user and project TypeScript extensions (0.10 packages provide only skills, prompts and themes).

Scheduled tasks (a Python skill) and computer use work on both builds. Other Rust behavior GooeyPi adapts to:

- **Events.** 0.10 RPC never emits `session_action_update`, so the queue is rebuilt from `get_state`, and a queued steer is settled when Rust delivers it as a user message, before its answer streams. Rust sends `agent_end` before it clears its streaming flag, so GooeyPi takes `agent_end` as the end of the run: the active turn leaves the queue snapshot at once, and until the next `agent_start` a `get_state` that still reports the run changes neither the streaming flag nor the active turn (GooeyPi asks again every 150 ms for up to 2 s to pick up the queue the run left). A provider error just ends the run; GooeyPi reads it from `agent_end` and shows a failed turn.
- **Models.** The catalog comes from Rust Prime itself, not from GooeyPi's bundled TypeScript 0.7 registry: a short-lived `prime-agent --mode rpc --no-session` answers `get_available_models` (the probe Pi's catalog uses, without `--offline`, with a 30 s limit because Rust refreshes its live catalog and a team's private models before it answers). Only models Rust has credentials for are listed, so 0.10 models can be selected and 0.7 ids that 0.10 dropped are refused before a start. Thinking levels follow Rust's rule (a wired thinking-level map counts even without the reasoning flag), no model claims fast mode, and the catalog version is the CLI's own. Provider rows still come from GooeyPi's auth store, including providers without models so a key or login can be added. Saving a key, logging out or a finished login probes again at once. GooeyPi never runs the bundled registry's model refresh on Rust, so it no longer rewrites `prime-inference-private-models.json` in TypeScript's format. Keys and logins are written to `auth.json` as before; 0.10 reads those entries.
- **Credentials.** Rust reads Prime Inference keys from `auth.json` and the environment only, so GooeyPi does not count the Prime CLI's `~/.prime/config.json` and never rewrites it on logout. The choice is made at startup.
- **Heartbeats.** 0.10 RPC has no heartbeat commands. A stop runs `prime-agent schedule cancel <id>`; pause and resume need Prime's background service, so the Scheduled page disables them and shows that explanation (the main process still refuses them with it). `rlm_heartbeat` never fires under the in-process RPC (checked against 0.10.0: a one-minute heartbeat was stored in the agent directory's `cron-jobs.json` and had not run after 150 s), so the schedules skill points agents at a `current_session` schedule instead.
- **Rename.** For a session with no GooeyPi runtime, `prime-agent rename` would wake a daemon worker whose lease blocks GooeyPi's `--resume` for up to 90 minutes. GooeyPi uses the CLI only when a resident worker already holds the session and otherwise asks the user to send the session a message first, which starts a runtime that renames it directly.

## Windows and WSL boundaries

OMP's native Windows installer writes `%LOCALAPPDATA%\omp\omp.exe`, which is checked explicitly so Refresh works even when the running GUI still has the old `Path` snapshot. Native `pi.exe` releases are discoverable through `Path` or an explicit override.

Pi's and Prime Agent's official npm installs on Windows create `pi.cmd` and `prime-agent.cmd` shims (Prime via `npm install -g` of the release tarball, whose `bin` is `dist/bundle/cli.js`) instead of native executables. GooeyPi recognizes only those shims declared on the harness descriptor, verifies the fixed entrypoint beneath the npm prefix (`@earendil-works/pi-coding-agent/dist/cli.js`, `prime-agent/dist/bundle/cli.js`), finds a runnable `node.exe`, and launches the entrypoint directly without a command shell. OMP does not document a Windows package-manager install so it has no shim. Community forks or other layouts (for example a `prime-agent.cmd` outside an npm prefix) are not recognized, use the explicit override with a native executable instead. That includes the Rust build's Windows installer (`install.ps1`), whose `bin\prime-agent.cmd` launcher is not an npm shim: point the override at its payload, `<prefix>\share\prime-agent\prime-agent.exe`.

A Windows app also does not treat an executable inside a WSL distribution as a native Windows path. WSL execution requires an explicit transport, distribution selection, Windows/Linux cwd conversion, and Linux-owned session roots. If GooeyPi itself runs as a Linux application under WSLg, normal Linux discovery applies.
