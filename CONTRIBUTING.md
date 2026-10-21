# Contributing

See the [source setup](README.md#run-from-source) and
[validation guide](docs/validation.md) for the supported toolchain and checks.

## Architecture and security

The [documentation index](docs/README.md) links the current integration and security references.
The Electron entry point, `electron/main/index.ts`, composes the services. Main-process
modules own filesystem access, project grants, subprocesses, and credentials. The
sandboxed preload under `electron/preload/` exposes fixed IPC methods, with matching
contracts in `src/types/api/`. React components and pages live under `src/`.
Keep validation at the main-process boundary; renderer input does not establish authority.

Read [the security model](docs/security.md) before changing project authorization,
IPC, browser control, subprocess launch, or capability configuration. Check the
[selected harness's integration](docs/README.md#harnesses-and-capabilities) before
changing protocol or session behavior. Shared runtime behavior belongs in the
existing agent and session modules rather than a separate copy for each harness.

State persistence lives in [`store.ts`](electron/main/store.ts) and its
[focused modules](electron/main/store/). They validate and migrate the versioned
user-data file and publish durable replacements. Session adapters under
[`sessions/`](electron/main/sessions/) interpret harness-owned files separately.
Bundled agent extensions live under [`assets/extensions/`](assets/extensions/);
[`extension-manifest.ts`](electron/main/extension-manifest.ts) defines their
injection contract.

To add an IPC method, define its contract in `src/types/api/`, expose a fixed
channel in `electron/preload/index.ts`, and register the validated handler in
`electron/main/ipc.ts`. Add boundary tests and run the
[channel parity test](tests/backend/ipc-channel-parity.test.ts) with the
[preload contract suite](tests/backend/preload-contract.test.ts). For a new
push event, use the trusted registration broadcast and a removable preload
subscription.

## Development data

`npm run dev` uses the normal Electron user-data directory and single-instance
lock. Quit an installed GooeyPi before starting it. Development can change your
saved projects, settings, and archive state. Use the disposable home in the
[verification driver](.cursor/skills/verify-gooeypi/SKILL.md) for isolated UI checks.
The separate local package example below isolates user data when needed.

## Interface copy and tests

Add interface strings to [`englishCatalog`](src/lib/locales/english.ts), then
update the [Japanese](src/lib/locales/japanese.ts) and
[Simplified Chinese](src/lib/locales/simplified-chinese.ts) catalogs. English is
the immediate fallback while a catalog loads and for missing translations.
Use the shared [translation API](src/lib/i18n.tsx). App-owned transcript notices
must keep structured data so changing the language can translate them again.
Dates and times follow the operating system's regional format.

Prefer roles, accessible names, or stable test IDs for UI tests. Hard-coded
English selectors must explicitly select English when they test translated UI.
Rebuild before driving a compiled Electron app, and record the exact revision,
command, and result as described in [validation](docs/validation.md#recording-evidence).

See [CONTRIBUTORS.md](CONTRIBUTORS.md) for contributor and reporter credits.

## Local macOS development without release credentials

You do not need access to the signing and notarization credentials for the
production `app.gooeypi.desktop` bundle. Use `npm run dev` while developing and
run the relevant checks from the validation guide before submitting a change.

To exercise the normal local packaging pipeline without release credentials,
run:

```bash
npm run package:mac:local-qa
```

This creates unsigned, unnotarized local-QA artifacts. It does not establish
that a build is ready for public distribution; `npm run package:mac` is reserved
for maintainers with the release credentials.

As an optional development convenience, use a separate app identity and
Electron data directory when keeping a local package alongside GooeyPi:

```bash
npm run build
npx electron-builder --mac dir --arm64 --publish never \
  --config.mac.identity=null \
  --config.mac.notarize=false \
  --config.productName="GooeyPi Dev" \
  --config.appId=app.gooeypi.desktop.localdev \
  --config.extraMetadata.name=gooeypi-local-dev \
  --config.directories.output=release/local-dev
```

Use `--x64` instead of `--arm64` on an Intel Mac. The `extraMetadata.name`
override isolates Electron state under
`~/Library/Application Support/gooeypi-local-dev`; changing only the product
name or bundle ID does not isolate it. These values are local examples and must
not replace the production package metadata.
