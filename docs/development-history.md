# Development history

Prime Work was created during a set of Prime Agent and Codex sessions on August 5, 2026. This document maps those sessions to the repository history and records the work that led to the current GUI.

## Source sessions

| Session | Agent | Product work |
|---|---|---|
| `019fd463-f980-706b-9e16-dc4ad3948bee` | Prime Agent | Researched the Codex desktop interaction model and Prime Agent runtime, selected Electron, created the application architecture and design system, implemented the backend services and sandboxed preload bridge, built the React workspace, added real sessions/projects/browser/terminal/plugins/settings/schedules, added tests and packaging, and fixed the Electron window-close crash. |
| `019fd4ae-2a62-72da-a181-9a088ba01659` | Prime Agent | Replaced generic identity treatments with Prime branding, generated the macOS icon assets, added keyboard- and pointer-accessible inspector/terminal resizing, refined typography and responsive behavior, and extended end-to-end coverage. |
| `019fd4de-e0f8-7f92-8243-992e27ebad64` | Codex | Iterated on title-bar spacing and browser/terminal iconography from live screenshots, restored the Prime mark, introduced the lined-globe treatment, and verified the final dark-mode render. |

The remaining Prime sessions in the same working directory (`019fd45f…`, `019fd466…`, `019fd485…`, `019fd487…`, `019fd48a…`, `019fd48b…`, `019fd49e…`, and `019fd4b5…`) dealt with Prime Agent skill warnings, version checks, or computer-use MCP configuration. They did not contribute files to Prime Work and are intentionally not represented as code commits.

## Build sequence

The Git history is organized into dependency-ordered milestones reconstructed from the session tool calls and resulting files:

1. Research and design foundation: reference material, product audit, architecture, and SuperDesign artifacts.
2. Desktop runtime: Electron lifecycle, persistence, Prime RPC/session integration, Git, browser, terminal, plugins, schedules, and the allowlisted preload API.
3. Application interface: React shell, navigation, transcript/composer, inspector, browser, terminal drawer, settings, projects, plugins, schedules, and responsive styling.
4. Brand and packaging: Prime marks, application icons, macOS packaging, and native dependency handling.
5. Verification and documentation: backend tests, Electron end-to-end coverage, security/validation notes, and user-facing setup documentation.
6. Visual QA: final title-bar spacing and icon refinements captured in the current source and QA screenshots.

Because the project had no Git repository while it was being built, there were no original intermediate snapshots to preserve. These commits reconstruct logical milestones from the authoritative session logs and the final filesystem; they do not claim byte-for-byte snapshots at each conversational turn.

