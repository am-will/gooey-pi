# Sidebar navigation

The left sidebar switches the main pane between the workspace and the Projects,
Activity, Scheduled, and Capabilities pages. Each destination proves itself by
its level-1 heading, so navigation is verifiable without any harness installed.

## Sub-features

- `nav-projects` opens the Projects library (`Projects` heading).
- `nav-activity` opens the Activity view (`Activity` heading).
- `nav-scheduled` opens the Automation Desk (`Scheduled` heading).
- `nav-capabilities` opens the capabilities directory (`Extend <harness>` heading).

## How to get to it (user POV)

- Click a sidebar item: `Projects`, `Activity`, `Scheduled`, or `Capabilities`.
- `New session` and `Search` at the top return to / focus the workspace.

## Driving it with gooeypi-control

Preconditions:

- Doctor is green: `xvfb-run -a node .cursor/skills/verify-gooeypi/control.mjs doctor` exits 0 and prints window title `GooeyPi`.
- The build exists (`out/main/index.js`).

- **Visit every page.** Click each sidebar button in turn and confirm its
  heading. Run `xvfb-run -a node .cursor/skills/verify-gooeypi/control.mjs drive navigation --out /tmp/gooeypi-verify/navigation`.
  Expected `PROVEN:` lines: `Projects -> level-1 heading Projects`,
  `Activity -> level-1 heading Activity`, `Scheduled -> level-1 heading Scheduled`,
  `Capabilities -> level-1 heading /^Extend /`.
- **Proof.** The run writes `nav-projects.png`, `nav-activity.png`,
  `nav-scheduled.png`, and `nav-capabilities.png` (plus `.aria.txt` snapshots) to
  the `--out` dir. The Scheduled shot shows the `AUTOMATION DESK` kicker and
  `No active schedules`; the Capabilities shot shows the Capabilities/Skills tabs.

## Gotchas

- On a fresh `HOME` the `No Pi family harness detected` modal makes the shell
  `inert`; the driver dismisses it first. If you drive manually, close that modal
  (its `Close` button) before clicking the sidebar or every click times out.
- The Capabilities heading is `Extend <active harness>` (e.g. `Extend OMP`), not
  the literal word "Capabilities"; assert the `^Extend ` heading or the level-2
  `Capabilities` directory heading, not the sidebar button text.
- `Scheduled` and `Capabilities` also appear as words elsewhere (kicker, tabs);
  match on the level-1 heading to avoid strict-mode ambiguity.
