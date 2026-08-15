# Validation guide

This page explains how to reproduce and interpret GooeyPi's validation gates. It is not a status report. A passing command or workflow is evidence only for the exact commit, runner, inputs, and credentials that produced it; do not infer that the current branch is green from this document.

## Sources of truth

| Concern | Authoritative definition |
|---|---|
| Pull-request, `main`, and manual CI | [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) |
| Tagged public releases | [`.github/workflows/release.yml`](../.github/workflows/release.yml) |
| Production-dependency gates | PR heads and `main`: [`.github/workflows/ci.yml`](../.github/workflows/ci.yml); pinned releases: [`.github/workflows/release.yml`](../.github/workflows/release.yml); weekly/manual disclosure checks: [`.github/workflows/audit.yml`](../.github/workflows/audit.yml) |
| Aggregate commands and toolchain policy | [`package.json`](../package.json) and [`.nvmrc`](../.nvmrc) |
| Resolved dependency graph | [`package-lock.json`](../package-lock.json) |
| Dependency-install lifecycle | [`package.json`](../package.json) and [`install-app-deps.mjs`](../scripts/release/install-app-deps.mjs) |
| Package and post-package guarantees | [`scripts/release/package.mjs`](../scripts/release/package.mjs), [`verify-package.mjs`](../scripts/release/verify-package.mjs), and [`verify-cross-platform-package.mjs`](../scripts/release/verify-cross-platform-package.mjs) |
| Audit policy and accepted risk | [`docs/security.md`](security.md), [`audit-production.mjs`](../scripts/release/audit-production.mjs), and [`audit-exceptions.json`](../scripts/release/audit-exceptions.json) |
| Safety-critical coverage membership and exclusions | [`docs/coverage.md`](coverage.md), [`coverage-inventory.ts`](../scripts/release/coverage-inventory.ts), and [`vitest.config.ts`](../vitest.config.ts) |

Read these files at the commit being validated. Job names, test inventory, dependency versions, budgets, and artifact matrices can change; copying their current values into a permanent pass/fail table would create another stale snapshot.

## Reproducible setup

The repository derives its Node and npm policy from checked-in metadata. `package.json#engines`, `package.json#packageManager`, and `.nvmrc` must agree; release entry points reject unsupported, malformed, or prerelease tool versions. With `nvm`, prepare a checkout as follows:

```bash
nvm install
nvm use
npm run toolchain:bootstrap
npm ci
npm run release:preflight:toolchain
```

Run `toolchain:bootstrap` before installing project dependencies. It installs the `packageManager`-pinned npm into the invoked npm's validated global prefix, verifies the exact installed JavaScript CLI with the active Node executable, and publishes the matching shim directory to later GitHub Actions steps. This is necessary because the npm bundled by `actions/setup-node` can be older than the repository's npm floor.

