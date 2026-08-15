# Packages, extensions, skills, and MCP

GooeyPi presents one capability directory for Prime Agent, OMP, and Pi, but it
must not pretend that the three harnesses install or authenticate capabilities
the same way. This document defines the product contract for that surface.

## Shared vocabulary

- A **package** is a distribution container. Prime Agent and Pi packages can
  contain extensions, skills, prompts, and themes.
- An **extension** is executable JavaScript or TypeScript loaded into the agent
  host. Installing an extension means installing its package or placing its
  file in a harness-native extension directory.
- A **skill** is model-facing guidance. Prime Agent additionally supports
  Python-backed skills installed into its IPython kernel environment.
- An **MCP server** is a connection definition. It is not itself a package,
  extension, or skill, although a package may provide one or more of those
  resources and may declare MCP servers.
- An OMP **plugin** is an OMP-native bundle that can provide skills, commands,
  agents, hooks, tools, MCP servers, LSP servers, and extension modules.

## Harness contracts

| Harness | Installable bundle | Standalone extension | MCP runtime | MCP actions available in GooeyPi | Network MCP and authentication |
| --- | --- | --- | --- | --- | --- |
| Prime Agent | `prime-agent package install <source>` | Local file through `package install`; `--local` for project scope | A matching Python-backed `McpIntegration` skill | Read-only discovery; bounded definition-only removal for cleanup | Configure, authenticate, and remove authorization directly in Prime Agent, outside GooeyPi |
| OMP | `omp plugin install <target> --json` | Copy one local module into user `~/.omp/agent/extensions/` or project `.omp/extensions/` | Native | Create, enable, disable, or remove local stdio definitions in user `~/.omp/agent/mcp.json` or project `.omp/mcp.json` | Configure HTTP/SSE and authenticate directly in OMP, outside GooeyPi |
| Pi | `pi install <source>` | Local file through `pi install`; `-l` for project scope | `pi-mcp-adapter` extension package | With the adapter enabled, create/enable/disable local stdio definitions; bounded definition removal remains available for cleanup | Configure HTTP/SSE and authenticate through the adapter outside GooeyPi |

The app labels this surface **Capabilities** for every harness. Its Add button
first opens a capability-type chooser, then a type-specific form: **Add MCP**,
**Add Plugin** (OMP) or **Add Package** (Prime/Pi), and **Add Extension**. Pi's
MCP choice is disabled for Prime and remains visible but disabled for Pi until
its **Pi MCP Adapter** toggle is enabled. OMP and adapter-enabled Pi offer only
local stdio input fields. The initial Add chooser warns that third-party code may use CLI-only
APIs and links directly to GooeyPi's GitHub issue form for failures; the base
Capabilities screen and the follow-up forms do not repeat that notice.

## Product behavior

### Prime Agent

Prime Agent MCP management is outside GooeyPi. The app neither creates nor
changes Prime MCP definitions and does not forward `/mcp login` to a Prime
session. Built-in and
custom entries remain visible with `availability.available === false` and an
external-management explanation. GooeyPi neither inspects nor changes Prime
MCP credentials because it cannot prove which component created a shared
credential. Configured definitions may be removed through a definition-only
cleanup action; authorization cleanup must be run directly in Prime Agent.
Package installation remains a separate supported capability.
GooeyPi carries a bounded exact settings key separately from its sanitized
display label so unusual keys can be removed without retargeting another
entry. Keys above the app's 1,024-character removal bound remain visible but
must be cleaned up directly in Prime Agent.
MCP discovery has its own budget, so packages, skills, and extensions cannot
hide MCP rows. GooeyPi surfaces up to 2,500 definitions from each settings
file; if a file exceeds that supported bound, the catalog reports an explicit
scope-and-path warning and the remaining entries must be managed in Prime.

### OMP

OMP has native MCP support. GooeyPi writes only local stdio entries to
OMP-native MCP files and installs plugins only through `omp plugin`. It rejects
HTTP, SSE, and any URL-bearing definition, including loopback URLs, and never
forwards `/mcp reauth` from a GooeyPi prompt. Network configuration and
authentication must be run directly in OMP outside the app. Externally configured network entries remain visible but are
read-only in GooeyPi; bounded definition-only removal remains available for cleanup.
Local definitions whose exact harness key cannot pass GooeyPi's bounded state
API remain visible but have no Enable or Disable control; their state must be
managed directly in OMP. Bounded exact-definition removal remains available.

OMP marketplace targets use `name@marketplace`. Repository and local targets
remain accepted where the OMP CLI accepts them.

### Pi

Pi core has no MCP client. GooeyPi shows **Pi MCP Adapter** as a real
toggle whose state is derived from Pi's installed packages. Enabling it runs
`pi install npm:pi-mcp-adapter`; disabling preserves the installed package and
records its Pi package filters as disabled. Disabling does not delete MCP definitions or credentials, so a
later re-enable restores the connections without silently losing user data.

Only while the adapter is enabled may GooeyPi create or change local stdio
entries in its supported `mcp.json` schema; definition-only removal remains
available while disabled. It rejects HTTP, SSE, and any URL-bearing
definition, including loopback URLs, and never launches `/mcp-auth`. Network
configuration and authentication must be run through the adapter outside
GooeyPi; GooeyPi does not forward `/mcp-auth` prompts.
Externally configured network entries remain visible but are read-only in the
app; bounded definition-only removal remains available for cleanup.
Only the canonical `npm:pi-mcp-adapter` source (optionally followed by an exact
semantic version) satisfies this prerequisite. Scoped, Git, local-path, and
same-name package sources do not authorize MCP writes.
Adapter-enabled local definitions with keys outside GooeyPi's bounded state
API remain visible but non-actionable, with direct-harness management detail.

## Security boundaries

- Every install/remove command uses the detected fixed harness executable and
  an argv array; no shell interpolation is permitted.
- Package, plugin, server, command, and argument inputs are bounded and
  validated in the main process.
- Standalone extensions must be absolute local JavaScript or TypeScript files.
  Project installs are re-authorized and their destination directories remain
  pinned against symlink replacement; existing OMP extension files are never
  overwritten.
- Network MCP definitions fail closed at the service admission and settings
  writer boundaries. State mutation also rejects externally configured network
  entries. The local stdio settings path retains the existing lock, conflict
  retry, project-directory pinning, atomic replacement, and rollback protections;
  definition removal re-verifies the project directory immediately before and
  after reading each update snapshot.
- The main-process RPC manager rejects harness authentication commands for
  prompt, steer, follow-up, and heartbeat delivery. Session-daemon follow-up,
  scheduled execution, voice task launch, collaboration creation, and peer
  delivery preflight the same shared policy before queuing, wake-up, delivery,
  or runtime start.
- MCP rows use an independent 2,500-definition-per-settings-file discovery
  budget. Unrelated catalog records cannot consume it, and exceeding it emits
  an explicit scope-and-path warning.
- Pi adapter transitions and non-removal MCP writes share an agent-level
  admission lock across service instances. Adapter state is re-checked while
  that lock is held, immediately before the settings mutation.
- GooeyPi never requests or mutates `mcp:*` credentials in Prime auth storage,
  Pi auth storage, or OMP's `agent.db`. Prime model discovery receives an
  MCP-blind AuthStorage facade; definition removal does not inspect or change
  authorization.
- GooeyPi does not claim to prevent a harness from loading network MCP entries
  configured outside the app. Its guarantee is narrower: GooeyPi does not
  create, enable, disable, mutate, or authenticate those entries.
