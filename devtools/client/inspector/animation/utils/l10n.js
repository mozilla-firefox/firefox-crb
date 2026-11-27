/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const { LocalizationHelper } = require("resource://devtools/shared/l10n.js");

loader.lazyGetter(this, "L10N", () => {
  return new Localization(["devtools/client/animation-inspector.ftl"], true);
});
const INSPECTOR_L10N = new LocalizationHelper(
  "devtools/client/locales/inspector.properties"
);

const TITLE_IDS = {
  cssanimation: "animation-inspector-css-animation-name",
  csstransition: "animation-inspector-css-transition-name",
  scriptanimation: "animation-inspector-script-animation-name",
};

/**
 * Get a formatted title for this animation. This will be either:
 * "name", "name — CSS Transition", "name — CSS Animation",
 * "name — Script Animation", or "Script Animation", depending
 * if the server provides the type, what type it is and if the animation
 * has a name.
 *
 * @param {object} state
 */
function getFormattedTitle(state) {
  // Older servers don't send a type, and only know about
  // CSSAnimations and CSSTransitions, so it's safe to use
  // just the name.
  if (!state.type) {
    return state.name;
  }

  // Script-generated animations may not have a name.
  if (state.type === "scriptanimation" && !state.name) {
    return getStr("animation-inspector-script-animation-unnamed");
  }

  const id = TITLE_IDS[state.type];
  return id ? getStr(id, { name: state.name }) : state.name;
}

function getStr(id, args) {
  return L10N.formatValueSync(id, args);
}

module.exports = {
  getFormattedTitle,
  getInspectorStr: (...args) => INSPECTOR_L10N.getStr(...args),
  getStr,
};
