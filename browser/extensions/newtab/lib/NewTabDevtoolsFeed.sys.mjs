/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  actionCreators as ac,
  actionTypes as at,
} from "resource://newtab/common/Actions.mjs";
import { Prefs } from "resource://newtab/lib/ActivityStreamPrefs.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  ExperimentAPI: "resource://nimbus/ExperimentAPI.sys.mjs",
});

ChromeUtils.defineLazyGetter(lazy, "logConsole", function () {
  return console.createInstance({
    prefix: "NewTabDevtoolsFeed",
    maxLogLevel: "Warn",
  });
});

const DEVTOOLS_ENABLED_PREF = "asrouter.devtoolsEnabled";

/**
 * The parent side of the newtab devtools' Feature availability section:
 * evaluates live Nimbus recipes for a simulated audience, and applies or
 * resets that audience on this profile. Does nothing unless
 * browser.newtabpage.activity-stream.asrouter.devtoolsEnabled is set.
 */
export class NewTabDevtoolsFeed {
  constructor() {
    this._prefs = new Prefs();
    // Mirrors what was last broadcast with DISCOVERY_STREAM_DEV_CHANGES.
    this._devtoolsChangesJSON = "[]";
    // The devtools actions, handled one at a time.
    this._devtoolsQueue = Promise.resolve();
  }

  /**
   * Describes what the devtools changed that is still in effect, for the
   * notice on New Tab. Empty unless the devtools are enabled.
   *
   * @returns {string[]}
   */
  getDevtoolsChanges() {
    if (!this._prefs.get(DEVTOOLS_ENABLED_PREF)) {
      return [];
    }
    // Nothing yet changes the profile.
    return [];
  }

  /**
   * Tells New Tab what the devtools changed, for its notice. Called after each
   * devtools action rather than for every pref change, since what it reports
   * also depends on the region, the app locale and Nimbus.
   */
  _broadcastDevtoolsChanges() {
    const changes = this.getDevtoolsChanges();
    const json = JSON.stringify(changes);
    if (json === this._devtoolsChangesJSON) {
      return;
    }
    this._devtoolsChangesJSON = json;
    this.store.dispatch(
      ac.BroadcastToContent({
        type: at.DISCOVERY_STREAM_DEV_CHANGES,
        data: changes,
      })
    );
  }

  onAction(action) {
    switch (action.type) {
      case at.INIT:
        // After Nimbus has loaded its enrollments, so forced ones are counted.
        this._devtoolsQueue = this._devtoolsQueue
          .then(() => lazy.ExperimentAPI.ready())
          .then(() => this._broadcastDevtoolsChanges())
          .catch(e =>
            lazy.logConsole.error("Failed to describe the devtools changes", e)
          );
        break;
      case at.PREF_CHANGED:
        // Covers changes from outside the pane: the region, Nimbus updates
        // (trainhopConfig and the like), and prefs reverted elsewhere. Cheap
        // without the devtools, and deduped with them.
        this._broadcastDevtoolsChanges();
        break;
    }
  }
}
