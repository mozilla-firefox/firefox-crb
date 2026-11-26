/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The locale and channel New Tab bases its defaults and content requests on.
 * Kept free of other New Tab imports so the feeds can import it statically
 * without pulling in ActivityStream.sys.mjs.
 */

// eslint-disable-next-line mozilla/use-static-import
const { AppConstants } = ChromeUtils.importESModule(
  "resource://gre/modules/AppConstants.sys.mjs"
);

export const PREF_DEVTOOLS_ENABLED =
  "browser.newtabpage.activity-stream.asrouter.devtoolsEnabled";
// Set by the newtab devtools so this profile's region, locale and channel
// dependent defaults match another locale and channel. Ignored unless the
// devtools are enabled.
export const PREF_DEVTOOLS_LOCALE_OVERRIDE =
  "browser.newtabpage.activity-stream.devtools.localeOverride";
export const PREF_DEVTOOLS_CHANNEL_OVERRIDE =
  "browser.newtabpage.activity-stream.devtools.channelOverride";
export const DEVTOOLS_OVERRIDE_PREFS = [
  PREF_DEVTOOLS_ENABLED,
  PREF_DEVTOOLS_LOCALE_OVERRIDE,
  PREF_DEVTOOLS_CHANNEL_OVERRIDE,
];

/**
 * The channel whose defaults this build uses: "nightly" for any Nightly build,
 * including local ones, else the update channel.
 *
 * @returns {string}
 */
export function buildChannel() {
  return AppConstants.NIGHTLY_BUILD
    ? "nightly"
    : AppConstants.MOZ_UPDATE_CHANNEL;
}

/**
 * The locale New Tab uses for its defaults and content requests: the app
 * locale, unless the newtab devtools have applied another one.
 *
 * @returns {string}
 */
export function newtabLocale() {
  return (
    (Services.prefs.getBoolPref(PREF_DEVTOOLS_ENABLED, false) &&
      Services.prefs.getStringPref(PREF_DEVTOOLS_LOCALE_OVERRIDE, "")) ||
    Services.locale.appLocaleAsBCP47
  );
}

/**
 * The channel New Tab uses for its channel dependent defaults: this build's,
 * unless the newtab devtools have applied another one.
 *
 * @returns {string}
 */
export function newtabChannel() {
  return (
    (Services.prefs.getBoolPref(PREF_DEVTOOLS_ENABLED, false) &&
      Services.prefs.getStringPref(PREF_DEVTOOLS_CHANNEL_OVERRIDE, "")) ||
    buildChannel()
  );
}
