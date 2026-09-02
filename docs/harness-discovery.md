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

## Windows and WSL boundaries

OMP's native Windows installer writes `%LOCALAPPDATA%\omp\omp.exe`, which is checked explicitly so Refresh works even when the running GUI still has the old `Path` snapshot. Native `pi.exe` releases are discoverable through `Path` or an explicit override.

Pi's and Prime Agent's official npm installs on Windows create `pi.cmd` and `prime-agent.cmd` shims (Prime via `npm install -g` of the release tarball, whose `bin` is `dist/bundle/cli.js`) instead of native executables. GooeyPi recognizes only those shims declared on the harness descriptor, verifies the fixed entrypoint beneath the npm prefix (`@earendil-works/pi-coding-agent/dist/cli.js`, `prime-agent/dist/bundle/cli.js`), finds a runnable `node.exe`, and launches the entrypoint directly without a command shell. OMP does not document a Windows package-manager install so it has no shim. Community forks or other layouts (for example a `prime-agent.cmd` outside an npm prefix) are not recognized, use the explicit override with a native executable instead.

A Windows app also does not treat an executable inside a WSL distribution as a native Windows path. WSL execution requires an explicit transport, distribution selection, Windows/Linux cwd conversion, and Linux-owned session roots. If GooeyPi itself runs as a Linux application under WSLg, normal Linux discovery applies.