`npm ci` runs the shared `postinstall` entry point. That entry point installs Electron's platform runtime synchronously before asking Electron Builder to rebuild native dependencies, so parallel test workers do not race Electron's lazy downloader. `npm ci --ignore-scripts` intentionally skips both operations; follow the recovery sequence in the [source setup instructions](../README.md#run-from-source) before running or packaging the application.

Do not hard-code the current Node, npm, or Electron version in validation notes. Record the values observed for the tested commit instead.

## Pull-request and branch CI

The [CI workflow](../.github/workflows/ci.yml) runs on pull requests, pushes to `main`, and manual dispatch. Each Node job bootstraps the repository npm before `npm ci` and executes the toolchain-only release preflight after installation.

| Job | When it runs | What a pass establishes |
|---|---|---|
| `production-audit` (`Production dependency audit`) | Pull request, `main`, manual dispatch | The exact PR head or branch commit has no unexpected, expired, or stale high/critical production-advisory state under the checked-in exception policy. |
| `quality` | Pull request, `main`, manual dispatch | TypeScript checks; configured lint and format checks; the coverage suite and thresholds; production bundle creation; bundle-size budgets; coverage artifact upload. |
| `hermetic-e2e` | Pull request, `main`, manual dispatch | The built application passes the Playwright Electron suite on the pinned macOS runner without relying on developer state. Failure artifacts are uploaded when available. |
| `windows-state-migration` | Pull request, `main`, manual dispatch | The state migration suite passes on a real `windows-2022` runner, including the production-platform fresh-install, migration, restart, and update path. Simulating `platform: 'win32'` on another OS is useful unit coverage but is not a substitute for this job. |
| `packaging-smoke` | Pull requests only | Native macOS arm64, Linux x64, and Windows x64 runners can build unpacked application directories. Linux and Windows additionally verify the ASAR layout and exact native-unpack allowlist. These are unsigned smoke builds, not public installers. |
| `local-qa-package` | Manual dispatch only | Native runners create and verify installable local-QA artifacts for macOS, Linux, and Windows, then upload the configured artifact set. These artifacts are not represented as signed or notarized public releases. |

Expected skips are part of this design:

- `local-qa-package` is expected to be skipped on pull requests and pushes to `main`.
- `packaging-smoke` is expected to be skipped on pushes to `main` and manual dispatches because its condition is pull-request-only.

`windows-state-migration` is required for every CI trigger listed above; a skip is not expected.

A green PR packaging matrix does not prove Developer ID signing, Apple notarization/stapling, Gatekeeper acceptance, Authenticode identity, installer integrity, or the complete public artifact matrix. Those belong to the release workflow.

## Local aggregate commands

Use focused tests while developing, then choose the aggregate that matches the claim you need to make. The command definitions in [`package.json`](../package.json) remain authoritative.

| Command | Scope |
|---|---|
| `npm run release:verify:package` | Toolchain preflight, typecheck, configured code checks, coverage tests, production bundle, and bundle-size gate. It does not create an installer or run Electron E2E. |
| `npm run release:verify` | The package-verification aggregate above plus the hermetic Electron E2E suite. |
| `npm run test:e2e` | Builds the application, then runs the hermetic Electron E2E suite. |
| `npm run audit:production` | Fetches npm's production audit report and applies the repository's high/critical advisory and exception policy. Network access is required. |
| `npm run package:mac:local-qa` | On macOS, runs the relevant verification aggregate, creates unsigned/unnotarized DMG and ZIP artifacts, and applies macOS post-package checks in QA mode. |
| `npm run package:linux:local-qa` | On Linux, runs the package-verification aggregate, creates the configured Linux artifacts, and verifies their runtime layout in QA mode. |
| `npm run package:win:local-qa` | On Windows, runs the package-verification aggregate, creates the configured Windows artifacts, and verifies their runtime layout in QA mode. |

Packaging is native: run each platform command on its matching operating system and architecture. The public `package:mac`, `package:linux`, and `package:win` commands use distribution mode; macOS and Windows distribution checks require their external signing configuration. A successful local-QA command must not be described as a public trust check.

## Dependency audit policy

The exception-aware audit is a dedicated `Production dependency audit` job in both [pull-request CI](../.github/workflows/ci.yml) and the [release workflow](../.github/workflows/release.yml). CI checks out the exact PR head, while release verification checks out the commit SHA resolved and pinned by its validation job; every package and publication path depends explicitly on that result. Repository maintainers should configure this status as a required check on `main` after it appears on a pull request.

The separate [dependency-audit workflow](../.github/workflows/audit.yml) remains scheduled weekly and supports manual dispatch. It uses the same repository toolchain and `npm run audit:production` evaluator, supplying continuous coverage for newly disclosed advisories in vendored package forms that Dependabot cannot parse.

The project gate and raw npm output answer different questions:

- `npm audit --omit=dev` is the underlying registry report for the production lock graph. Its output and exit status are diagnostic and can change as the advisory database changes.
- `npm run audit:production` parses that report and fails on every unaccepted **high** or **critical** advisory.
- [`audit-exceptions.json`](../scripts/release/audit-exceptions.json) can accept an exact advisory/package pair only with a reason and expiry. The gate also fails expired exceptions and stale exceptions that no longer match the report.
- The release-script tests check exception structure and expiry, and each live PR/release/weekly gate evaluates unexpected, expired, and stale exceptions against npm's current report.

The fix for [issue #30](https://github.com/am-will/gooey-pi/issues/30) hardened both the ordinary and Prime-bundled production extractor paths and removed the traversal exception that was needed at the time. That historical removal does not establish the current advisory state: inspect [`audit-exceptions.json`](../scripts/release/audit-exceptions.json) and run the audit for the exact commit under review. Adding or extending an exception is a security-sensitive change governed by the [dependency pinning and supply-chain policy](security.md#dependency-pinning-and-supply-chain).

## Public release validation

The [release workflow](../.github/workflows/release.yml) runs for a semantic-version tag or a manual request naming an existing tag. It first verifies that the tag matches both package manifests and resolves to a commit on `main`; downstream jobs check out the resulting immutable commit SHA.

| Release job | Responsibility |
|---|---|
| `validate` | Enforce the repository toolchain, validate tag/package versions and `main` ancestry, and expose the exact release SHA. |
| `production-audit` (`Production dependency audit`) | Apply the live exception-aware production audit to the exact SHA exposed by `validate`; every package and publication path depends on this result. |
| `quality` | Run `release:verify:package` for that SHA. |
| `hermetic-e2e` | Build and run the Electron E2E suite for that SHA. |
| `package` | Build both native macOS architectures. Credential preflight is fail-closed; public verification checks the signing identity, required microphone entitlements on the app and every Electron helper, the notarization staple on each packaged app, Gatekeeper, artifact integrity, fuses, native layout/architecture, and package budgets. |
| `package-linux` | Build the configured Linux architectures on native runners and apply the Linux package/runtime verification path. |
| `package-windows` | When explicitly enabled, build either Authenticode-signed public packages or unsigned beta packages. Signed mode requires signing secrets and the configured signer subject and/or thumbprint. |
| `release-packages` | Reject failed prerequisites, collect the enabled platform artifacts, generate checksums, attest provenance, and publish or resume the GitHub Release with write permission scoped to this final job. |

Native release jobs pass `--skip-verify` only after the same immutable SHA has passed the upstream quality and E2E jobs. That flag skips a duplicate pre-package test aggregate; it does not skip bundle creation or the platform-specific post-package verification.

Public macOS checks require external Developer ID and notarization credentials that are not present in ordinary PR CI. Signed Windows packaging is also conditional on repository configuration and secrets. If neither signed nor unsigned Windows release mode is enabled, `package-windows` is expected to be skipped and the aggregate release gate explicitly accepts that skip. Within an enabled Windows job, the signed and unsigned build steps are mutually exclusive, so one of them is normally skipped.

An explicitly enabled unsigned Windows beta is not trust-ready and must be labelled as such. Ordinary PR smoke packages and manual local-QA artifacts do not replace any credentialed release check.

## Recording evidence

Keep point-in-time results in the PR, release notes, or another commit-addressed record rather than updating this guide with a new "current status". Record at least:

- the full commit SHA and whether the worktree was clean;
- the workflow run URL or exact commands and exit status;
- runner image or local OS/architecture, plus observed Node and npm versions;
- workflow inputs and which conditional jobs or steps were skipped;
- the audit exception file used for dependency-audit claims;
- artifact names and checksums, and whether each artifact was unsigned, signed, notarized, stapled, or provenance-attested;
- any failure, rerun, accepted limitation, or manual observation needed to interpret the result.

Use test counts only inside that commit-addressed evidence. The durable claim is that the checked-in aggregate completed successfully, not that this guide remembers how many tests happened to exist at some earlier date.
