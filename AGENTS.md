# Repository engineering guidance

## File size

Keep handwritten production files at or below 750 lines when practical. Treat 750 lines as a review threshold, not a reason to create arbitrary wrapper modules or split cohesive logic.

When changing an existing production file above the threshold, avoid increasing its size unless the change cannot be separated without weakening cohesion. Prefer extracting a complete responsibility with a narrow interface, and explain any intentional exception in the pull request.

This threshold does not apply to tests, generated files, vendored code, lockfiles, fixtures, or data assets. Correctness, security boundaries, and maintainable ownership take precedence over line count.

## pstack

This repository vendors [pstack](https://github.com/cursor/plugins/tree/main/pstack) under `.agents/skills/pstack/` so Cloud Agents can run `/poteto-mode` and the rest of the skill set. Subagents live in `.cursor/agents/`. Per-role model overrides live in `.cursor/rules/pstack-models.mdc`.

pstack skills read `~/.cursor/rules/pstack-models.mdc`. Cloud Agents do not inherit that user-level path. If it is missing, copy the workspace rule before running a pstack skill:

```
mkdir -p ~/.cursor/rules
cp .cursor/rules/pstack-models.mdc ~/.cursor/rules/pstack-models.mdc
```

Re-run `/setup-pstack` to change role models. Only write Task `model` slugs that are available in the current session.
