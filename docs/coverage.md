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

[`coverage-inventory.test.ts`](../tests/coverage-inventory.test.ts) locks the family roots, required safety modules, shipped extension set, configured global thresholds, per-family threshold declarations, automatic new-file enrollment, and exclusion validation. It also launches the explicit config from a foreign working directory and runs a real nested coverage fixture proving that the unexecuted, inventoried files `@(authority).ts`, `{authority,other}.ts`, and `authority[.].ts` all appear in `coverage-summary.json`.

## Coverage thresholds and limits

[`vitest.config.ts`](../vitest.config.ts) defines the global thresholds.
[`coverage-inventory.ts`](../scripts/release/coverage-inventory.ts) defines each
family's thresholds and `REQUIRED_SAFETY_COVERAGE` records exact-file safety
floors or an explicit worker classification. These files are the source of truth for the current
values. Update a floor only from coverage measured at the commit under review.

The safety registry includes the RPC manager and bounded child-history reader.
The `c8ef035` passing source report supplies the measured baseline. File floors
reserve five percentage points for branches and two for the other metrics;
family floors reserve two, while stronger existing floors remain in force.
Exact-file floors overlap family and global gates; matching a file never removes
it from an aggregate. Structural tests keep every required module classified,
and a real nested coverage fixture proves that overlap behavior.

`recurrence-worker.ts` is the sole worker-compensated safety module. Its real
Worker execution runs outside the parent Vitest V8 collection. The source
remains included and contributes its reported zero to the denominator. The
registry links the actual worker fixture and bounded evaluation/recovery tests.
Packaged ASAR Worker loading is verified separately and recorded in release
evidence; a parent-process coverage percentage does not establish that behavior.

Renderer components and pages under `src/components` and `src/pages` are outside
the coverage inventory. Their component tests and Electron scenarios still run,
but their source files do not contribute to the reported coverage denominator.
The `src/app`, `src/lib`, and `src/hooks` families measure renderer authority and
shared logic.

Coverage is reported with `reportOnFailure: true`, so the report and every threshold are still evaluated when unrelated tests fail; a failing suite can never silently skip the gate.

Some release CLI entry points and recurrence-worker paths run in bounded child processes or workers, whose V8 data is not merged into the parent Vitest report. They remain in the denominator as uncovered code instead of receiving exclusions. This makes the aggregate conservative and ensures growth in those entry points consumes coverage headroom.

When changing a family, reporter, threshold, or technical exclusion, repeat the before/after denominator, artifact-size, and wall-clock measurement and place commit-addressed pass evidence in the pull request or release record as described in the [validation guide](validation.md#recording-evidence).
