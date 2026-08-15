# Validation status

## Protected `main` validation contract

The repository's `main` branch protection must require pull requests and require status checks to pass with **Require branches to be up to date before merging** enabled (`required_status_checks.strict: true`). This strict latest-main requirement prevents a PR from merging on a newer base than the integration state validated by CI.

The required checks are exactly the six normal pull-request gates:

- `quality`
- `hermetic-e2e`
- `windows-state-migration`
- `packaging-smoke (macos-14, mac, arm64, --config.mac.identity=null)`
- `packaging-smoke (ubuntu-22.04, linux, x64)`
- `packaging-smoke (windows-2022, win, x64)`

Do not require `local-qa-package`: it is manual local QA, runs only through `workflow_dispatch`, and is intentionally excluded from pull-request validation.

GitHub merge queues are not available to this public repository while it is owned by a personal account. Consequently, `merge_group` or a required merge queue cannot enforce this policy here; strict up-to-date branch protection is the supported latest-main control. If the repository moves to an organization, merge-queue support should be designed and tested separately before enabling it.

An authorized maintainer can verify the active legacy branch protection and exact required-context set with:

```sh
gh api repos/am-will/gooey-pi/branches/main/protection \
  --jq '{strict: .required_status_checks.strict, contexts: .required_status_checks.contexts, reviews: .required_pull_request_reviews}'
```

Last full local validation: 2026-08-06 on Apple Silicon macOS.

| Gate | Result |
|---|---|
| `npm run typecheck` | Pass — Node and renderer TypeScript |
| `npm test` | Pass — 33 tests across 12 backend/protocol/security suites |
| `npm run test:e2e` | Pass — 9 Electron tests |
| `npm run build` | Pass — main, CommonJS sandbox preload, renderer |
| Full `npm audit` | Pass — 0 known vulnerabilities |
| Real Prime RPC handshake/default-model discovery | Pass against Prime Agent 0.7.0 |
| RPC response correlation and failure propagation | Pass, including mismatched/negative/failed-handshake cases |
| Real PTY command/project cwd/background-descendant cleanup | Pass |
| Git status/diff/stage/unstage/restore/commit/detached HEAD | Pass in isolated repositories |
| Project file tree/removal/trust boundaries | Pass, including symlink/generated-tree exclusion and inferred dismissal |
| Package/MCP validation and settings locking | Pass |
| Streaming event reconstruction and safe Markdown | Pass |
| Browser navigation/history/isolated guest | Pass; no `ERR_ABORTED` race |
| Download policy | Pass — gesture/protocol, 512 MiB item, 3 concurrent, 1 GiB/hour bounds; guest/reset/quit cancellation |
| Responsive overlays/resizable panels/dark mode/modal focus | Pass |
| Last-window close/reopen | Pass |
| Hostile RPC child TERM/KILL shutdown and admission closure | Pass |
| Agent/PTY event bytes, aggregate bytes, rates, and IPC chunks | Pass |
| `npm run package:mac` | Pass — arm64 app, DMG, ZIP |
| `codesign --verify --deep --strict` | Pass |
| Electron fuse policy | Pass — RunAsNode/NODE_OPTIONS/inspect/file-protocol privilege disabled; ASAR integrity and OnlyLoadAppFromAsar enabled |
| Native package allowlist | Pass — unpacking is limited to node-pty's `pty.node`/`spawn-helper` and the package architecture's ZeroMQ addon; the post-package gate rejects missing or extra paths and architecture-incomplete Mach-O files |
| Build bundle budgets | Pass — main ≤640 KiB, preload ≤16 KiB, initial renderer entry plus modulepreloads ≤1,280 KiB, every renderer JS/CSS chunk ≤600 KiB, total renderer JS/CSS ≤2.25 MiB |
| Package size budgets | Pass — `app.asar` ≤220 MiB, app regular-file bytes ≤480 MiB, DMG ≤190 MiB, ZIP ≤185 MiB |
| Packaged custom `prime-work://` renderer | Pass — normal on-screen launch and Apple quit |
| Prime Dock/App Switcher icon | Pass — runtime PNG hash equals `assets/icon.png`; bundle uses `icon.icns` |
| Apple notarization / public Gatekeeper assessment | Not run — Developer ID/notarization credentials are not stored in the repository |

Electron 43.3.0 was published roughly one day before this validation, but the host's intentional npm three-day package-age gate does not yet admit it. Electron 43.2.0 has a zero-vulnerability audit; the newly patched API is not used here. Re-run the upgrade and complete Developer-ID notarization before public distribution.
