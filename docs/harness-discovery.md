# Harness discovery

GooeyPi discovers Pi-family harnesses without invoking a shell or evaluating shell startup files. This keeps startup bounded and makes detection independent of whether the user prefers bash, zsh, fish, or no interactive shell at all.

## Resolution order

Each refresh checks, in order:

1. The absolute executable override saved in Harness settings.
2. The harness-specific environment override (`PRIME_AGENT_BINARY`, `OMP_BINARY`, or `PI_BINARY`).
3. Packaged application resources, when that harness can be bundled.
4. Absolute directories in the process `PATH`/`Path` snapshot.
5. Official harness-specific installer locations.
6. Shared system and package-manager locations for npm, Bun, pnpm, mise, Volta, nvm, Homebrew, and Linuxbrew.

Candidates are deduplicated and must be executable. GooeyPi then runs a bounded `--version` probe with no shell; only an exit-zero candidate is published to the renderer. A broken override therefore falls through to later automatic candidates.

The relevant upstream install layouts are documented by [Pi](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/README.md), [OMP](https://github.com/can1357/oh-my-pi), [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent#readme), [npm](https://docs.npmjs.com/files/folders.html), [Bun](https://bun.sh/docs/installation), [pnpm](https://pnpm.io/settings/other#globalbindir), [mise](https://mise.jdx.dev/dev-tools/shims.html), and [Volta](https://docs.volta.sh/guide/getting-started).

## Update checks

When **Check for harness updates** is enabled (Settings → Harness, on by default), GooeyPi periodically compares the discovered Pi version against the `latest` field of `https://registry.npmjs.org/@earendil-works/pi-coding-agent/latest`. A newer version shows on the Runtime card and raises a one-time toast per version. The Update button runs `pi update --self` — pi's own updater, with the discovered executable and a fixed argv — then re-runs discovery so the published version reflects the new binary. OMP and Prime Agent have no registry mapping yet and are reported as unsupported. Disabling the toggle stops all registry traffic.

## Windows and WSL boundaries

OMP's native Windows installer writes `%LOCALAPPDATA%\omp\omp.exe`, which is checked explicitly so Refresh works even when the running GUI still has the old `Path` snapshot. Native `pi.exe` releases are discoverable through `Path` or an explicit override.

Windows npm `.cmd` shims are intentionally not treated as native executables. Node cannot spawn them directly without a command shell, and GooeyPi's process boundary does not execute harnesses through a shell. Supporting them safely requires a structured Node-entrypoint launch target rather than command-string quoting.

A Windows app also does not treat an executable inside a WSL distribution as a native Windows path. WSL execution requires an explicit transport, distribution selection, Windows/Linux cwd conversion, and Linux-owned session roots. If GooeyPi itself runs as a Linux application under WSLg, normal Linux discovery applies.
