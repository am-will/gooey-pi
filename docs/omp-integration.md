# OMP integration

GooeyPi runs OMP alongside Pi and Prime Agent. Each harness has its own granted
projects, session catalog, model visibility, and runtimes. Switching the active
harness leaves work in the other harnesses running.

## Runtime and protocol

[`HARNESSES.omp`](../electron/main/harness.ts) defines OMP's executable and data
locations. Executable discovery checks the configured path, `OMP_BINARY`, the
inherited `PATH`, and bounded harness and package-manager locations. Windows
npm shims are resolved to their known Node entry point. The implementation and
ordering live in [`process-utils.ts`](../electron/main/process-utils.ts).

[`OMP_RPC_ADAPTER`](../electron/main/agent-rpc/harness-adapter.ts) builds the RPC
argv, negotiates protocol version 2, and translates commands and events.
Requests use JSONL over stdio. The transport bounds frames, pending requests,
and writes. [`chunk-assembly.ts`](../electron/main/agent-rpc/chunk-assembly.ts)
validates and reassembles OMP's base64 `rpc_chunk` sequences before dispatch.

The adapter passes the authorized working directory with `--cwd`. Resume uses
`--resume` with a validated session path. Model selection uses `--model` with a
provider/model key. Thinking and optional approval mode are separate arguments.
The default approval setting leaves OMP's own configuration in control.

| GooeyPi command | OMP command |
|---|---|
| `fork` | `branch` |
| `get_fork_messages` | `get_branch_messages` |
| `set_service_tier` | `set_fast_mode` |

Other supported commands pass through the shared command schema. Prime-only
heartbeat and daemon commands are rejected. Approval questions use
`extension_ui_request` and the existing questionnaire UI. Automatic compaction
and manual compact results are normalized into the common transcript lifecycle.
The [adapter](../electron/main/agent-rpc/harness-adapter.ts) and
[runtime](../electron/main/agent-rpc/runtime.ts) define the exact behavior.

## Sessions and models

OMP sessions live below `~/.omp/agent/sessions`. The
[OMP session adapter](../electron/main/sessions/omp.ts) reads versioned JSONL
headers, tree entries, titles, model changes, and transcript content.
[`SessionService`](../electron/main/sessions.ts) authorizes each path and
handles archive state. A live rename goes through RPC. An offline rename uses
the harness-specific file writer and atomic replacement. Session JSONL is
therefore writable for explicit rename operations, while ordinary catalog and
transcript reads remain read-only.

Each `list()` call enumerates current catalog files and returns a newly
decorated result. Unchanged per-file metadata and a bounded live overlay may be
reused. Transcript reads have a separate cache keyed by file metadata.

[`OmpModelCatalogService`](../electron/main/providers-omp.ts) reads the bounded
`omp models --json` result and maps its thinking levels into the shared catalog.
[`CliModelCatalogService`](../electron/main/model-catalog-cli.ts) owns refresh
coalescing, expiry, invalidation, and the last-successful-catalog fallback.
Provider and model visibility are GooeyPi settings. Authentication remains with
OMP; GooeyPi does not read its credential database.

## Plugins, capabilities, and schedules

OMP package installation and actions use `omp plugin`. Project-scoped actions
run from the authorized project directory. Discovery includes OMP's user and
project roots and shared `.agents/skills` roots. The complete
[plugin catalog](../electron/main/plugins/catalog.ts) loads when requested.

The browser extension [`omp-work-browser.ts`](../assets/extensions/omp-work-browser.ts)
is shared by Prime, OMP, and Pi. The schedule, collaboration, and optional
Ask User extensions use the same per-runtime capability construction. Bearer
claims stay in the child environment and are revoked when construction fails
or the runtime ends. See the [security model](security.md).

GooeyPi schedules use OMP's normal prompt lifecycle and its model catalog.
They do not use Prime heartbeat RPC. Top-level peer messaging is described in
[session collaboration](session-collaboration.md).

Local stdio MCP configuration uses OMP's `mcp.json` schema. Network definitions
remain visible but managed outside GooeyPi. The shared writer, locking, and
Pi-adapter admission rules are documented once in
[MCP configuration and admission](security.md#mcp-configuration-and-admission).

## Application ownership

[`index.ts`](../electron/main/index.ts) composes the harness services and
[`ipc.ts`](../electron/main/ipc.ts) routes the validated harness selection.
The descriptor map and shared service interfaces define the ownership boundary.
Renderer settings live in [`useAppSettings`](../src/hooks/useAppSettings.ts),
while workspace state and actions are handled by
[`useWorkspaceRuntime`](../src/hooks/useWorkspaceRuntime.ts),
[`useWorkspaceActions`](../src/hooks/useWorkspaceActions.ts), and
[`workspace.ts`](../src/app/workspace.ts).

## Read-only child history (OMP 18.12.2)

The child inspector uses the released [persisted-agent layout](https://github.com/can1357/oh-my-pi/blob/v18.12.2/packages/coding-agent/src/registry/persisted-agents.ts): a parent `session.jsonl` owns `session/<child>.jsonl`, and nesting follows a child transcript's matching directory. Only descendants discovered from a parent authorized by the OMP session service are readable. Advisor artifacts and unrelated directories are excluded.

The renderer receives opaque child IDs and cursors scoped to its parent session and renderer. It cannot supply a child filesystem path. Main checks canonical containment, rejects symlinks and non-regular files, and compares file identity when opening. Reads grant no collaboration broker rights, and expose no child prompt, steering, resume, or tool execution controls. Replacing a parent invalidates its child IDs; replacing or shrinking a child resets the displayed history.

Roster refreshes query the running parent's released `get_subagents` command for metadata only, including while its turn runs. Persisted files remain discoverable after the live registry drops completed children or the parent exits. Historical status is unknown when the harness provides no live status. The app does not infer successful completion merely from a transcript existing.

History reads stay local and bounded, rather than calling the released `get_subagent_messages` implementation that reads the entire remaining file. Each request reads at most 1 MiB and renders at most 200 complete JSONL records through the existing transcript normalizer. Newest history loads first, older pages load on demand, and only the viewed child polls for appended records. A record exceeding the byte window is skipped with an explicit truncation flag. System prompt snapshots remain hidden; thinking summaries and tool calls/results already exposed in the transcript remain readable. A tool result across a page boundary renders independently so its output remains visible. Complete child history is available through paging within these limits.

Prime and Pi return an explicit unavailable capability. Prime 0.10 has different durable child membership and transcript paths, so it requires its own verified adapter. This inspector neither subscribes to full OMP child event snapshots nor launches child runtimes to read history.
