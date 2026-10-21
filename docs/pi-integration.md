# Pi integration

GooeyPi runs the base [Pi harness](https://pi.dev/) with the same project,
workspace, transcript, and scheduling surfaces used by OMP and Prime Agent.
The [OMP integration](omp-integration.md) describes shared service ownership.
This reference covers Pi's protocol differences.

## Runtime and protocol

[`HARNESSES.pi`](../electron/main/harness.ts) defines executable discovery and
Pi's data roots. Discovery checks the configured path, `PI_BINARY`, inherited
`PATH`, and bounded shared locations in the order implemented by
[`process-utils.ts`](../electron/main/process-utils.ts). On Windows, the known
`pi.cmd` shim resolves to its Node entry point without shell execution.

[`PI_RPC_ADAPTER`](../electron/main/agent-rpc/harness-adapter.ts) starts Pi in
RPC mode. The runtime sets the child process working directory to the authorized
project; Pi has no `--cwd` flag. Resume uses `--session` with the exact validated
path. Model selection passes separate provider and model arguments.

Pi uses JSONL requests and responses without OMP's ready-frame negotiation or
chunk protocol. The shared runtime obtains state and session statistics and
normalizes compaction outcomes. Fork commands retain Pi's `fork` vocabulary.
Unsupported Prime daemon and heartbeat commands fail at the adapter boundary.

Fast mode uses the bundled
[`pi-work-fast-mode.ts`](../assets/extensions/pi-work-fast-mode.ts) extension.
Its private slash command updates runtime-local state, and its provider hook
adds a service tier only for supported models. A
[compatibility test](../tests/backend/pi-fast-mode-extension.test.ts) compares
that support with the pinned Prime model helper.

## Sessions and models

Pi keeps sessions under `~/.pi/agent/sessions`. The
[Pi session adapter](../electron/main/sessions/pi.ts) reads versioned JSONL tree
entries, `session_info` names, model changes, and transcript parts.
[`SessionService`](../electron/main/sessions.ts) authorizes the paths, applies
archive state, and routes a live rename through RPC. An offline rename appends
session-name metadata through the file writer and atomic replacement.

Each `list()` call enumerates current catalog files and returns a freshly
decorated result. Per-file metadata can be reused when unchanged. Transcript
reads have a separate metadata-keyed cache. GooeyPi does not treat session JSONL
as globally read-only: explicit offline rename operations update it.

Pi's human-readable model-list command is not the catalog API.
[`PiModelCatalogService`](../electron/main/providers-pi.ts) uses the shared
[RPC probe](../electron/main/model-catalog-rpc.ts), which starts
`pi --mode rpc --no-session --offline`, requests `get_available_models`, and
terminates the child. Output and time are bounded. The decoder handles split
UTF-8 and unterminated final frames, and process shutdown tracks the probe.

Provider credentials remain Pi-owned. GooeyPi does not read or write Pi's
`auth.json` or `trust.json`. Its provider and model visibility settings affect
the picker, independently of Pi's authentication state.

## Capabilities and MCP

[`omp-work-browser.ts`](../assets/extensions/omp-work-browser.ts) is the shared
browser extension for all three harnesses. Pi also uses the shared schedule,
collaboration, and optional Ask User extensions. Their bearer claims are scoped
to the owning runtime. See the [security model](security.md) and
[session collaboration](session-collaboration.md).

Pi core has no native MCP surface. GooeyPi supports the explicit
`pi-mcp-adapter` package and offers installation before local stdio setup.
Only the canonical npm source, optionally at an exact supported semantic
version, satisfies adapter admission. Lookalike sources remain ordinary
packages. Network definitions and authentication stay externally managed.
The shared write and admission contract is in
[MCP configuration and admission](security.md#mcp-configuration-and-admission).

GooeyPi schedules route to Pi's manager and model catalog. They do not use Prime
heartbeat commands. Child-history inspection reports unavailable for Pi until
a separate durable-membership adapter is verified.
