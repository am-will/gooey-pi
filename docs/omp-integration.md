# OMP (Oh My Pi) integration design

This document is the working spec for adding OMP (`omp`, [omp.sh](https://omp.sh/), [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi)) as a second agent harness alongside Prime Agent. Both harnesses descend from the same Pi base (pi-mono), so the integration reuses the existing transport, event, and UI machinery wherever the protocols agree, and adapts only where they genuinely differ.

## Product behavior

- The sidebar brand in the top-left gains a chevron. Clicking it opens a harness switcher: **Prime Work** (Prime Intellect butterfly) or **OMP Work** (OMP pi-plug mark, `assets/brand/omp-icon.svg`, MIT-licensed from the oh-my-pi repo).
- Switching harness swaps the whole workspace context: each harness has its own granted projects, session catalog, model catalog, and runtimes. Settings gain an `activeHarness` field; the choice persists.
- All existing features work on OMP where the harness supports them: streaming transcripts, steering/follow-ups, abort, model + thinking selection, compaction, session resume/switch/rename/fork(branch), extension-UI dialogs (which is also how OMP surfaces **tool approval prompts**), browser capability bridge, git/terminal (harness-agnostic already).
- Scheduled tasks are available in both harnesses. Prime retains its heartbeat tools; OMP receives an injected scheduled-task extension backed by Prime Work's local schedule service and executor. Still Prime-only: daemon-socket follow-up to out-of-app sessions and provider OAuth management. OMP credentials remain CLI-owned; Prime Work keeps a separate `ompDisabledProviders` list that only controls which providers appear in its OMP model picker.
- Capabilities is harness-scoped but available in the same place for both. OMP uses its native plugin manager (`omp plugin install`), user/project plugin roots, `.omp/skills` plus shared `.agents/skills`, and OMP-native `mcp.json`; Prime's package and settings behavior is unchanged.

## OMP facts (verified on this machine, omp 17.2.11)

- Binary: `omp` (searched: `$OMP_BINARY`, PATH, `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`).
- Spawn for embedding: `omp --mode rpc --cwd <dir>` plus:
  - resume: `--resume <sessionPath>` (also accepts id prefixes; we always pass validated absolute paths)
  - model: `--model <provider>/<modelId>` (single flag, unlike Prime's `--provider X --model Y`)
  - thinking: `--thinking <off|minimal|low|medium|high|xhigh|max>`
  - approvals: `--approval-mode <always-ask|write|yolo>` — only passed when the user overrides the default in settings; otherwise OMP's own `~/.omp/agent/config.yml` governs.
  - extensions: `-e <path>` for each injected capability extension. Prime Work injects scheduled-task, browser, and session-collaboration extensions, plus the ask-user extension when the universal **Ask user** capability is enabled. No `--skill <path>` flag exists; skills are discovery-based, so Prime Work's browser *skill* is not injected — the OMP browser *extension* carries the tool surface.
- Paths: agent dir `~/.omp/agent/`; sessions `~/.omp/agent/sessions/<bucket>/<ISO-timestamp>_<uuid>.jsonl` (bucket = scope-basename-hash of cwd); settings `~/.omp/agent/config.yml`; extensions `~/.omp/agent/extensions/`; auth in `~/.omp/agent/agent.db` (SQLite — never touched by Prime Work).
- Plugins: `omp plugin install <target> --json` installs user-scoped packages under `~/.omp/plugins` by default; project packages live under `<project>/.omp/plugins`. Native skills are discovered from `~/.omp/skills`, project `.omp/skills`, and shared `.agents/skills`. Native MCP files are `~/.omp/agent/mcp.json` and project `.omp/mcp.json`.
- Model catalog: `omp models --json` → `{ models: [{ provider, id, selector, name, contextWindow, maxTokens, reasoning, thinking: string[]|null, input: string[], cost }] }`.
- Target model for validation: `openai-codex/gpt-5.6-luna` (Luna GPT-5.6, already authenticated on this machine).

## Protocol: same JSONL framing, superset commands

OMP RPC is newline-delimited JSON over stdio with the same request/response envelope Prime Work already speaks: requests carry `id`, responses are `{type:'response', id, command, success, data|error}`. `FramedRpcTransport`, `StrictJsonlDecoder`, write budgeting, correlation rules, and `AgentEventForwarder` are reused unchanged.

Differences handled by an OMP adapter inside `electron/main/agent-rpc/`:

### Handshake
1. On start OMP pushes `{"type":"ready","protocolVersion":1,"supportedProtocolVersions":[1,2],...}`.
2. We send `negotiate_protocol { protocolVersion: 2 }`.
3. In v2, oversized frames arrive as base64 `rpc_chunk` sequences (`chunkId`, `index`, `count`, `data`); the OMP runtime reassembles them (bounded by the existing 16 MiB read limit) before normal dispatch.
4. Then the shared handshake continues as today: `get_state` → `updateFromState` → `get_session_stats`.
5. OMP also pushes `available_commands_update` (104 slash commands with metadata); forwarded to the renderer for future palette use, ignored by the reducer.

### Command mapping (renderer keeps speaking the existing vocabulary)

The renderer sends the same command objects it sends today; the OMP command schema validates against the same allowlist and translates where names differ:

| Renderer sends | OMP receives |
|---|---|
| `fork {entryId}` | `branch {entryId}` |
| `get_fork_messages` | `get_branch_messages` |
| `set_service_tier {serviceTier}` | `set_fast_mode {enabled: serviceTier === 'priority'}` |
| everything else | unchanged (`prompt`, `steer`, `follow_up`, `abort`, `new_session`, `get_state`, `set_model`, `set_thinking_level`, `switch_session`, `compact`, `set_auto_compaction`, `set_auto_retry`, `set_session_name`, `set_steering_mode`, `set_follow_up_mode`, `get_*`, `extension_ui_response`) |

Prime-only commands (`send_message`, heartbeat family, `clone`) are rejected by the OMP schema with a clear error. OMP scheduled tasks do not use heartbeat RPC commands: the injected extension calls a harness-scoped loopback broker, and due work is executed through OMP's normal prompt lifecycle. `prompt` responses may carry `data.agentInvoked === false` (local slash command, no agent turn) and OMP may later push a standalone `prompt_result` frame. No dedicated renderer handling exists or is needed: interactive Prime Work prompts never block on per-prompt turn completion, so a local-only prompt simply completes its request/response cycle, and `prompt_result` frames are forwarded as unknown events the reducer ignores.

The OMP argv contract (`--mode rpc`, `--cwd`, `--resume`, `--model`, `--thinking`, `--approval-mode`, `--extension`) was verified live against omp 17.2.11: `omp --help` lists every long form, and the in-app validation run spawned a runtime with all of them accepted.

### Event normalization (main process, before forwarding)

| OMP emits | Forwarded as |
|---|---|
| `auto_compaction_start` / `auto_compaction_end` | `compaction_start` / `compaction_end` |
| `agent_end` with `isTerminal === false` | swallowed as a turn boundary (not finalized) |
| `ready`, `available_commands_update`, `config_update`, `session_info_update`, `notice`, etc. | passed through (renderer reducer ignores unknown types) |
| everything else (`agent_start`, `turn_*`, `message_*`, `tool_execution_*`, `extension_ui_request`, `auto_retry_*`, `model_changed`, ...) | unchanged — same names as Prime |

Approvals: OMP has no permission frame; approval prompts arrive as `extension_ui_request` `select` dialogs ("Allow tool: …" with Approve/Deny) and are answered with the existing fire-and-forget `extension_ui_response`. The existing ask-user modal covers this; field shapes must be verified against `src/lib/extension-ui.ts` and normalized in the adapter if they drift.

## Architecture

### Harness descriptors (`electron/main/harness.ts`)

```
HarnessId = 'prime' | 'omp'
HarnessDescriptor {
  id, productName ('Prime Work' | 'OMP Work'), agentName ('Prime Agent' | 'OMP'),
  executableName(s), binaryEnvVar ('PRIME_AGENT_BINARY' | 'OMP_BINARY'), extra search dirs,
  agentDir (~/.prime/agent | ~/.omp/agent), sessionRoot,
}
```
`process-utils.ts` discovery generalizes to `findHarnessExecutable(descriptor)`; `findPrimeAgent()` stays as a thin wrapper so existing call sites migrate incrementally. `AppMeta` becomes `{ harnesses: { prime: {path, version}, omp: {path, version} }, ... }` (the old `primeAgentPath/Version` fields are migrated, not kept).

### One manager/service pair per harness

- `AgentRpcManager` gains a per-harness strategy: argv builder, handshake steps, command schema, event normalizer. Two instances are constructed in `index.ts`; `registerIpc` routes `agent:start {harness}` to the right one. `RuntimeInfo` gains `harness: HarnessId`.
- `SessionService`: second instance with `sessionRoot` parameterized and OMP-specific `catalogIo`/metadata/transcript readers (v3 JSONL: 256-byte `title` slot line, `session` header v3, entries with `id`/`parentId` forming a tree, `model_change.model` as a single `provider/id` string, entry types `message | model_change | thinking_level_change | compaction | branch_summary | custom_message | label | title_change | session_init | mode_change | ...`). Catalog scans one bucket level deep; ordering comes from the filename ISO-timestamp prefix instead of UUIDv7. No live-CLI overlay (OMP has no `list --json`); rename is done via RPC `set_session_name` when a runtime is live, else by rewriting nothing (session files stay read-only; sidebar rename is disabled for offline OMP sessions in v1).
- Providers: `OmpModelCatalogService` shells out to `omp models --json` (single-flight, 30 s TTL, byte-bounded) and adapts to the existing `PrimeModelCatalog` types. `AgentRpcManager.providers` already accepts an interface-shaped optional dependency; that interface is formalized so both services satisfy it.
- Projects: `ProjectRecord` gains `harness: HarnessId` (state migration defaults existing records to `'prime'`). Two `ProjectService` views scoped by harness; inferred projects come from each harness's own session catalog.
- Plugins: two `PluginService` instances preserve one renderer surface while routing discovery, installation, MCP paths, and reveal authorization through the active harness. OMP package installs go through `omp plugin`; catalog discovery includes OMP-native skill/extension roots and enabled package trees. GooeyPi writes only local stdio definitions using OMP's upstream schema and the same pinned-directory, cooperative-lock, fingerprint-retry, atomic-replacement, and rollback safeguards; this is not filesystem compare-and-swap, so a same-user writer that ignores the lock can race the final fingerprint check and rename. Network definitions remain visible but externally managed and read-only.
- Capability bridges: the browser `CapabilityBridge` is reused; `assets/extensions/omp-work-browser.ts` speaks OMP's extension API (default export `(pi) => void`, `pi.registerTool`) against the same loopback broker env contract. `assets/extensions/omp-work-schedules.ts` exposes list/create/update/manage tools through a separate scoped broker. `assets/extensions/omp-work-collaboration.ts` provides app-owned bounded list/models/create/read/send/wait tools for same-harness, same-working-directory top-level sessions; model-selectable creation and optional fast-mode negotiation use OMP's normal catalog and RPC manager rather than its parent-run task subagents or `/collab` relay rooms. When the universal capability is enabled, `assets/extensions/omp-work-ask-user.ts` registers a self-contained `ask_user` tool whose grouped select requests use the renderer's existing extension-UI questionnaire modal. Fresh installs leave this UI-blocking tool disabled. Schedule records carry their owning harness, the renderer lists only the active harness, and due runs route to the matching RPC manager and model catalog.

### Renderer

- `useAppSettings` carries `activeHarness`; `App.tsx` scopes workspaces, sessions, projects, and the model catalog by it. Switching harness behaves like a workspace switch (generation bump; running runtimes of the other harness keep running but are not shown).
- `Sidebar` brand becomes a button with chevron → dropdown listing both harnesses with logos (`PrimeMark` / new `OmpMark` in `src/components/ui.tsx`, adapted to `currentColor` + orange accent). Title strings, `TitleToolbar` fallback, and settings harness card follow the active harness.
- Settings: Agent section shows both harness status cards; an OMP-only "Approval mode" select (Inherit config / Always ask / Write / YOLO → argv flag only when not Inherit); Providers section per harness. OMP provider toggles update Prime Work's desktop state only, independently from Prime's provider list and without changing OMP configuration; authentication remains owned by OMP.

## Security invariants (unchanged)

Same rules as `docs/security.md`, applied to the second harness: argv arrays only, sanitized child env, path canonicalization + containment for the OMP session root, session JSONL read-only, stderr swallowed, all transport/event limits identical, `~/.omp/agent/agent.db` (credentials) never read, IPC allowlist stays fixed and narrow with `harness` validated as an enum.

## Phase plan (one commit per phase)

1. Design doc + OMP brand asset (this commit).
2. Harness descriptors + executable discovery + `AppMeta.harnesses`.
3. OMP RPC adapter (argv, handshake, chunk reassembly, command translation, event normalization) + fake-agent tests mirroring `agent-rpc.test.ts`.
4. OMP session catalog/metadata/transcript + tests.
5. OMP model catalog service + tests.
6. Harness threading through IPC/preload/types, per-harness projects, settings migration.
7. Renderer harness switcher + scoped state + settings UI.
8. OMP browser capability extension.
9. OMP scheduled-task extension, harness-scoped persistence, and executor routing.
10. OMP plugin, skill, and MCP catalog/install parity.
11. Live validation against omp 17.2.11 with `openai-codex/gpt-5.6-luna`; fixes.

## Non-goals (v1)

- A GooeyPi-owned OMP credential store or app-driven MCP OAuth. HTTP/SSE
  definitions remain direct OMP operations outside GooeyPi; GooeyPi intercepts
  rather than forwards `/mcp reauth`, so authentication must be run in OMP itself;
  OMP keeps ownership of profile-scoped credentials.
- Prime heartbeat RPC tools on OMP; OMP schedules use the local extension bridge instead.
- Host tools / host URI schemes, subagent transcript streaming, native OMP relay-room UI, and handoff. GooeyPi-owned top-level session collaboration is documented separately in `docs/session-collaboration.md`.
- Importing sessions across harnesses (`--from-claude`/`--from-codex` style).
