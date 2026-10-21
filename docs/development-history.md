# Development history

Prime Work was created during a set of Prime Agent and Codex sessions on August 5, 2026. This document maps those sessions to the repository history and records the work that led to the current GUI.

## Original implementation

The initial Prime-only client was called Prime Work. Prime Agent sessions produced
the Electron architecture, sandboxed bridge, React workspace, project and session
services, coding tools, packaging, and tests. Later Prime Agent and Codex sessions
refined the identity, typography, responsive panels, icons, and title bar.

This is a historical account of that initial implementation. Use the
[documentation index](README.md) for the current multi-harness architecture.

## Build sequence

The Git history is organized into dependency-ordered milestones reconstructed from the session tool calls and resulting files:

1. Research and design foundation: reference material, product audit, architecture, and SuperDesign artifacts.
2. Desktop runtime: Electron lifecycle, persistence, Prime RPC/session integration, Git, browser, terminal, plugins, schedules, and the allowlisted preload API.
3. Application interface: React shell, navigation, transcript/composer, inspector, browser, terminal drawer, settings, projects, plugins, schedules, and responsive styling.
4. Brand and packaging: Prime marks, application icons, macOS packaging, and native dependency handling.
5. Verification and documentation: backend tests, Electron end-to-end coverage, security/validation notes, and user-facing setup documentation.
6. Visual QA: final title-bar spacing and icon refinements captured in the current source and QA screenshots.

Because the project had no Git repository while it was being built, there were no original intermediate snapshots to preserve. These commits reconstruct logical milestones from the authoritative session logs and the final filesystem; they do not claim byte-for-byte snapshots at each conversational turn.

