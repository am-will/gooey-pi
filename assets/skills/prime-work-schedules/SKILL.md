---
name: prime-work-schedules
description: Create, inspect, edit, pause, resume, run, and delete durable GooeyPi scheduled tasks. Use when the user asks to schedule recurring or one-time work in the current project or thread. Use rlm-heartbeat instead for temporary internal polling while actively working.
---

# GooeyPi Schedules

Use this capability for durable, user-visible tasks. GooeyPi must be running.

- `current_project`: each run creates a fresh top-level session in this project.
- `current_session`: each run returns to this thread and keeps its context.
- Use `rlm_heartbeat` instead for short-lived agent-internal checks such as watching a test command. On Prime Agent 0.10 or later inside GooeyPi, `rlm_heartbeat` jobs never run, so use `prime_work_schedules.create_once(..., target="current_session")` for those checks instead.

Call from IPython:

```python
await prime_work_schedules.create_recurring(
    prompt="Review open issues and report blockers",
    rrule="FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0",
    dtstart_local="2026-08-07T09:00:00",
    time_zone="America/Los_Angeles",
    target="current_project",
    title="Morning issue review",
    model="auto",
    thinking="high",
    fast=False,
)
```

Other calls:

```python
await prime_work_schedules.create_once(prompt="...", at="2026-08-08T18:00:00Z", target="current_session")
await prime_work_schedules.list()
await prime_work_schedules.update(task_id, title="New title", prompt="...")
await prime_work_schedules.pause(task_id)
await prime_work_schedules.resume(task_id)
await prime_work_schedules.run_now(task_id)
await prime_work_schedules.delete(task_id)
```

RRULE must be RFC 5545 without `DTSTART`; pass local start and IANA timezone separately. Never invent another project path or session ID: this capability is intentionally restricted to the current project/thread.
