# Settings

Settings opens over the workspace as a sectioned page (General, Appearance,
Harness, Providers, Voice, Pets, Browser, Terminal, Privacy, About). A user
opens it, switches sections, and closes it back to the workspace.

## Sub-features

- `settings-open` opens Settings on the `General` section.
- `settings-section` switches to another section by its sidebar button.
- `settings-close` closes Settings and returns to the app shell.

## How to get to it (user POV)

- Click the `Settings` button in the sidebar footer.
- The keyboard shortcut `Ctrl+,` (macOS `⌘+,`) also opens Settings.
- Section switches are the buttons named `General`, `Appearance`, `Harness`,
  `Providers`, `Voice`, `Pets`, etc.

## Driving it with gooeypi-control

Preconditions:

- Doctor is green.

- **Open and tour sections.** Open Settings, then visit Appearance and Pets. Run
  `xvfb-run -a node .cursor/skills/verify-gooeypi/control.mjs drive settings --out /tmp/gooeypi-verify/settings`.
  Expected `PROVEN:` lines: `Settings opened -> "General" heading visible`,
  `Settings section "Appearance" -> heading visible`,
  `Settings section "Pets" -> heading visible`,
  `Escape closed Settings -> returned to app shell`.
- **Proof.** The run writes `settings-general.png`, `settings-appearance.png`,
  and `settings-pets.png` (plus `.aria.txt`) to the `--out` dir. Appearance shows
  the System/Light/Dark theme control; Pets shows the active companion and size
  slider.

## Gotchas

- The Settings section headings collide with other page text; assert the heading
  role (e.g. `heading` name `Pets` exact) rather than any occurrence of the word.
- `Escape` closes Settings via its focus trap. If a section has focus inside a
  text field, `Escape` still closes the page here, but verify the app shell is
  visible again (`.app-shell[data-ready="true"]`) rather than assuming.
- Opening Settings from a fresh `HOME` still works; the `Harness` section will
  report no detected harness, which is expected verification state.
