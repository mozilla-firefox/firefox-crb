/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

import { actionCreators as ac, actionTypes as at } from "common/Actions.mjs";
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

  describe("devtools feature availability", () => {
    let evaluateJexl;
    let restoreNimbus;
    let userBranch;
    let defaultBranch;
    let fetchStub;
    // A minimal nsIPrefBranch over a Map of values.
    const fakeBranch = values => ({
      PREF_INVALID: 0,
      PREF_BOOL: 128,
      PREF_INT: 64,
      PREF_STRING: 32,
      values,
      getChildList: () => [...values.keys()],
      prefHasUserValue: name => values.has(name),
      getPrefType: name =>
        ({ boolean: 128, number: 64, string: 32 })[typeof values.get(name)] ??
        0,
      getBoolPref: name => values.get(name),
      getIntPref: name => values.get(name),
      getStringPref: name => values.get(name),
      setBoolPref: (name, value) => values.set(name, value),
      setIntPref: (name, value) => values.set(name, value),
      setStringPref: (name, value) => values.set(name, value),
      clearUserPref: jest.fn(name => values.delete(name)),
    });
    let releaseVersions;
    const RECIPES = [
      {
        slug: "de-rollout",
        featureIds: ["newtabTrainhop"],
        isRollout: true,
        bucketConfig: { count: 5000, total: 10000 },
        locales: ["de"],
        userFacingDescription: "Germany only",
        targeting:
          "region in ['DE'] && locale in ['de', 'en-GB'] && (region in ['US']) != true && version|versionCompare('67.!') >= 0 && 'x'|preferenceValue",
        branches: [
          {
            slug: "control",
            features: [
              {
                featureId: "newtabTrainhop",
                value: {
                  type: "multi-payload",
                  payload: [
                    { type: "widgets", payload: { listsEnabled: true } },
                    { type: "widgetCrossword", payload: { visible: false } },
                  ],
                },
              },
            ],
          },
          {
            slug: "treatment",
            features: [
              {
                featureId: "newtabTrainhop",
                value: { type: "widgetCrossword", payload: { visible: true } },
              },
            ],
          },
          { slug: "empty", features: [] },
        ],
      },
      {
        slug: "sections",
        featureIds: ["newTabSectionsExperiment"],
        targeting: "region in ['FR']",
        branches: [{ slug: "treatment", features: [] }],
      },
      {
        slug: "second-rollout",
        featureIds: ["newtabTrainhop"],
        isRollout: true,
        targeting: "true",
        branches: [{ slug: "control", features: [] }],
      },
      {
        slug: "engagers",
        featureIds: ["newtabTrainhop"],
        isRollout: true,
        targeting:
          "'browser.newtabpage.activity-stream.widgets.lists.interaction'|preferenceValue",
      },
      { slug: "not-newtab", featureIds: ["urlbar"], targeting: "true" },
    ];

    beforeEach(() => {
      FAKE_PREFS.set("asrouter.devtoolsEnabled", true);
      releaseVersions = {
        nightly: "158.0",
        beta: "157.0",
        release: "156.0",
      };
      fetchStub = jest.fn(async url => ({
        ok: true,
        json: async () =>
          url.endsWith("/esr/")
            ? { 155: ["140.15.0", "153.2.0"], 156: ["140.16.0", "153.3.0"] }
            : { version: releaseVersions[url.split("=")[1]] },
      }));
      services.vc = {
        compare: (a, b) => {
          const [x, y] = [a, b].map(v => v.split(".").map(Number));
          return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
        },
      };
      userBranch = fakeBranch(new Map());
      defaultBranch = fakeBranch(new Map());
      services.prefs.getBranch = jest.fn(() => userBranch);
      services.prefs.getDefaultBranch = jest.fn(() => defaultBranch);
      services.locale = {
        appLocaleAsBCP47: "en-US",
        availableLocales: ["en-US", "fr"],
      };
      services.intl = {
        getAvailableLocaleDisplayNames: () => ["de", "us", "419"],
        getRegionDisplayNames: (_, codes) => codes.map(c => `Region ${c}`),
        getLocaleDisplayNames: (_, codes) => codes.map(c => `Locale ${c}`),
      };
      evaluateJexl = jest.fn(async (targeting, context) =>
        ["true", "false"].includes(targeting)
          ? targeting === "true"
          : targeting.includes(`'${context.region}'`)
      );
      // Stands in for TargetingContext, evaluating against whatever ctx the
      // feed assigns.
      class FakeTargetingContext {
        static combineContexts(overrides) {
          return overrides;
        }
        evalWithDefault(targeting) {
          return evaluateJexl(targeting, this.ctx);
        }
      }
      restoreNimbus = stubGlobals({
        ASRouterTargeting: { Environment: {} },
        TargetingContext: FakeTargetingContext,
        ExperimentAPI: {
          manager: {
            createTargetingContext: jest.fn(() => ({})),
            store: {
              // This profile's own enrollment.
              get: jest.fn(slug =>
                slug === "de-rollout"
                  ? { active: true, branch: { slug: "natural" } }
                  : null
              ),
            },
          },
        },
        RemoteSettings: jest.fn(() => ({
          get: jest.fn(() => Promise.resolve(RECIPES)),
        })),
        fetch: fetchStub,
        AbortSignal: { timeout: jest.fn() },
      });
    });
    afterEach(() => restoreNimbus());

    it("should only evaluate newtab recipes, with the overridden attributes", async () => {
      const { recipes } = await feed.getAvailability({
        region: "DE",
        locale: "de",
        channel: "beta",
        version: "150.0",
      });

      expect(recipes.map(r => r.slug)).toEqual([
        "de-rollout",
        "sections",
        "second-rollout",
        "engagers",
      ]);
      expect(recipes[0]).toMatchObject({
        matches: true,
        bucketPercent: 50,
        enrolledBranch: "natural",
      });
      expect(recipes[1]).toMatchObject({
        matches: false,
        enrolledBranch: null,
      });
      expect(evaluateJexl).toHaveBeenCalledWith(
        RECIPES[0].targeting,
        expect.objectContaining({
          region: "DE",
          locale: "de",
          localeLanguageCode: "de",
          version: "150.0",
          firefoxVersion: 150,
          channel: "beta",
          browserSettings: { update: { channel: "beta" } },
          activeExperiments: [],
          activeRollouts: [],
          experiment: RECIPES[0],
        })
      );
    });

    it("should describe each recipe, the widgets it makes available and what it reads from the profile", async () => {
      const {
        recipes: [recipe, other],
      } = await feed.getAvailability({ region: "DE", locale: "de" });

      expect(recipe.userFacingDescription).toBe("Germany only");
      expect(recipe.widgets).toEqual([
        { branch: "control", widgets: ["lists"] },
        { branch: "treatment", widgets: ["crossword"] },
      ]);
      expect(recipe.profileTargeting).toEqual(["pref values"]);
      expect(other.widgets).toEqual([]);
      expect(other.profileTargeting).toEqual([]);
    });

    it("should offer every region and the recipe locales", async () => {
      const { options } = await feed.getAvailability({
        region: "DE",
        locale: "de",
        version: "150.0",
      });

      expect(options.regions.map(r => r.value)).toEqual(["DE", "US"]);
      expect(options.locales.map(l => l.value).sort()).toEqual([
        "de",
        "en-US",
        "es-MX",
        "fr",
      ]);
    });

    it("should offer the global feeds, then the targeted audiences, skipping negated regions", async () => {
      const { options } = await feed.getAvailability({});
      expect(options.presets).toEqual([
        {
          region: "AU",
          locale: "en-US",
          label: "Global English feed (AU, en-US)",
        },
        {
          region: "MX",
          locale: "es-MX",
          label: "Global Spanish feed (MX, es-MX)",
        },
        {
          region: "DE",
          locale: "de",
          label: "Region DE, Locale de (DE, de): 1 recipe",
        },
        {
          region: "DE",
          locale: "en-GB",
          label: "Region DE, Locale en-GB (DE, en-GB): 1 recipe",
        },
      ]);
    });

    it("should offer the current channel versions from whattrainisitnow.com", async () => {
      const { options } = await feed.getAvailability({ version: "150.0" });
      expect(options.versions).toEqual([
        { value: "158.0a1", label: "Nightly 158", channel: "nightly" },
        { value: "157.0", label: "Beta 157", channel: "beta" },
        { value: "156.0", label: "Release 156", channel: "release" },
        {
          value: "155.0",
          label: "Release 155 (Release -1)",
          channel: "release",
        },
        {
          value: "154.0",
          label: "Release 154 (Release -2)",
          channel: "release",
        },
        {
          value: "153.0",
          label: "Release 153 (Release -3)",
          channel: "release",
        },
        { value: "153.3.0", label: "ESR 153.3.0", channel: "esr" },
        { value: "69.0a1", label: "This build (69.0a1)" },
        { value: "150.0", label: "150.0", channel: "" },
      ]);

      await feed.getAvailability({});
      expect(fetchStub).toHaveBeenCalledTimes(4);
    });

    describe("without whattrainisitnow.com", () => {
      // The modules keep the AppConstants object they loaded, so change it in
      // place.
      let savedAppConstants;
      const asBuild = constants => {
        savedAppConstants = { ...globalThis.AppConstants };
        Object.assign(globalThis.AppConstants, constants);
      };
      afterEach(() => {
        for (const key of Object.keys(globalThis.AppConstants)) {
          delete globalThis.AppConstants[key];
        }
        Object.assign(globalThis.AppConstants, savedAppConstants);
      });

      it("should estimate the versions from a Nightly build", async () => {
        asBuild({ NIGHTLY_BUILD: true });
        fetchStub.mockRejectedValue(new Error("offline"));
        const { options } = await feed.getAvailability({});
        expect(options.versions.map(v => v.label)).toEqual([
          "Nightly 69 (estimated)",
          "Beta 68 (estimated)",
          "Release 67 (estimated)",
          "Release 66 (Release -1) (estimated)",
          "Release 65 (Release -2) (estimated)",
          "Release 64 (Release -3) (estimated)",
        ]);
      });

      it("should estimate the versions from a Beta build", async () => {
        asBuild({ MOZ_APP_VERSION: "68.0", MOZ_UPDATE_CHANNEL: "beta" });
        fetchStub.mockRejectedValue(new Error("offline"));
        const { options } = await feed.getAvailability({});
        expect(options.versions.slice(0, 3).map(v => v.label)).toEqual([
          "Nightly 69 (estimated)",
          "Beta 68 (estimated)",
          "Release 67 (estimated)",
        ]);
      });

      it("should not guess the versions from an ESR build", async () => {
        asBuild({ MOZ_APP_VERSION: "140.5.0", MOZ_UPDATE_CHANNEL: "esr" });
        fetchStub.mockRejectedValue(new Error("offline"));
        const { options } = await feed.getAvailability({});
        expect(options.versions.map(v => v.label)).toEqual([
          "This build (140.5.0)",
        ]);
      });
    });

    it("should keep the versions it could fetch when others fail", async () => {
      fetchStub.mockImplementation(async url => {
        if (url.endsWith("/esr/") || url.endsWith("=release")) {
          throw new Error("offline");
        }
        return {
          ok: true,
          json: async () => ({ version: releaseVersions[url.split("=")[1]] }),
        };
      });
      const { options } = await feed.getAvailability({});
      expect(options.versions.slice(0, 3).map(v => v.label)).toEqual([
        "Nightly 158",
        "Beta 157",
        "Release 156 (estimated)",
      ]);
      expect(options.versions.some(v => v.channel === "esr")).toBe(false);

      // Not cached, so the next request tries again.
      await feed.getAvailability({});
      expect(fetchStub).toHaveBeenCalledTimes(8);
    });

    it("should default to the locale and channel the devtools applied", async () => {
      services.prefs.getBoolPref = jest.fn(
        name =>
          name === "browser.newtabpage.activity-stream.asrouter.devtoolsEnabled"
      );
      services.prefs.getStringPref = jest.fn((name, fallback) => {
        switch (name) {
          case "browser.newtabpage.activity-stream.devtools.localeOverride":
            return "pl";
          case "browser.newtabpage.activity-stream.devtools.channelOverride":
            return "release";
        }
        return fallback;
      });
      const { locale, channel } = await feed.getAvailability({});
      expect({ locale, channel }).toEqual({ locale: "pl", channel: "release" });
    });

    it("should simulate region dependent prefs", async () => {
      const { prefs } = await feed.getAvailability({
        region: "DE",
        locale: "de",
      });
      expect(prefs.find(p => p.name === "weather.temperatureUnits")).toEqual(
        expect.objectContaining({ simulated: "c" })
      );
    });

    it("should ignore requests when devtools are disabled", async () => {
      FAKE_PREFS.set("asrouter.devtoolsEnabled", false);
      await feed._handleDevtoolsAction(
        ac.OnlyToMain(
          { type: at.DISCOVERY_STREAM_DEV_AVAILABILITY_REQUEST },
          "tab-1"
        )
      );
      expect(feed.store.dispatch).not.toHaveBeenCalled();
    });

    it("should reply to the requesting tab only", async () => {
      await feed._handleDevtoolsAction(
        ac.OnlyToMain(
          { type: at.DISCOVERY_STREAM_DEV_AVAILABILITY_REQUEST },
          "tab-1"
        )
      );
      const [[reply]] = feed.store.dispatch.mock.calls;
      expect(reply.type).toBe(at.DISCOVERY_STREAM_DEV_AVAILABILITY_UPDATE);
      expect(reply.meta.toTarget).toBe("tab-1");
    });

    it("should answer with an error instead of staying silent", async () => {
      globalThis.RemoteSettings.mockImplementation(() => ({
        get: () => Promise.reject(new Error("no collection")),
      }));
      await feed._handleDevtoolsAction(
        ac.OnlyToMain(
          { type: at.DISCOVERY_STREAM_DEV_AVAILABILITY_REQUEST },
          "tab-1"
        )
      );
      const [[reply]] = feed.store.dispatch.mock.calls;
      expect(reply.data).toEqual({ error: "Error: no collection" });
    });

    it("should keep handling devtools actions after one fails", async () => {
      const handled = [];
      jest
        .spyOn(feed, "_handleDevtoolsAction")
        .mockImplementationOnce(() => Promise.reject(new Error("boom")))
        .mockImplementation(async action => handled.push(action.type));
      const request = () =>
        feed.onAction(
          ac.OnlyToMain(
            { type: at.DISCOVERY_STREAM_DEV_AVAILABILITY_REQUEST },
            "tab-1"
          )
        );
      request();
      request();
      await feed._devtoolsQueue;
      expect(handled).toEqual([at.DISCOVERY_STREAM_DEV_AVAILABILITY_REQUEST]);
    });

    it("should simulate double-quoted interaction targeting and not call it profile dependent", async () => {
      globalThis.RemoteSettings.mockImplementation(() => ({
        get: async () => [
          {
            slug: "double-quoted",
            featureIds: ["newtabTrainhop"],
            isRollout: true,
            targeting:
              '"browser.newtabpage.activity-stream.widgets.lists.interaction"|preferenceValue',
          },
        ],
      }));
      const {
        recipes: [recipe],
      } = await feed.getAvailability({ widgetsInteracted: true });
      expect(recipe.matches).toBe(true);
      expect(recipe.profileTargeting).toEqual([]);
    });

    it("should not evaluate anything but a boolean as the widget interaction", async () => {
      const injected = "false || ('services.sync.username'|preferenceValue)";
      await feed.getAvailability({ widgetsInteracted: injected });
      for (const [targeting] of evaluateJexl.mock.calls) {
        expect(targeting).not.toContain("services.sync.username");
      }
    });

    it("should fetch versions without credentials and check the response", async () => {
      fetchStub.mockResolvedValue({ ok: false, json: async () => ({}) });
      const { options } = await feed.getAvailability({});
      expect(options.versions.some(v => v.label === "Nightly 158")).toBe(false);
      expect(fetchStub).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ credentials: "omit" })
      );
    });
  });
});
