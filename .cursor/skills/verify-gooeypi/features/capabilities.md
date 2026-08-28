# Capabilities

The Capabilities page is the directory of packages, plugins, extensions, MCP
servers, and reusable skills for the active harness. It titles as
`Extend <harness>` and exposes `Capabilities` and `Skills` tabs with a filtered
directory list.

## Sub-features

- `cap-open` opens the capabilities directory for the active harness.
- `cap-tabs` switches between the `Capabilities` and `Skills` tabs.
- `cap-directory` shows the directory heading with a shown-count.

## How to get to it (user POV)

- Click `Capabilities` in the sidebar.
- Within the page, switch the `Capabilities` / `Skills` tab buttons.

## Driving it with gooeypi-control

Preconditions:

- Doctor is green.

- **Open the directory.** Run
  `xvfb-run -a node .cursor/skills/verify-gooeypi/control.mjs drive capabilities --out /tmp/gooeypi-verify/capabilities`.
  Expected `PROVEN:` line: `Capabilities page shows "Extend <harness>" h1 and a
  Capabilities directory heading`.
- **Proof.** The run writes `capabilities.png` (plus `.aria.txt`) showing the
  `Extend <harness>` title, the Capabilities/Skills tabs, and the directory
  heading with a `N shown` count.

## Gotchas

- The word `Capabilities` appears three ways: the sidebar button, the in-page tab
  button, and the level-2 directory heading. Matching `Capabilities` by role
  `button` hits both the sidebar and the tab (strict-mode failure); assert the
  level-1 `^Extend ` heading and the level-2 `Capabilities` directory heading.
- The exact harness word in `Extend <harness>` depends on the active harness
  (Pi/OMP/Prime), which the switcher in the top-left controls; do not hard-code it.
- Network MCP capabilities render but are read-only in GooeyPi; a row appearing
  is not proof it was installed by this run.
