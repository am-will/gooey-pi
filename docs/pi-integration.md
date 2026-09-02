# Pi (pi.dev) integration design

This document is the working spec for adding base Pi (`pi`, [pi.dev](https://pi.dev/), the pi-mono coding agent both Prime Agent and OMP descend from) as a third agent harness alongside Prime Agent and OMP. It follows the architecture established by `docs/omp-integration.md`: the shared transport, event, and UI machinery is reused wherever the protocols agree, and a per-harness adapter covers what differs. Read that document first; this one records only pi-specific facts and decisions.

## Product behavior

- The sidebar brand switcher gains a third entry: **Pi Work** (π mark, `PiMark` in `src/components/ui.tsx`).
- Each harness keeps its own granted projects, session catalog, model catalog, and runtimes; `settings.activeHarness` accepts `'pi'`.
- All existing features work on pi where the harness supports them: streaming transcripts, steering/follow-ups, abort, model + thinking selection, compaction, session resume/switch/rename/fork, extension-UI dialogs, browser capability bridge, scheduled tasks (injected extension, same as OMP), git/terminal.
- Fast mode is available for the same supported OpenAI Codex model families as Prime and OMP. Pi has no native service-tier RPC command, so GooeyPi injects `pi-work-fast-mode.ts`: a private slash command changes runtime-local state and a `before_provider_request` hook applies `service_tier` to supported requests. Approval mode remains unavailable (pi has no permission system; tool calls run unprompted, like a permanently-yolo OMP — the settings select is not shown), provider OAuth management is CLI-owned (`~/.pi/agent/auth.json` is never read or written), and daemon-socket follow-up remains Prime-only.
- Pi credentials: `~/.pi/agent/auth.json` and `trust.json` are never touched. A `piDisabledProviders` desktop-state list controls picker visibility only, mirroring `ompDisabledProviders`.

## Pi facts (verified on this machine, pi 0.84.1)

- Binary: `pi` (searched: `$PI_BINARY`, PATH, and GooeyPi's bounded shared executable directories, including npm/Bun/pnpm/mise/Volta/nvm/Homebrew locations). Installed here at `/opt/homebrew/bin/pi`.
- Spawn for embedding: `pi --mode rpc` plus:
  - **no `--cwd` flag exists** — the session bucket derives from the child's working directory, so the manager must spawn pi with the authorized cwd as the child process cwd.
  - resume: `--session <path>` (exact file path; `--resume` is an *interactive selector* and must not be used).
  - model: `--provider <name> --model <id>` (split flags, same shape as Prime; `--model` also accepts `provider/id` but we pass split flags for parity with the Prime adapter).
  - thinking: `--thinking <off|minimal|low|medium|high|xhigh|max>`.
  - extensions: `--extension/-e <path>` per injected capability extension; `--skill <path>` also exists but capability injection uses extensions for self-containment (same decision as OMP).
  - `--no-session` exists (used by the model-catalog probe, never for user runtimes).
- Paths: agent dir `~/.pi/agent/`; sessions `~/.pi/agent/sessions/--<cwd-with-slashes-as-dashes>--/<ISO-timestamp-dashes>_<uuidv7>.jsonl` (e.g. `--Users-am.will-Applications-prime--/2026-08-10T22-41-20-246Z_019fedd6….jsonl`); settings `~/.pi/agent/settings.json`; extensions `~/.pi/agent/extensions/`; skills `~/.pi/agent/skills/`; model catalog cache `models-store.json`; credentials `auth.json` + `trust.json` (never touched).
- Sessions are **version 3** JSONL: header `{"type":"session","version":3,"id":"<uuidv7>","timestamp":"<ISO>","cwd":"<abs path>"}` then tree entries with short hex `id`/`parentId` (`parentId: null` roots). Entry types include `message`, `model_change` (split `provider` + `modelId` fields, unlike OMP's single string), `thinking_level_change`, `compaction`, `branch_summary`, `custom`, `custom_message`, `label`, `session_info` (carries the display `name`; the latest one wins). No 256-byte title slot (that is an OMP addition); offline rename stays disabled like OMP.
- Model catalog: **no CLI JSON list** (`--list-models` prints a table even under `--mode json`). The catalog service does a short-lived RPC probe: spawn `pi --mode rpc --no-session --offline`, send `{"id":"1","type":"get_available_models"}`, read the single bounded response, terminate. Response shape: `{ models: [{ id, name, api, provider, baseUrl, reasoning, input, cost{input,output,cacheRead,cacheWrite}, contextWindow, maxTokens, thinkingLevelMap? }] }`. All output is untrusted input.
- Target model for validation: `openai-codex/gpt-5.6-luna` (GPT-5.6 Luna, authenticated on this machine, 272K context).

## Protocol: Prime-shaped JSONL, no handshake extras

Verified against pi 0.84.1 in `--mode rpc`:

- Same request/response envelope as Prime (`id`, `{type:'response', id, command, success, data|error}`). **No `ready` frame is pushed at startup, no protocol negotiation, no chunked frames** — the Prime-style handshake (`get_state` → `updateFromState` → `get_session_stats`) applies unchanged.
- `get_state` data: `model` (full descriptor), `thinkingLevel`, `isStreaming`, `isCompacting`, `steeringMode`, `followUpMode`, `sessionId`, `autoCompactionEnabled`, `messageCount`, `pendingMessageCount`. **No `serviceTier`, no `fastModeEnabled`, no `contextUsage`** — `readState` returns `{}`.
- `get_session_stats` includes `contextUsage: {tokens, contextWindow, percent}` in the exact shape `parseContextUsage` expects — context usage flows through the shared stats path. The same response carries `cost` (USD summed from catalog pricing, `0` for models without pricing) and `tokens: {input, output, cacheRead, cacheWrite, total}`, which `parseSessionUsage` turns into `RuntimeInfo.sessionUsage` (missing `cost` becomes `null`) and the runtime forwards as a `session_usage` event for the composer dial tooltip and the inspector Cost row.
- Verified commands: `get_state`, `get_available_models`, `get_session_stats`, `set_session_name` (also emits a `session_info_changed` event), `get_commands`. Unknown commands return clean `success:false` error responses.
- Command vocabulary is Prime's: `fork`/`get_fork_messages` pass through untranslated (no `branch` rename). Events use the Prime names (`agent_start`, `turn_*`, `message_*`, `tool_execution_*`, `extension_ui_request`, `compaction_start/end`, …); `normalizeEvent` passes events through, and unknown types (`session_info_changed`, …) are forwarded for the reducer to ignore.
- GooeyPi maps `set_service_tier` to `/gooeypi-fast-mode default|priority` through Pi's prompt RPC. The bundled extension owns that private command and adds `service_tier` only for supported OpenAI Codex requests. Unsupported by pi and rejected with a per-harness error: `send_message`; `clone` semantics differ — treat the Prime-only daemon/heartbeat family (`send_message`, `set_heartbeat`, `update_heartbeat`, `manage_heartbeat`, `observe`, `unobserve`, `list_heartbeats`, `get_heartbeat`, `agent_messages_*`) as unsupported, mirroring the OMP list.

## Architecture deltas

- `HARNESS_IDS` gains `'pi'`; `requireHarness`, `parseHarness`, store validation, and every `Record<HarnessId, …>` widen accordingly. The ~47 binary `harness === 'omp' ? a : b` branches become record lookups.
- `HARNESSES.pi` descriptor: productName `Pi Work`, agentName `Pi`, executable `pi`/`pi.exe`, env `PI_BINARY`, no bundled resource dirs, posix candidates `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, agent dir `~/.pi/agent`, session root `~/.pi/agent/sessions`.
- `PI_RPC_ADAPTER` in `agent-rpc/harness-adapter.ts`: argv per the facts above; identity `translateCommand` except the unsupported set; identity `normalizeEvent`; `readState` returns `{}`; `buildServiceTierCommand` invokes the private bundled fast-mode command. Because pi has no `--cwd`, the adapter declares that the runtime must set the child working directory (`spawnsInCwd`), and the manager honors it without changing how Prime or OMP spawn.
- `sessions/pi.ts` mirrors `sessions/omp.ts`: one bucket level deep, ordering from the filename ISO-timestamp prefix, v3 tree walk on `id`/`parentId`, title from the latest `session_info` entry, `model_change` from split `provider`/`modelId`. JSONL is read-only; catalog constructed with a null executable (no live-CLI overlay).
- `providers-pi.ts`: `PiModelCatalogService` satisfies `ModelCatalogProvider` via the RPC probe (single-flight, TTL, byte-bounded stdout, kill-on-timeout, sanitized env), mapping to the existing `PrimeModelCatalog` types.
- Plugins: a pi `PluginService` scopes discovery to `~/.pi/agent/extensions`, `~/.pi/agent/skills`, project `.pi/` roots, and shared `.agents/skills`; installs go through `pi install <source>` (project scope `-l`). MCP: pi core has no native MCP. GooeyPi explicitly supports the third-party `pi-mcp-adapter` extension (`pi install npm:pi-mcp-adapter`, listed on pi.dev's package registry), which reads the standard `mcpServers` schema from `~/.pi/agent/mcp.json` (global) and project `.pi/mcp.json` (its highest-precedence override). The UI offers adapter installation first; only the canonical npm source, optionally at an exact semantic version, satisfies admission. Scoped/Git/local lookalikes remain ordinary packages. Adapter transitions and MCP writes serialize through one agent-level cross-instance lock, and the service re-checks enabled state under that lock before the hardened writer creates or changes local stdio entries. HTTP/SSE entries remain externally managed and read-only. Other Pi MCP extensions use different schemas and remain CLI-managed rather than being silently treated as compatible.
- Capability extensions: pi's extension API is the ancestor of OMP's (`(pi) => void`, `pi.registerTool`), so `assets/extensions/omp-work-browser.ts`, `omp-work-schedules.ts`, `omp-work-collaboration.ts`, and `omp-work-ask-user.ts` are shared as-is for pi runtimes. The collaboration extension provides app-owned bounded list/models/create/read/send/wait tools for same-harness, same-working-directory top-level sessions; model-selectable creation and optional fast-mode negotiation use pi's normal catalog and RPC manager, never `switch_session` or JSONL mutation. The ask-user extension is injected only when the universal **Ask user** capability is enabled; fresh installs default it off. Any API drift found during live validation is fixed in the shared extension, not forked.
- Schedules: records already carry their harness; `'pi'` routes to the pi RPC manager and catalog through the same executor.
- Renderer: third switcher entry, `HARNESS_*_NAMES.pi`, fast-mode controls on supported models, and a pi settings card without the approval-mode control.

## Security invariants (unchanged)

Same rules as `docs/security.md`, applied to the third harness: argv arrays only, sanitized child env, path canonicalization + containment for the pi session root, session JSONL read-only, all transport/event limits identical, `~/.pi/agent/auth.json` and `trust.json` never read, IPC allowlist fixed with `harness` validated as the strict three-value enum, Prime byte-for-byte parity preserved when settings are untouched.

## Phase plan

1. Design doc (this file).
2. Foundation: `HARNESS_IDS`/store/descriptor/`PI_RPC_ADAPTER`/manager cwd support + adapter tests.
3. Parallel: pi session reader + tests; pi model catalog + tests; renderer switcher/settings + tests; pi plugin surface.
4. Wiring: third service set in `index.ts`, `ipc.ts` record lookups, schedules/voice routing, preload/api threading.
5. Live validation against pi 0.84.1 with `openai-codex/gpt-5.6-luna`; fixes.

## Non-goals (v1)

- A GooeyPi-owned Pi credential store or app-driven MCP OAuth; silently installing an MCP adapter;
  offline session rename; importing sessions across harnesses; host tools and
  native pi collab surfaces. GooeyPi-owned top-level session collaboration is
  documented in `docs/session-collaboration.md`. HTTP/SSE definitions remain
  direct adapter operations outside GooeyPi; the app intercepts rather than
  forwards `/mcp-auth`, so authentication must be run through Pi itself.
