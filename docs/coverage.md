# Safety-critical coverage gate

GooeyPi's coverage denominator is a filesystem inventory, not a hand-maintained list of selected modules. [`coverage-inventory.ts`](../scripts/release/coverage-inventory.ts) recursively enrolls runtime files from these first-party families:

| Family | Current responsibility |
|---|---|
| `electron/main` | IPC, loopback capability brokers, collaboration, schedules, project/store authority, package and MCP execution, process composition, and other main-process services |
| `electron/preload` | The isolated renderer capability bridge |
| `src/app` | Renderer state admission, reconciliation, scoping, and request routing |
| `src/lib` | Shared validation, event reduction, command policy, and bounded rendering logic |
| `src/hooks` | Renderer capability orchestration and live authority state |
| `scripts/release` | Toolchain, dependency, packaging, artifact, extension, and cross-platform release verification |
| `assets/extensions` | Every first-party extension shipped through Electron `extraResources` |

The inventory retains concrete repository-relative filenames and supplies [`vitest.config.ts`](../vitest.config.ts) with one glob-escaped exact include pattern per file. The config derives and fixes the project root from its own `import.meta.url`, so an explicit `--config` invocation has the same inventory and test resolution even when launched from another working directory. A new runtime file below any family root therefore enters the denominator on its first coverage run. Family roots are `lstat`-verified as real, non-symbolic-link directories before traversal; symbolic links below them, overlapping families, missing roots, and malformed inventory entries likewise fail configuration instead of silently removing code from measurement.

Technical exclusions can name only one exact discovered file. Each entry must include a substantive reason and at least one compensating verification; duplicate, undocumented, and stale entries fail the structural test. Directory and glob exclusions are not representable. There are currently **no technical exclusions**.

[`coverage-inventory.test.ts`](../tests/coverage-inventory.test.ts) locks the family roots, required safety modules, shipped extension set, unchanged thresholds, automatic new-file enrollment, and exclusion validation. It also launches the explicit config from a foreign working directory and runs a real nested coverage fixture proving that the unexecuted, inventoried files `@(authority).ts`, `{authority,other}.ts`, and `authority[.].ts` all appear in `coverage-summary.json`. Characterization tests exercise the previously unmeasured schedule executor, the complete frozen preload-to-IPC mapping, and broker calls from the Prime browser and shared collaboration extensions without external network access or production credentials.

## Issue #53 impact measurement

The following point-in-time measurement compares the exact reviewed base `2310fdb5b0c373ce87e534a77ab9ffa19149caac` with the issue #53 implementation. It was recorded on macOS arm64 with Node 24.19.0 and the repository-pinned npm 12.0.2. Both sides used `npm run test:coverage`, the same V8 reporters and thresholds, a warm dependency install, and `/usr/bin/time -p`; runtime is an observation, not a CI performance guarantee.

| Metric | Reviewed base | Expanded gate | Impact |
|---|---:|---:|---:|
| Modules in `coverage-summary.json` | 48 | 140 | +92 (+191.7%) |
| Statement denominator | 7,587 | 14,765 | +7,178 (+94.6%) |
| Branch denominator | 5,902 | 10,815 | +4,913 (+83.2%) |
| Function denominator | 1,301 | 2,893 | +1,592 (+122.4%) |
| Line denominator | 6,037 | 11,662 | +5,625 (+93.2%) |
| HTML/JSON artifact | 2,216 KiB / 67 files | 4,780 KiB / 164 files | +2,564 KiB / +97 files |
| Successful wall-clock coverage run | 25.50 s | 22.28 s (timed post-review pass; second consecutive success) | No observed material regression |

The expanded inventory currently contains 66 `electron/main`, 1 `electron/preload`, 6 `src/app`, 27 `src/lib`, 16 `src/hooks`, 18 `scripts/release`, and 6 `assets/extensions` modules. Two consecutive post-review runs reported 76.40–76.41% statements, 69.83–69.84% branches, 78.05% functions, and 81.94% lines against identical denominators. Thresholds remain 65% statements, 50% branches, 70% functions, and 75% lines.

Some release CLI entry points are deliberately exercised in bounded child-process tests, whose V8 data is not merged into the parent Vitest report. They remain in the denominator as uncovered code instead of receiving exclusions. This makes the aggregate conservative and ensures growth in those entry points consumes coverage headroom.

When changing a family, reporter, threshold, or technical exclusion, repeat the before/after denominator, artifact-size, and wall-clock measurement and place commit-addressed pass evidence in the pull request or release record as described in the [validation guide](validation.md#recording-evidence).
