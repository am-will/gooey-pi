# Session collaboration

GooeyPi lets top-level sessions in the same harness and working directory coordinate without turning them into parent/child subagents. In the composer, type `@` and part of a sidebar session title, then select the result. The visible `@title` is sent with a model-only routing block containing the stable session UUID. A session's context menu also exposes **Copy session UUID** for explicit coordination prompts.

Every Prime, OMP, and pi runtime receives six app-owned tools:

- `gooeypi_session_list`: list accessible peer titles, UUIDs, status, and liveness.
- `gooeypi_session_models`: list models available to this harness from providers currently active in GooeyPi, including each model's exact key and reasoning levels.
- `gooeypi_session_create`: create and immediately prompt a new readable top-level session in the caller's same harness and canonical working directory. It accepts an optional model, reasoning level, title, and `fast` request; approximate model/reasoning wording uses the same resolver as voice-created tasks, then the runtime manager revalidates the exact selection and enables fast/priority mode only when the selected model and harness support it. The result contains the new session UUID and the applied fast-mode state.
- `gooeypi_session_read`: read a bounded recent conversational snapshot and cursor without modifying the peer. It retains user, assistant, agent, and thinking text while omitting tool calls, tool results, and compaction internals.
- `gooeypi_session_send`: deliver an attributed prompt or follow-up. Incoming messages carry the sender's exact `from_session_id` and a signed `reply_with: "gooeypi_session_send"` hint, so the recipient can answer directly without listing sessions. If the saved peer is idle/offline, GooeyPi starts its normal RPC runtime first; the runtime manager revalidates its project and session paths.
- `gooeypi_session_wait`: wait up to 30 seconds for a peer to become idle and produce context after a cursor. Sends are non-blocking, and tool guidance prohibits mutual waits.

## Upstream research

The three harnesses do not provide one common top-level-session API:

| Runtime | Existing collaboration | Missing piece |
|---|---|---|
| Codex Desktop | Addressable tasks, background sends, bounded reads, and cursor-based waits; titles resolve to stable task IDs. | This is the product behavior GooeyPi mirrors, not a harness API GooeyPi can call. |
| Prime Agent 0.7.2 | Daemon `send_message` accepts a UUID/name and can wake a saved session. Agent-origin messaging and observation are family-scoped, and observation does not uniformly cover top-level workers. | No uniform cross-worker read/wait contract suitable for all GooeyPi harnesses. |
| OMP 17.2.15 | Task subagents can follow up/await inside one parent run; `/collab` and `omp join` provide a live shared relay room. | No arbitrary saved top-level session UUID/name read/send/wait RPC. |
| pi 0.84.1 | Current-session RPC, `switch_session`, and illustrative subprocess subagent/handoff extensions. | `switch_session` replaces the caller's runtime; there is no durable peer mailbox or arbitrary target API. |

Using Prime's daemon transport only for Prime would create three different semantics and would bypass its deliberate family restrictions. Mutating OMP/pi JSONL would violate harness ownership. The minimal uniform design is therefore a GooeyPi-owned broker over the existing per-harness RPC managers.

## Trust and lifecycle boundaries

- Access is same-harness, same-canonical-working-directory, and excludes the caller. A multi-folder workspace does not silently widen one session's authority to its other roots, and harness-scoped project grants never authorize another harness.
- Every runtime receives a separate random bearer token bound to its immutable harness/session claim. Tokens stay in the child environment and never cross renderer IPC.
- Target UUIDs are exact and validated. Titles are display-only; `@title` resolution happens in the renderer against the visible sidebar catalog.
- Session creation cannot select another harness or working directory. Model discovery excludes hidden, disabled, and unavailable providers/models, and creation goes through the owning manager's normal cwd, model, and reasoning validation before a prompt is accepted.
- Session JSONL remains read-only. Reads go through the owning `SessionService`; sends go through the owning live RPC manager.
- Read snapshots are limited to 40 recent conversational messages and 30,000 estimated tokens using the same portable four-characters-per-token convention as upstream compaction. The result reports its estimate and whether it was truncated. Tool-only transcript records do not consume the message or token budget. Sends are limited to 64 KiB. Waits are capped at 30 seconds, broker calls are body-bounded and rate-limited, and cached catalogs prevent wait polling from rescanning all session files.
- An offline send may start a normal runtime only after the existing manager reauthorizes both cwd and canonical session path. Concurrent wake requests share one in-flight start, and each source token may have only one session creation in flight.
- Routing blocks are stripped from the rendered user transcript. User-supplied routing delimiters are neutralized before GooeyPi adds its own block.

Native Prime subagent messaging, OMP task subagents/relay rooms, and pi extensions remain unchanged. Session collaboration is an additional top-level coordination surface.

Incoming peer prompts use a signed, app-local envelope. New envelopes expose only the sender UUID, a `gooeypi_session_send` reply hint, envelope-authenticity fields, and the actual message to the recipient model; they never include the sender title, harness, opening prompt, or transcript context. The signature survives app restarts and is verified before the transcript can render a user record with native agent-message styling, so ordinary prompt text cannot impersonate another session. The signing key stays in Electron's user-data directory with owner-only permissions and is never exposed to a harness or the renderer. Saved version-1 and version-2 envelopes remain readable for transcript compatibility, but are never newly emitted.
