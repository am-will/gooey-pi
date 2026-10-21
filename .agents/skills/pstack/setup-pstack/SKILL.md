---
name: setup-pstack
description: Configure model-neutral delegation or record a model override explicitly requested by the user. Use for /setup-pstack, resetting delegation to inherit the session, or a user-requested model choice.
---

# Set up pstack delegation

Every role inherits the current chat/session model by default. Omit the Task or
spawn tool's `model` argument. Missing configuration means inheritance, not an
inline default. Reviewer and worker counts come from the task, not a model list.

## Configure only what the user requested

1. Read the applicable repository and user instructions. A stale role mapping is
   not authorization to change models.
2. For an ordinary setup or reset request, use inheritance for every role. Do not
   enumerate models, detect providers, infer a task-to-model mapping, or ask the
   user to choose models when they did not request an override.
3. If the user explicitly names a model for this invocation, use that exact choice
   only where requested. Check that the delegation tool accepts it. If it is
   unavailable, report that limitation and retain inheritance for independent work;
   do not choose another family, provider, or reasoning tier as a substitute.
4. Persist an override only when the user explicitly requests persistence and its
   scope. A one-off invocation never becomes a standing role default.

## Model-neutral rule

When asked to write configuration, use the user's requested location. Preserve
unrelated settings. A repository may keep this policy in
`.cursor/rules/pstack-models.mdc`; do not copy it into user configuration unless
that is part of the request.

```mdc
---
description: Inherit the current session model for delegation
alwaysApply: true
---
All delegated roles inherit the current chat/session model. Omit `model` unless
the human user explicitly chooses a model for the current invocation. Do not
infer role defaults or substitute another model. Keep independent review roles
and varied review focus without requiring different models.
```

Confirm the file written and summarize only the requested changes. Do not launch
agents or alter the current chat's model as a setup demonstration.
