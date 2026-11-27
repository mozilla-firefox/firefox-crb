/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const STYLE_EDITOR_PREF = "devtools.styleeditor.enabled";
const COLOR_UNIT_PREF = "devtools.defaultColorUnit";

add_task(test_locked_controls);

registerCleanupFunction(() => {
  Services.prefs.unlockPref(STYLE_EDITOR_PREF);
  Services.prefs.unlockPref(COLOR_UNIT_PREF);
});

async function test_locked_controls() {
  Services.prefs.lockPref(STYLE_EDITOR_PREF);
  Services.prefs.lockPref(COLOR_UNIT_PREF);
  const { root } = await openSettings();
  const styleEditorCheckbox = root.shadowRoot.querySelector(
    "#settings-tool-styleeditor"
  );
  const colorUnitSelect = await getSelect(
    root,
    "#settings-inspector-color-unit"
  );

  ok(styleEditorCheckbox.disabled, "A locked pref disables its checkbox");
  ok(colorUnitSelect.disabled, "A locked pref disables its select");

  await closeTabAndToolbox();
}
