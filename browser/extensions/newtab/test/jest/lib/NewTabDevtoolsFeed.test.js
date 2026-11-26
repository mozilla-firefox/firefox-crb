/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

import { actionTypes as at } from "common/Actions.mjs";
import { mockServices, stubGlobals } from "test/jest/test-utils";
import { NewTabDevtoolsFeed } from "lib/NewTabDevtoolsFeed.sys.mjs";

describe("NewTabDevtoolsFeed", () => {
  let feed;
  let FAKE_PREFS;
  let services;
  let region;
  let restoreGlobals;
  beforeEach(() => {
    FAKE_PREFS = new Map();
    services = mockServices(["prefs", "obs", "vc"]);
    region = { home: "US", REGION_TOPIC: "browser-region-updated" };
    restoreGlobals = stubGlobals({ Region: region, Services: services });
    feed = new NewTabDevtoolsFeed();
    feed.store = { dispatch: jest.fn() };
    feed._prefs = {
      get: jest.fn(item => FAKE_PREFS.get(item)),
      set: jest.fn((name, value) => FAKE_PREFS.set(name, value)),
      reset: jest.fn(),
      _branchStr: "branch.str.",
    };
  });
  afterEach(() => {
    restoreGlobals();
    jest.restoreAllMocks();
  });

  describe("with the devtools off", () => {
    it("should not describe or broadcast anything on init or pref changes", async () => {
      const restore = stubGlobals({
        ExperimentAPI: { ready: jest.fn().mockResolvedValue() },
      });
      feed.onAction({ type: at.INIT });
      await feed._devtoolsQueue;
      feed.onAction({ type: at.PREF_CHANGED, data: { name: "x" } });
      expect(feed.getDevtoolsChanges()).toEqual([]);
      expect(feed.store.dispatch).not.toHaveBeenCalled();
      restore();
    });
  });
});
