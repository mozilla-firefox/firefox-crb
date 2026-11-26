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
    let updateRecipes;
    let restoreNimbus;
    let forcedSlugs;
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
    let langpacks;
    let installedLocales;
    let ensureLangPackInstalled;
    let optIn;
    let nimbusDebug;
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
        get requestedLocales() {
          return [this.appLocaleAsBCP47];
        },
        set requestedLocales([locale]) {
          this.appLocaleAsBCP47 = locale;
        },
        negotiateLanguages: ([requested], available) =>
          available.filter(
            locale => locale === requested || locale === requested.split("-")[0]
          ),
      };
      langpacks = [];
      installedLocales = ["en-US", "fr"];
      ensureLangPackInstalled = jest.fn(async ({ target_locale }) => {
        installedLocales.push(target_locale);
        return true;
      });
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
      updateRecipes = jest.fn(() => Promise.resolve());
      forcedSlugs = new Set();
      optIn = jest.fn(async ({ slug }) => forcedSlugs.add(`optin-${slug}`));
      nimbusDebug = true;
      services.prefs.getBoolPref = jest.fn((name, fallback) =>
        name === "nimbus.debug" ? nimbusDebug : fallback
      );
      region._setHomeRegion = jest.fn(home => (region.home = home));
      restoreNimbus = stubGlobals({
        ASRouterTargeting: { Environment: {} },
        AddonManager: {
          getInstallForURL: jest.fn(async url => ({
            install: jest.fn(async () => {
              installedLocales.push(url.match(/\.([\w-]+)\.langpack\.xpi$/)[1]);
            }),
          })),
        },
        LangPackMatcher: {
          getAvailableLocales: async () => installedLocales,
          ensureLangPackInstalled,
          mockable: { getAvailableLangpacks: jest.fn(async () => langpacks) },
        },
        TargetingContext: FakeTargetingContext,
        UnenrollmentCause: { fromReason: reason => ({ reason }) },
        NimbusTelemetry: {
          UnenrollReason: { FORCE_ENROLLMENT: "force-enrollment" },
        },
        ExperimentAPI: {
          manager: {
            createTargetingContext: jest.fn(() => ({})),
            store: {
              get: jest.fn(slug => {
                if (forcedSlugs.has(slug)) {
                  return { active: true, branch: { slug: "control" } };
                }
                // This profile's own enrollment, on a branch the tests don't
                // force.
                return slug === "de-rollout"
                  ? { active: true, branch: { slug: "natural" } }
                  : null;
              }),
              getAll: () => [],
              ready: jest.fn(() => Promise.resolve()),
            },
            unenroll: jest.fn(slug => forcedSlugs.delete(slug)),
          },
          optInToExperiment: optIn,
          ready() {
            return this.manager.store.ready();
          },
          studiesEnabled: true,
          _rsLoader: {
            updateRecipes,
            finishedUpdating: jest.fn(() => Promise.resolve()),
          },
        },
        RemoteSettings: jest.fn(() => ({
          get: jest.fn(() => Promise.resolve(RECIPES)),
        })),
        fetch: fetchStub,
        AbortSignal: { timeout: jest.fn() },
      });
      feed._prefs.reset = jest.fn(name => FAKE_PREFS.delete(name));
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
        ac.OnlyToMain({
          type: at.DISCOVERY_STREAM_DEV_AVAILABILITY_APPLY,
          data: { region: "DE" },
        })
      );
      expect(region._setHomeRegion).not.toHaveBeenCalled();
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

    it("should reply with this browser's values after a reset", async () => {
      await feed.applyRegion("DE");
      await feed._handleDevtoolsAction(
        ac.OnlyToMain(
          { type: at.DISCOVERY_STREAM_DEV_AVAILABILITY_RESET },
          "tab-1"
        )
      );
      const [{ data }] = feed.store.dispatch.mock.calls.at(-1);
      expect(data).toMatchObject({
        region: "US",
        locale: "en-US",
        version: "69.0a1",
      });
      expect(data.originalRegion).toBeUndefined();
    });

    describe("region", () => {
      it("should reject an invalid region", async () => {
        await feed.applyRegion("Germany");
        expect(region._setHomeRegion).not.toHaveBeenCalled();
      });

      it("should remember the original region across applies and restore it on reset", async () => {
        await feed.applyRegion("de");
        await feed.applyRegion("FR");

        expect(region._setHomeRegion).toHaveBeenLastCalledWith("FR");
        expect(FAKE_PREFS.get("devtools.originalRegion")).toBe("US");
        // Nimbus isn't re-evaluated for the applied region, so this client
        // isn't enrolled in live recipes for an audience it isn't in.
        expect(updateRecipes).not.toHaveBeenCalled();

        await feed.reset();
        expect(updateRecipes).toHaveBeenCalledWith("newtab-devtools");

        expect(region._setHomeRegion).toHaveBeenLastCalledWith("US");
        expect(FAKE_PREFS.has("devtools.originalRegion")).toBe(false);
      });

      it("should clear browser.search.region on reset if the region was never detected", async () => {
        region.home = null;
        await feed.applyRegion("DE");
        region._setHomeRegion.mockClear();

        await feed.reset();

        expect(region._setHomeRegion).not.toHaveBeenCalled();
        expect(services.prefs.clearUserPref).toHaveBeenCalledWith(
          "browser.search.region"
        );
      });
    });

    it("should apply everything but the enrollments without nimbus.debug", async () => {
      nimbusDebug = false;
      const messages = await feed.apply({
        region: "DE",
        enrollments: { sections: "treatment" },
      });
      expect(messages).toEqual([
        "Skipped the chosen enrollments because nimbus.debug is off.",
      ]);
      expect(optIn).not.toHaveBeenCalled();
      expect(region._setHomeRegion).toHaveBeenCalledWith("DE");
    });

    it("should force-enroll like Nimbus, one rollout per feature in collection order", async () => {
      const messages = await feed.apply({
        region: "DE",
        enrollments: {
          "second-rollout": "control",
          "de-rollout": "control",
          sections: "",
        },
      });

      expect(region._setHomeRegion).toHaveBeenCalledWith("DE");
      expect(optIn.mock.calls).toEqual([
        [{ slug: "de-rollout", branch: "control" }],
      ]);
      expect(messages).toEqual([
        "Skipped second-rollout: the rollout de-rollout already uses newtabTrainhop.",
      ]);
      expect(JSON.parse(FAKE_PREFS.get("devtools.forcedEnrollments"))).toEqual([
        "optin-de-rollout",
      ]);
    });

    it("should restore prefs only after the region, so their defaults match", async () => {
      const order = [];
      region._setHomeRegion.mockImplementation(home => {
        order.push(`region ${home}`);
        region.home = home;
      });
      feed._restoreUserPrefs = jest.fn(() => order.push("prefs"));
      await feed.applyRegion("DE");
      order.length = 0;

      await feed.reset();

      expect(order).toEqual(["region US", "prefs"]);
    });

    it("should replace earlier forced enrollments and undo them on reset", async () => {
      await feed.apply({
        region: "DE",
        enrollments: { "de-rollout": "control" },
      });
      await feed.apply({
        region: "DE",
        enrollments: { "second-rollout": "control" },
      });
      const { manager } = globalThis.ExperimentAPI;
      // With a reason, so Nimbus doesn't record the cause as unknown.
      expect(manager.unenroll).toHaveBeenCalledWith("optin-de-rollout", {
        reason: "force-enrollment",
      });
      expect([...forcedSlugs]).toEqual(["optin-second-rollout"]);

      await feed.reset();

      expect(manager.unenroll).toHaveBeenCalledWith("optin-second-rollout", {
        reason: "force-enrollment",
      });
      expect(forcedSlugs.size).toBe(0);
      expect(FAKE_PREFS.has("devtools.forcedEnrollments")).toBe(false);
      expect(region._setHomeRegion).toHaveBeenLastCalledWith("US");
    });

    describe("widget interaction", () => {
      let userValues;
      beforeEach(() => {
        userValues = new Set(["widgets.lists.interaction"]);
        FAKE_PREFS.set("widgets.lists.interaction", true);
        services.prefs.getBranch = jest.fn(() => ({
          prefHasUserValue: name => userValues.has(name),
          getChildList: () => [],
        }));
        feed._prefs.reset = jest.fn(name => FAKE_PREFS.delete(name));
      });

      it("should start from this profile and simulate either way", async () => {
        const engagers = async options =>
          (await feed.getAvailability(options)).recipes.find(
            r => r.slug === "engagers"
          ).matches;

        expect((await feed.getAvailability({})).widgetsInteracted).toBe(true);
        expect(await engagers({})).toBe(true);
        expect(await engagers({ widgetsInteracted: false })).toBe(false);

        FAKE_PREFS.delete("widgets.lists.interaction");
        expect((await feed.getAvailability({})).widgetsInteracted).toBe(false);
        expect(await engagers({ widgetsInteracted: true })).toBe(true);
      });

      it("should set every interaction pref on apply and restore them on reset", async () => {
        await feed.apply({ region: "DE", widgetsInteracted: false });
        expect(FAKE_PREFS.has("widgets.lists.interaction")).toBe(false);

        await feed.apply({ region: "DE", widgetsInteracted: true });
        expect(FAKE_PREFS.get("widgets.focusTimer.interaction")).toBe(true);
        expect((await feed.getAvailability({})).devtoolsChanges).toContain(
          "widgets marked as interacted with"
        );

        await feed.reset();
        expect(FAKE_PREFS.get("widgets.lists.interaction")).toBe(true);
        expect(FAKE_PREFS.has("widgets.focusTimer.interaction")).toBe(false);
        expect(FAKE_PREFS.has("devtools.interactionBackup")).toBe(false);
      });
    });

    it("should list every changed New Tab pref next to its default", async () => {
      userBranch.values.set("topSitesRows", 3);
      userBranch.values.set("impressionId", "{id}");
      userBranch.values.set("devtools.originalRegion", "US");
      defaultBranch.values.set("topSitesRows", 1);
      FAKE_PREFS.set("devtools.touchedPrefs", JSON.stringify(["topSitesRows"]));

      const { changedPrefs } = await feed.getAvailability({});

      expect(changedPrefs).toEqual([
        {
          name: "impressionId",
          defaultValue: undefined,
          value: "{id}",
          touched: false,
        },
        { name: "topSitesRows", defaultValue: 1, value: 3, touched: true },
      ]);
    });

    describe("with the devtools turned off after Apply", () => {
      it("should describe devtools changes and reset them after the devtools are turned off", async () => {
        userBranch.values.set("widgets.system.enabled", true);
        feed.onAction(
          ac.OnlyToMain({
            type: at.DISCOVERY_STREAM_DEV_TRACK_PREFS,
            data: { names: ["widgets.system.enabled"] },
          })
        );
        // Through the action, so the notice is described after the region
        // changed rather than when devtools.originalRegion was written.
        await feed._handleDevtoolsAction(
          ac.OnlyToMain(
            {
              type: at.DISCOVERY_STREAM_DEV_AVAILABILITY_APPLY,
              data: { region: "DE", enrollments: {} },
            },
            "tab-1"
          )
        );

        const broadcasts = feed.store.dispatch.mock.calls
          .map(([action]) => action)
          .filter(a => a.type === at.DISCOVERY_STREAM_DEV_CHANGES);
        expect(broadcasts.at(-1).data).toEqual([
          "region DE (was US)",
          "1 pref changed in the devtools",
        ]);

        FAKE_PREFS.set("asrouter.devtoolsEnabled", false);
        expect(feed.getDevtoolsChanges()).toContain("region DE (was US)");

        feed.store.dispatch.mockClear();
        fetchStub.mockClear();
        await feed._handleDevtoolsAction(
          ac.OnlyToMain(
            { type: at.DISCOVERY_STREAM_DEV_AVAILABILITY_RESET },
            "tab-1"
          )
        );
        expect(feed.getDevtoolsChanges()).toEqual([]);
        const dispatched = feed.store.dispatch.mock.calls.map(([a]) => a.type);
        expect(dispatched).toContain(at.DISCOVERY_STREAM_DEV_CHANGES);
        // Nothing is evaluated or fetched for a pane that isn't there.
        expect(dispatched).not.toContain(
          at.DISCOVERY_STREAM_DEV_AVAILABILITY_UPDATE
        );
        expect(fetchStub).not.toHaveBeenCalled();
      });

      it("should only reset with the devtools off", async () => {
        FAKE_PREFS.set("asrouter.devtoolsEnabled", false);
        await feed._handleDevtoolsAction(
          ac.OnlyToMain(
            {
              type: at.DISCOVERY_STREAM_DEV_AVAILABILITY_APPLY,
              data: { region: "DE" },
            },
            "tab-1"
          )
        );
        expect(FAKE_PREFS.has("devtools.originalRegion")).toBe(false);
      });
    });

    it("should clear the prefs the devtools changed on reset", async () => {
      // The pane's SET_PREF lands before its TRACK_PREFS.
      userBranch.values.set("widgets.system.enabled", true);
      feed._trackTouchedPrefs(["widgets.system.enabled"]);
      userBranch.values.set("topSitesRows", 3);

      await feed.reset();

      expect(userBranch.values.has("widgets.system.enabled")).toBe(false);
      expect(userBranch.values.get("topSitesRows")).toBe(3);
      expect(FAKE_PREFS.has("devtools.touchedPrefs")).toBe(false);
      expect(feed.getDevtoolsChanges()).toEqual([]);
    });

    it("should enroll in every full rollout when no branches were picked", async () => {
      globalThis.RemoteSettings.mockImplementation(() => ({
        get: async () => [
          { ...RECIPES[0], bucketConfig: { count: 10000, total: 10000 } },
          RECIPES[1],
        ],
      }));
      await feed.apply({ region: "DE", useDefaultEnrollments: true });
      expect(optIn.mock.calls.map(([{ slug }]) => slug)).toEqual([
        "de-rollout",
      ]);
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

    describe("review fixes", () => {
      // One pref store for both this._prefs and the branch, as in Firefox.
      let store;
      beforeEach(() => {
        store = userBranch.values;
        store.set("asrouter.devtoolsEnabled", true);
        feed._prefs = {
          get: name => store.get(name),
          set: jest.fn((name, value) => store.set(name, value)),
          reset: jest.fn(name => store.delete(name)),
          locked: () => false,
          _branchStr: "branch.str.",
        };
      });

      it("should restore prefs after the region when applying without default prefs", async () => {
        await feed.apply({ region: "DE", defaultPrefs: true });
        const order = [];
        region._setHomeRegion.mockImplementation(home => {
          order.push(`region ${home}`);
          region.home = home;
        });
        const restore = feed._restoreUserPrefs.bind(feed);
        feed._restoreUserPrefs = () => {
          order.push("prefs");
          restore();
        };
        await feed.apply({ region: "US" });
        expect(order).toEqual(["region US", "prefs"]);
      });

      it("should keep the original interaction prefs across default-prefs applies", async () => {
        store.set("widgets.lists.interaction", true);
        await feed.apply({
          region: "DE",
          defaultPrefs: true,
          widgetsInteracted: false,
        });
        expect(store.has("widgets.lists.interaction")).toBe(false);
        await feed.apply({ region: "DE", widgetsInteracted: false });
        await feed.reset();
        expect(store.get("widgets.lists.interaction")).toBe(true);
      });

      it("should leave the interaction prefs alone when the box wasn't changed", async () => {
        store.set("widgets.lists.interaction", true);
        await feed.apply({ region: "DE", widgetsInteracted: true });
        expect(store.has("widgets.focusTimer.interaction")).toBe(false);
        expect(store.has("devtools.interactionBackup")).toBe(false);
      });

      it("should ignore malformed input from content", async () => {
        expect(() =>
          feed.onAction(
            ac.OnlyToMain(
              {
                type: at.DISCOVERY_STREAM_DEV_TRACK_PREFS,
                data: { names: "abc" },
              },
              "tab-1"
            )
          )
        ).not.toThrow();
        expect(store.has("devtools.touchedPrefs")).toBe(false);

        await feed.apply({
          region: "DE",
          locale: "not a locale!",
          channel: "evil",
          enrollments: "nope",
        });
        expect(store.has("devtools.localeOverride")).toBe(false);
        expect(store.has("devtools.channelOverride")).toBe(false);
        expect(optIn).not.toHaveBeenCalled();
      });

      it("should keep a backed-up pref the pane also changed", async () => {
        store.set("topSitesRows", 3);
        await feed.apply({ region: "DE", defaultPrefs: true });
        expect(store.has("topSitesRows")).toBe(false);
        feed._trackTouchedPrefs(["topSitesRows"]);
        store.set("topSitesRows", 5);

        await feed.reset();

        expect(store.get("topSitesRows")).toBe(3);
      });

      it("should not apply an invalid region or pick enrollments for it", async () => {
        const getAvailability = jest.spyOn(feed, "getAvailability");
        const messages = await feed.apply({
          region: "Germany",
          useDefaultEnrollments: true,
        });
        expect(region._setHomeRegion).not.toHaveBeenCalled();
        expect(getAvailability).toHaveBeenCalledWith(
          expect.objectContaining({ region: undefined })
        );
        expect(messages).toContain(
          "Ignored the region Germany, which isn't a region code."
        );
      });

      it("should only store a channel override that differs from this build's channel", async () => {
        const { AppConstants } = globalThis;
        const { MOZ_UPDATE_CHANNEL } = AppConstants;
        AppConstants.MOZ_UPDATE_CHANNEL = "beta";
        try {
          await feed.apply({ region: "DE", channel: "beta" });
          expect(store.has("devtools.channelOverride")).toBe(false);
          // "default" means this build's channel.
          await feed.apply({ region: "DE", channel: "default" });
          expect(store.has("devtools.channelOverride")).toBe(false);
          await feed.apply({ region: "DE", channel: "release" });
          expect(store.get("devtools.channelOverride")).toBe("release");
        } finally {
          AppConstants.MOZ_UPDATE_CHANNEL = MOZ_UPDATE_CHANNEL;
        }
      });

      it("should describe and reset despite malformed bookkeeping", async () => {
        store.set("devtools.originalRegion", "FR");
        for (const name of [
          "devtools.prefBackup",
          "devtools.interactionBackup",
          "devtools.originalLocales",
          "devtools.forcedEnrollments",
          "devtools.touchedPrefs",
        ]) {
          store.set(name, "{not json");
        }
        expect(() => feed.getDevtoolsChanges()).not.toThrow();
        await feed.reset();
        expect(region._setHomeRegion).toHaveBeenLastCalledWith("FR");
      });

      it("should say which of this profile's enrollments forcing one replaces", async () => {
        globalThis.ExperimentAPI.manager.store.getAll = () => [
          {
            slug: "real-rollout",
            active: true,
            isRollout: true,
            featureIds: ["newtabTrainhop"],
          },
        ];
        const messages = await feed.apply({
          region: "DE",
          enrollments: { "second-rollout": "control" },
        });
        expect(messages).toContain(
          "Forcing second-rollout replaces your enrollment in real-rollout, which Reset can't bring back."
        );
      });

      it("should turn nimbus.debug back off on reset if the devtools turned it on", async () => {
        nimbusDebug = false;
        await feed._handleDevtoolsAction(
          ac.OnlyToMain(
            { type: at.DISCOVERY_STREAM_DEV_ENABLE_NIMBUS_DEBUG },
            "tab-1"
          )
        );
        await feed.reset();
        expect(services.prefs.clearUserPref).toHaveBeenCalledWith(
          "nimbus.debug"
        );
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

      it("should not wait forever on, or trust, the langpack listing", async () => {
        // buildChannel reads the AppConstants object it was loaded with.
        const { AppConstants } = globalThis;
        AppConstants.NIGHTLY_BUILD = true;
        try {
          const text = jest.fn();
          fetchStub.mockResolvedValue({ ok: false, text });
          await expect(feed._getLangpacks()).rejects.toThrow();
          expect(text).not.toHaveBeenCalled();
          expect(fetchStub).toHaveBeenCalledWith(
            expect.stringContaining("archive.mozilla.org"),
            expect.objectContaining({ signal: undefined })
          );
        } finally {
          AppConstants.NIGHTLY_BUILD = false;
        }
      });
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

    it("should handle devtools actions one at a time", async () => {
      const order = [];
      jest.spyOn(feed, "apply").mockImplementation(async () => {
        order.push("apply start");
        await new Promise(resolve => setTimeout(resolve, 10));
        order.push("apply end");
        return [];
      });
      jest.spyOn(feed, "reset").mockImplementation(async () => {
        order.push("reset");
      });
      feed.onAction(
        ac.OnlyToMain(
          { type: at.DISCOVERY_STREAM_DEV_AVAILABILITY_APPLY, data: {} },
          "tab-1"
        )
      );
      feed.onAction(
        ac.OnlyToMain(
          { type: at.DISCOVERY_STREAM_DEV_AVAILABILITY_RESET },
          "tab-1"
        )
      );
      await feed._devtoolsQueue;
      expect(order).toEqual(["apply start", "apply end", "reset"]);
    });

    it("should refetch the content feed after apply and reset", async () => {
      const refreshes = () =>
        feed.store.dispatch.mock.calls.filter(
          ([action]) => action.type === at.DISCOVERY_STREAM_DEV_REFETCH_CONTENT
        ).length;
      const run = (type, data) =>
        feed._handleDevtoolsAction(ac.OnlyToMain({ type, data }, "tab-1"));
      await run(at.DISCOVERY_STREAM_DEV_AVAILABILITY_APPLY, { region: "DE" });
      expect(refreshes()).toBe(1);
      await run(at.DISCOVERY_STREAM_DEV_AVAILABILITY_RESET);
      expect(refreshes()).toBe(2);
      // Nothing left to reset, so nothing to refetch.
      await run(at.DISCOVERY_STREAM_DEV_AVAILABILITY_RESET);
      expect(refreshes()).toBe(2);
    });

    describe("security fixes", () => {
      it("should not evaluate anything but a boolean as the widget interaction", async () => {
        const injected = "false || ('services.sync.username'|preferenceValue)";
        await feed.getAvailability({ widgetsInteracted: injected });
        for (const [targeting] of evaluateJexl.mock.calls) {
          expect(targeting).not.toContain("services.sync.username");
        }
      });

      it("should keep this profile's consent and opt-out prefs", async () => {
        for (const name of [
          "telemetry",
          "telemetry.privatePing.enabled",
          "showSponsored",
          "showSponsoredTopSites",
          "system.showSponsored",
          "discoverystream.sections.personalization.inferred.user.enabled",
        ]) {
          userBranch.values.set(name, false);
        }
        userBranch.values.set("topSitesRows", 3);
        await feed.apply({ region: "DE", defaultPrefs: true });
        expect(userBranch.values.get("telemetry")).toBe(false);
        expect(userBranch.values.get("showSponsoredTopSites")).toBe(false);
        expect(
          userBranch.values.get(
            "discoverystream.sections.personalization.inferred.user.enabled"
          )
        ).toBe(false);
        expect(userBranch.values.has("topSitesRows")).toBe(false);
      });

      it("should only act on well-formed bookkeeping", async () => {
        FAKE_PREFS.set(
          "devtools.forcedEnrollments",
          JSON.stringify(["real-experiment", "optin-de-rollout"])
        );
        forcedSlugs.add("real-experiment");
        forcedSlugs.add("optin-de-rollout");
        FAKE_PREFS.set("devtools.originalRegion", "<script>");
        await feed.reset();
        const { manager } = globalThis.ExperimentAPI;
        expect(manager.unenroll).toHaveBeenCalledWith(
          "optin-de-rollout",
          expect.anything()
        );
        expect(manager.unenroll).not.toHaveBeenCalledWith(
          "real-experiment",
          expect.anything()
        );
        expect(region._setHomeRegion).not.toHaveBeenCalledWith("<script>");
      });

      it("should not force a branch the recipe doesn't have", async () => {
        const messages = await feed.apply({
          region: "DE",
          enrollments: { sections: "made-up" },
        });
        expect(optIn).not.toHaveBeenCalled();
        expect(messages).toContain(
          "Skipped sections: it has no branch made-up."
        );
      });

      it("should only track prefs that exist, and not too many", () => {
        const many = Array.from({ length: 600 }, (_, i) => `made.up.${i}`);
        userBranch.values.set("topSitesRows", 3);
        feed.onAction(
          ac.OnlyToMain(
            {
              type: at.DISCOVERY_STREAM_DEV_TRACK_PREFS,
              data: { names: ["topSitesRows", ...many] },
            },
            "tab-1"
          )
        );
        expect(feed._getTouchedPrefs()).toEqual(["topSitesRows"]);
      });

      it("should fetch versions without credentials and check the response", async () => {
        fetchStub.mockResolvedValue({ ok: false, json: async () => ({}) });
        const { options } = await feed.getAvailability({});
        expect(options.versions.some(v => v.label === "Nightly 158")).toBe(
          false
        );
        expect(fetchStub).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({ credentials: "omit" })
        );
      });
    });

    describe("reliability fixes", () => {
      it("should not force a branch this profile is already enrolled in", async () => {
        await feed.apply({
          region: "DE",
          enrollments: { "de-rollout": "natural" },
        });
        expect(optIn).not.toHaveBeenCalled();
      });

      it("should record each forced enrollment as soon as it succeeds", async () => {
        let release;
        optIn.mockImplementationOnce(async ({ slug }) =>
          forcedSlugs.add(`optin-${slug}`)
        );
        optIn.mockImplementationOnce(
          () => new Promise(resolve => (release = resolve))
        );
        const applying = feed.apply({
          region: "DE",
          enrollments: { "de-rollout": "control", sections: "treatment" },
        });
        await new Promise(resolve => setTimeout(resolve, 0));
        // As if the browser closed while the second opt-in was pending.
        expect(
          JSON.parse(FAKE_PREFS.get("devtools.forcedEnrollments"))
        ).toEqual(["optin-de-rollout"]);
        release();
        await applying;
      });

      it("should describe the changes and refetch content even when a step fails", async () => {
        jest
          .spyOn(feed, "_applyAppLocale")
          .mockRejectedValue(new Error("langpack install failed"));
        await feed._handleDevtoolsAction(
          ac.OnlyToMain(
            {
              type: at.DISCOVERY_STREAM_DEV_AVAILABILITY_APPLY,
              data: { region: "DE", defaultPrefs: true, enrollments: {} },
            },
            "tab-1"
          )
        );
        const types = feed.store.dispatch.mock.calls.map(([a]) => a.type);
        expect(types).toContain(at.DISCOVERY_STREAM_DEV_CHANGES);
        expect(types).toContain(at.DISCOVERY_STREAM_DEV_REFETCH_CONTENT);
      });

      it("should wait for a running Nimbus update before re-evaluating on reset", async () => {
        await feed.applyRegion("DE");
        let finish;
        globalThis.ExperimentAPI._rsLoader.finishedUpdating.mockReturnValue(
          new Promise(resolve => (finish = resolve))
        );
        const resetting = feed.reset();
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(updateRecipes).not.toHaveBeenCalled();
        finish();
        await resetting;
        expect(updateRecipes).toHaveBeenCalledWith("newtab-devtools");
      });

      it("should not record an override for the region this profile is in", async () => {
        await feed.applyRegion("US");
        expect(FAKE_PREFS.has("devtools.originalRegion")).toBe(false);
        expect(region._setHomeRegion).not.toHaveBeenCalled();
      });

      it("should do nothing on reset when nothing was applied", async () => {
        await feed.reset();
        expect(updateRecipes).not.toHaveBeenCalled();
        expect(feed.store.dispatch).not.toHaveBeenCalled();
      });

      it("should describe the changes once Nimbus is ready, and again as prefs change", async () => {
        let ready;
        globalThis.ExperimentAPI.manager.store.ready.mockReturnValue(
          new Promise(resolve => (ready = resolve))
        );
        FAKE_PREFS.set("devtools.originalRegion", "US");
        const changes = () =>
          feed.store.dispatch.mock.calls.filter(
            ([a]) => a.type === at.DISCOVERY_STREAM_DEV_CHANGES
          );
        feed.onAction({ type: at.INIT });
        expect(changes()).toHaveLength(0);
        ready();
        await feed._devtoolsQueue;
        expect(changes()).toHaveLength(1);

        region.home = "FR";
        feed.onAction({
          type: at.PREF_CHANGED,
          data: { name: "region", value: "FR" },
        });
        expect(changes().at(-1)[0].data).toEqual(["region FR (was US)"]);
      });
    });

    it("should report the forced branch per recipe", async () => {
      await feed.apply({
        region: "DE",
        enrollments: { "second-rollout": "control" },
      });
      const { recipes, forcedEnrollments } = await feed.getAvailability({});
      expect(forcedEnrollments).toEqual(["optin-second-rollout"]);
      expect(recipes.find(r => r.slug === "second-rollout").forcedBranch).toBe(
        "control"
      );
    });

    describe("default prefs and overrides", () => {
      let branch;
      beforeEach(() => {
        const userPrefs = new Map([
          ["widgets.system.lists.enabled", true],
          ["topSitesRows", 3],
          ["discoverystream.config", "[]"],
          ["newtabAdSize.billboard", true],
          ["asrouter.devtoolsEnabled", true],
          ["impressionId", "{id}"],
        ]);
        branch = {
          PREF_BOOL: 128,
          PREF_INT: 64,
          PREF_STRING: 32,
          userPrefs,
          getChildList: () => [...userPrefs.keys()],
          prefHasUserValue: name => userPrefs.has(name),
          getPrefType: name =>
            ({ boolean: 128, number: 64, string: 32 })[
              typeof userPrefs.get(name)
            ],
          getBoolPref: name => userPrefs.get(name),
          getIntPref: name => userPrefs.get(name),
          getStringPref: name => userPrefs.get(name),
          setBoolPref: (name, value) => userPrefs.set(name, value),
          setIntPref: (name, value) => userPrefs.set(name, value),
          setStringPref: (name, value) => userPrefs.set(name, value),
          clearUserPref: jest.fn(name => userPrefs.delete(name)),
        };
        services.prefs.getBranch = jest.fn(() => branch);
        globalThis.ExperimentAPI.manager.store.getAll = () => [
          {
            active: true,
            prefs: [{ name: "branch.str.newtabAdSize.billboard" }],
          },
        ];
      });

      it("should clear this profile's prefs except devtools and Nimbus ones, and restore them on reset", async () => {
        await feed.apply({ region: "DE", defaultPrefs: true });

        expect([...branch.userPrefs.keys()]).toEqual([
          "newtabAdSize.billboard",
          "asrouter.devtoolsEnabled",
          "impressionId",
        ]);
        const { devtoolsChanges, defaultPrefsApplied } =
          await feed.getAvailability({});
        expect(defaultPrefsApplied).toBe(true);
        expect(devtoolsChanges).toContain(
          "default New Tab prefs (3 of yours cleared)"
        );

        branch.userPrefs.set("widgets.weather.enabled", false);
        await feed.reset();

        expect(branch.userPrefs.has("widgets.weather.enabled")).toBe(false);
        expect(branch.userPrefs.get("widgets.system.lists.enabled")).toBe(true);
        expect(branch.userPrefs.get("topSitesRows")).toBe(3);
        expect(branch.userPrefs.get("discoverystream.config")).toBe("[]");
        expect(FAKE_PREFS.has("devtools.prefBackup")).toBe(false);
      });

      it("should not lose a user value that matches another audience's default", async () => {
        // As in Firefox, setting a pref to its current default drops the user
        // value. Here topSitesRows defaults to 3 in DE and to 1 elsewhere.
        branch.setIntPref = (name, value) => {
          const deDefault = region.home === "DE" ? 3 : 1;
          if (name === "topSitesRows" && value === deDefault) {
            branch.userPrefs.delete(name);
          } else {
            branch.userPrefs.set(name, value);
          }
        };

        await feed.apply({ region: "FR", defaultPrefs: true });
        expect(branch.userPrefs.has("topSitesRows")).toBe(false);
        // The user's 3 is DE's default, so it isn't stored while in DE.
        await feed.apply({ region: "DE" });
        expect(branch.userPrefs.has("topSitesRows")).toBe(false);
        const { defaultPrefsApplied } = await feed.getAvailability({});
        expect(defaultPrefsApplied).toBe(false);

        await feed.reset();
        expect(region.home).toBe("US");
        expect(branch.userPrefs.get("topSitesRows")).toBe(3);
      });

      it("should keep the first backup when applying twice", async () => {
        await feed.apply({ region: "DE", defaultPrefs: true });
        await feed.apply({ region: "FR", defaultPrefs: true });
        await feed.reset();
        expect(branch.userPrefs.get("topSitesRows")).toBe(3);
      });

      it("should leave prefs alone without the option", async () => {
        await feed.apply({ region: "DE" });
        expect(branch.clearUserPref).not.toHaveBeenCalled();
      });

      it("should only store locale and channel overrides that differ from this build", async () => {
        await feed.apply({ region: "DE", locale: "de", channel: "release" });
        expect(FAKE_PREFS.get("devtools.localeOverride")).toBe("de");
        expect(FAKE_PREFS.get("devtools.channelOverride")).toBe("release");

        // newtabLocale() and newtabChannel() read Services.prefs, which is the
        // same branch as feed._prefs outside of tests.
        const BRANCH = "browser.newtabpage.activity-stream.";
        const fromFakePrefs = (name, fallback) =>
          name.startsWith(BRANCH) && FAKE_PREFS.has(name.slice(BRANCH.length))
            ? FAKE_PREFS.get(name.slice(BRANCH.length))
            : fallback;
        services.prefs.getBoolPref = jest.fn(fromFakePrefs);
        services.prefs.getStringPref = jest.fn(fromFakePrefs);
        expect(await feed.getAvailability({})).toMatchObject({
          locale: "de",
          channel: "release",
        });

        await feed.apply({ region: "DE", locale: "en-US", channel: "release" });
        expect(FAKE_PREFS.has("devtools.localeOverride")).toBe(false);

        await feed.reset();
        expect(FAKE_PREFS.has("devtools.channelOverride")).toBe(false);
      });
    });

    describe("langpacks", () => {
      it("should switch to an installed langpack without downloading one", async () => {
        installedLocales.push("de");
        await feed.apply({ region: "DE", locale: "de-DE", enrollments: {} });

        expect(services.locale.appLocaleAsBCP47).toBe("de");
        expect(
          globalThis.LangPackMatcher.mockable.getAvailableLangpacks
        ).not.toHaveBeenCalled();
        expect(FAKE_PREFS.get("devtools.localeOverride")).toBe("de-DE");
        expect(feed.getDevtoolsChanges()).toContain("UI language de");

        await feed.reset();
        expect(services.locale.appLocaleAsBCP47).toBe("en-US");
        expect(FAKE_PREFS.has("devtools.originalLocales")).toBe(false);
      });

      it("should install the langpack from AMO when downloads are enabled", async () => {
        services.prefs.getBoolPref = jest.fn((name, fallback) =>
          ["nimbus.debug", "intl.multilingual.downloadEnabled"].includes(name)
            ? true
            : fallback
        );
        langpacks = [
          {
            id: "langpack-de@firefox.mozilla.org",
            target_locale: "de",
            url: "amo/de.xpi",
            hash: "h",
            version: "69.0",
          },
        ];
        const messages = await feed.apply({
          region: "DE",
          locale: "de",
          enrollments: {},
        });

        expect(ensureLangPackInstalled).toHaveBeenCalledWith(
          langpacks[0],
          "internal"
        );
        expect(services.locale.appLocaleAsBCP47).toBe("de");
        expect(FAKE_PREFS.has("devtools.localeOverride")).toBe(false);
        expect(messages).toEqual([]);
      });

      it("should install the Nightly langpack for this version on Nightly", async () => {
        globalThis.AppConstants.NIGHTLY_BUILD = true;
        fetchStub.mockImplementationOnce(async () => ({
          ok: true,
          text: async () =>
            '<a href="firefox-69.0a1.de.langpack.xpi">firefox-69.0a1.de.langpack.xpi</a> firefox-68.0a1.fr.langpack.xpi',
        }));
        try {
          await feed.apply({ region: "DE", locale: "de", enrollments: {} });
        } finally {
          globalThis.AppConstants.NIGHTLY_BUILD = false;
        }

        expect(globalThis.AddonManager.getInstallForURL).toHaveBeenCalledWith(
          expect.stringMatching(/\/firefox-69\.0a1\.de\.langpack\.xpi$/),
          { telemetryInfo: { source: "internal" } }
        );
        expect(ensureLangPackInstalled).not.toHaveBeenCalled();
        expect(services.locale.appLocaleAsBCP47).toBe("de");
      });

      it("should say so and keep the override when there is no langpack", async () => {
        const messages = await feed.apply({
          region: "DE",
          locale: "de",
          enrollments: {},
        });

        expect(messages).toContain(
          "No langpack for de could be installed, so the UI stays in en-US."
        );
        expect(services.locale.appLocaleAsBCP47).toBe("en-US");
        expect(FAKE_PREFS.get("devtools.localeOverride")).toBe("de");
      });
    });

    it("should enable nimbus.debug when asked", async () => {
      nimbusDebug = false;
      await feed._handleDevtoolsAction(
        ac.OnlyToMain(
          { type: at.DISCOVERY_STREAM_DEV_ENABLE_NIMBUS_DEBUG },
          "tab-1"
        )
      );
      expect(services.prefs.setBoolPref).toHaveBeenCalledWith(
        "nimbus.debug",
        true
      );
    });
  });
});
