/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** @import {Store} from "resource://newtab/lib/Store.sys.mjs" */

import {
  actionCreators as ac,
  actionTypes as at,
} from "resource://newtab/common/Actions.mjs";
import { Prefs } from "resource://newtab/lib/ActivityStreamPrefs.sys.mjs";
import { PREFS_CONFIG } from "resource://newtab/lib/ActivityStream.sys.mjs";
import {
  buildChannel,
  newtabChannel,
  newtabLocale,
} from "resource://newtab/lib/NewtabAudience.sys.mjs";
import { trainhopPayloads } from "resource://newtab/lib/PrefsFeed.sys.mjs";
import {
  isWidgetAddable,
  WIDGET_REGISTRY,
} from "resource://newtab/common/WidgetsRegistry.mjs";

// eslint-disable-next-line mozilla/use-static-import
const { AppConstants } = ChromeUtils.importESModule(
  "resource://gre/modules/AppConstants.sys.mjs"
);

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  AddonManager: "resource://gre/modules/AddonManager.sys.mjs",
  ASRouterTargeting: "resource:///modules/asrouter/ASRouterTargeting.sys.mjs",
  ExperimentAPI: "resource://nimbus/ExperimentAPI.sys.mjs",
  LangPackMatcher: "moz-src:///intl/locale/LangPackMatcher.sys.mjs",
  Region: "resource://gre/modules/Region.sys.mjs",
  RemoteSettings: "resource://services-settings/remote-settings.sys.mjs",
  TargetingContext: "resource://messaging-system/targeting/Targeting.sys.mjs",
});

ChromeUtils.defineLazyGetter(lazy, "logConsole", function () {
  return console.createInstance({
    prefix: "NewTabDevtoolsFeed",
    maxLogLevel: "Warn",
  });
});

const DEVTOOLS_ENABLED_PREF = "asrouter.devtoolsEnabled";
// The home region from before the devtools first overrode it, so that it can
// be restored. Only has a user value while an override is active.
const DEVTOOLS_ORIGINAL_REGION_PREF = "devtools.originalRegion";
// JSON array of the requested app locales from before the devtools first
// switched to a langpack, so that Reset can restore them.
const DEVTOOLS_ORIGINAL_LOCALES_PREF = "devtools.originalLocales";
// JSON array of the optin- enrollment slugs the devtools created, so that
// Reset can undo them.
const DEVTOOLS_FORCED_ENROLLMENTS_PREF = "devtools.forcedEnrollments";
const NIMBUS_DEBUG_PREF = "nimbus.debug";
// Set when the devtools turned nimbus.debug on, so that Reset turns it off.
const DEVTOOLS_ENABLED_NIMBUS_DEBUG_PREF = "devtools.enabledNimbusDebug";
// Every pref Apply and the pane leave behind for Reset.
const DEVTOOLS_BOOKKEEPING_PREFS = [
  "devtools.originalRegion",
  "devtools.originalLocales",
  "devtools.forcedEnrollments",
  "devtools.enabledNimbusDebug",
  "devtools.localeOverride",
  "devtools.channelOverride",
  "devtools.prefBackup",
  "devtools.interactionBackup",
  "devtools.touchedPrefs",
];
// The channels Apply can switch New Tab's channel dependent defaults to.
const DEVTOOLS_CHANNELS = ["release", "beta", "nightly", "esr"];
// Read by ActivityStream for its region, locale and channel dependent defaults.
const DEVTOOLS_LOCALE_OVERRIDE_PREF = "devtools.localeOverride";
const DEVTOOLS_CHANNEL_OVERRIDE_PREF = "devtools.channelOverride";
// JSON object of this profile's New Tab prefs that Apply cleared, so that Reset
// can restore them.
const DEVTOOLS_PREF_BACKUP_PREF = "devtools.prefBackup";
// JSON object of the widget interaction prefs' values before Apply set them,
// null for ones that had no user value, so that Reset can restore them.
const DEVTOOLS_INTERACTION_BACKUP_PREF = "devtools.interactionBackup";
// JSON array of the prefs the devtools pane has written, so that its changes
// can be told apart from New Tab's and the user's own, and reset.
const DEVTOOLS_TOUCHED_PREFS_PREF = "devtools.touchedPrefs";
// The global English and Spanish story feeds (bug 2066559) serve any region
// without a feed of its own, so each is offered as an audience in such a region.
const GLOBAL_FEED_AUDIENCES = [
  { region: "AU", locale: "en-US", label: "Global English feed" },
  { region: "MX", locale: "es-MX", label: "Global Spanish feed" },
];
const EXTERNAL_FETCH_TIMEOUT_MS = 5000;
const MAX_TOUCHED_PREFS = 200;
const WIDGET_INTERACTION_PREF = /^widgets\..+\.interaction$/;
// A recipe reading a widget interaction pref, e.g. to target engaged users.
const WIDGET_INTERACTION_TARGETING =
  /(['"])browser\.newtabpage\.activity-stream\.widgets\.[^'"]+\.interaction\1\|preferenceValue/g;
// Never cleared by Apply: the devtools' own state, the telemetry id, and the
// user's consent and opt-outs, so a default profile doesn't turn telemetry,
// sponsored content or personalization back on for someone who turned it off.
const DEVTOOLS_KEPT_PREFS =
  /^(devtools\.|asrouter\.devtoolsEnabled$|impressionId$|telemetry(\..+)?$|(system\.)?showSponsored.*$|discoverystream\.sections\.personalization\.inferred\.user\.enabled$)/;
const NIMBUS_COLLECTION_PREF =
  "messaging-system.rsexperimentloader.collection_id";
const NIMBUS_DEVTOOLS_TRIGGER = "newtab-devtools";

// Targeting attributes that the devtools can't simulate, so a recipe using
// them matches or not based on this profile rather than the chosen region,
// locale, channel and version. Picked from the attributes live recipes use, so
// add to it when recipes start using others.
/** @type {Array<[RegExp, string]>} */
const PROFILE_TARGETING = [
  [/\|preferenceValue/, "pref values"],
  [/\bnewtabAddonVersion\b/, "newtab add-on version"],
  [/\bprofileAgeCreated\b/, "profile age"],
  [/\benrollments(Map)?\b/, "other enrollments"],
  [/\bos\./, "OS"],
  [/\b(isDefaultBrowser|doesAppNeedPin|isMSIX)\b/, "default browser/pin"],
  [/\bisFirstStartup\b/, "first startup"],
  [/\battributionData\b/, "attribution"],
];

const RELEASE_SCHEDULE_URL =
  "https://whattrainisitnow.com/api/release/schedule/?version=";
// AMO only serves langpacks for Release and Beta. The XPIs are signed and
// platform independent, so the Linux ones work everywhere.
const NIGHTLY_LANGPACKS_URL =
  "https://archive.mozilla.org/pub/firefox/nightly/latest-mozilla-central-l10n/linux-x86_64/xpi/";
const ESR_RELEASES_URL =
  "https://whattrainisitnow.com/api/firefox/releases/esr/";

/**
 * Returns the values of the `attribute in [...]` clauses in a targeting
 * expression, skipping negated ones such as `(region in [...]) != true`.
 *
 * @param {string} targeting
 * @param {string} attribute - e.g. "region" or "locale"
 * @returns {string[]}
 */
function targetedValues(targeting, attribute) {
  const clause = new RegExp(
    `(!\\s*\\(\\s*)?\\b${attribute} in \\[([^\\]]*)\\]\\)?(\\s*(?:!= true|== false))?`,
    "g"
  );
  return [...targeting.matchAll(clause)]
    .filter(
      ([, negatedBefore, , negatedAfter]) => !negatedBefore && !negatedAfter
    )
    .flatMap(([, , list]) =>
      [...list.matchAll(/['"]([^'"]+)['"]/g)].map(([, value]) => value)
    );
}

/**
 * Whether a locale is one people in a region use: its region subtag matches,
 * or it has none and is the region's most likely language.
 *
 * @param {string} locale
 * @param {string} region
 * @returns {boolean}
 */
function localeFitsRegion(locale, region) {
  try {
    const parsed = new Intl.Locale(locale);
    if (parsed.region) {
      return parsed.region === region;
    }
    return (
      new Intl.Locale(`und-${region}`).maximize().language === parsed.language
    );
  } catch (e) {
    return false;
  }
}

/**
 * Builds region and locale pairs from the audiences newtab recipes target,
 * most targeted first. A recipe naming up to three regions contributes every
 * listed locale for them; one naming more contributes only the locales that
 * fit each region, since not every combination is a real audience.
 * ponytail: text matching on targeting, so && / || structure is ignored.
 *
 * @param {object[]} recipes
 * @returns {Array<{region: string, locale: string, count: number}>}
 */
function targetedAudiences(recipes) {
  const counts = new Map();
  for (const recipe of recipes) {
    const targeting = recipe.targeting ?? "";
    const regions = [...new Set(targetedValues(targeting, "region"))];
    const locales = [...new Set(targetedValues(targeting, "locale"))];
    for (const region of regions) {
      for (const locale of locales) {
        if (regions.length <= 3 || localeFitsRegion(locale, region)) {
          const key = `${region}|${locale}`;
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
      }
    }
  }
  return [...counts]
    .map(([key, count]) => {
      const [region, locale] = key.split("|");
      return { region, locale, count };
    })
    .sort((a, b) => b.count - a.count || a.region.localeCompare(b.region));
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isValidLocale(locale) {
  try {
    return (
      typeof locale === "string" && !!Intl.getCanonicalLocales(locale).length
    );
  } catch (e) {
    return false;
  }
}

function isNewtabRecipe(recipe) {
  return !!recipe.featureIds?.some(id => /^(newtab|pocketnewtab)/i.test(id));
}

/**
 * Returns, per branch, the widgets that the branch's newtabTrainhop value makes
 * available, decided the same way the page does.
 *
 * @param {object} recipe
 * @param {string} region The simulated region, since trainhopConfig only makes
 *   widgets addable once the region is known.
 * @returns {Array<{branch: string, widgets: string[]}>}
 */
function widgetsByBranch(recipe, region) {
  return (recipe.branches ?? [])
    .map(branch => {
      const trainhopConfig = {};
      for (const feature of branch.features ?? []) {
        if (feature.featureId === "newtabTrainhop") {
          for (const { type, payload } of trainhopPayloads(feature.value)) {
            trainhopConfig[type] = payload;
          }
        }
      }
      return {
        branch: branch.slug,
        widgets: WIDGET_REGISTRY.filter(widget =>
          isWidgetAddable(widget, { trainhopConfig, region })
        ).map(widget => widget.id),
      };
    })
    .filter(({ widgets }) => widgets.length);
}

/**
 * The parent side of the newtab devtools' Feature availability section:
 * evaluates live Nimbus recipes for a simulated audience, and applies or
 * resets that audience on this profile. Does nothing unless
 * browser.newtabpage.activity-stream.asrouter.devtoolsEnabled is set.
 */
export class NewTabDevtoolsFeed {
  /** @type {Store} */
  store = null;

  constructor() {
    this._prefs = new Prefs();
    // Mirrors what was last broadcast with DISCOVERY_STREAM_DEV_CHANGES.
    this._devtoolsChangesJSON = "[]";
    // The devtools actions, handled one at a time.
    this._devtoolsQueue = Promise.resolve();
    // Versions from whattrainisitnow.com, once they've been fetched.
    this._versionChoices = null;
  }

  /**
   * Evaluates every live newtab Nimbus recipe and every region/locale dependent
   * default pref as if the browser had the given targeting attributes. Empty
   * attributes fall back to the current browser's values.
   *
   * @param {object} options
   * @param {string} [options.region] e.g. "DE"
   * @param {string} [options.locale] e.g. "de"
   * @param {string} [options.channel] e.g. "release"
   * @param {string} [options.version] e.g. "151.0"
   * @param {boolean} [options.widgetsInteracted] Whether the user has used a
   *   widget, which some recipes target.
   */
  async getAvailability(options = {}) {
    const region = options.region || lazy.Region.home || "";
    // Default to what Apply set, so a reloaded page shows the applied state.
    const locale = options.locale || newtabLocale();
    const channel = options.channel || newtabChannel();
    const version = options.version || AppConstants.MOZ_APP_VERSION;

    // A boolean only: it's pasted into the targeting the parent evaluates.
    const widgetsInteracted =
      typeof options.widgetsInteracted === "boolean"
        ? options.widgetsInteracted
        : this._hasInteractedWithWidgets();

    const recipes = await this._getNewtabRecipes();
    const { manager } = lazy.ExperimentAPI;
    const managerContext = manager.createTargetingContext();
    const overrides = {
      region,
      locale,
      localeLanguageCode: locale.split("-")[0],
      version,
      firefoxVersion: parseInt(version, 10),
      channel,
      browserSettings: { update: { channel } },
      // Nearly every recipe matches clients that are already enrolled, so
      // evaluate as a client that isn't.
      activeExperiments: [],
      activeRollouts: [],
    };
    const recipeResults = await Promise.all(
      recipes.map(async recipe => {
        const targetingContext = new lazy.TargetingContext(null, {
          source: NIMBUS_DEVTOOLS_TRIGGER,
        });
        // Replace the context instead of passing it to the constructor, which
        // would let the real region, locale, version and channel win over the
        // overrides. Without a custom context, ctx is the default environment.
        targetingContext.ctx = lazy.TargetingContext.combineContexts(
          { ...overrides, experiment: recipe },
          managerContext,
          lazy.ASRouterTargeting.Environment,
          targetingContext.ctx
        );
        // preferenceValue reads the real pref, so substitute the simulated
        // widget interaction instead.
        const targeting = (recipe.targeting || "true").replace(
          WIDGET_INTERACTION_TARGETING,
          String(widgetsInteracted)
        );
        let result = null;
        try {
          result = await targetingContext.evalWithDefault(targeting);
        } catch (e) {
          lazy.logConsole.warn(`Targeting failed for ${recipe.slug}`, e);
        }
        const enrollment = manager.store.get(recipe.slug);
        const forced = manager.store.get(`optin-${recipe.slug}`);
        const { count = 0, total = 1 } = recipe.bucketConfig ?? {};
        return {
          slug: recipe.slug,
          userFacingName: recipe.userFacingName,
          userFacingDescription: recipe.userFacingDescription,
          widgets: widgetsByBranch(recipe, region),
          profileTargeting: PROFILE_TARGETING.filter(([pattern]) =>
            pattern.test(targeting)
          ).map(([, label]) => label),
          isRollout: !!recipe.isRollout,
          featureIds: recipe.featureIds,
          branches: (recipe.branches ?? []).map(branch => branch.slug),
          bucketPercent: Math.round((count / total) * 1000) / 10,
          targeting: recipe.targeting,
          matches: result === null ? null : !!result,
          enrolledBranch: enrollment?.active ? enrollment.branch.slug : null,
          forcedBranch: forced?.active ? forced.branch.slug : null,
        };
      })
    );

    const prefs = [];
    for (const [name, config] of PREFS_CONFIG) {
      if (!config.getValue) {
        continue;
      }
      let simulated;
      try {
        simulated = config.getValue({
          geo: region,
          locale,
          channel,
        });
      } catch (e) {
        simulated = `Error: ${e.message}`;
      }
      prefs.push({ name, current: config.value, simulated });
    }

    return {
      region,
      locale,
      channel,
      version,
      widgetsInteracted,
      options: await this._getAvailabilityOptions(recipes, {
        region,
        locale,
        version,
      }),
      originalRegion: this._prefs.get(DEVTOOLS_ORIGINAL_REGION_PREF),
      forcedEnrollments: this._getForcedEnrollments(),
      changedPrefs: this._getChangedPrefs(),
      devtoolsChanges: this.getDevtoolsChanges(),
      defaultPrefsApplied: this._getPrefBackup() !== null,
      nimbusDebug: Services.prefs.getBoolPref(NIMBUS_DEBUG_PREF, false),
      studiesEnabled: lazy.ExperimentAPI.studiesEnabled,
      recipes: recipeResults,
      prefs,
    };
  }

  /**
   * Builds the choices for the devtools region, locale and version dropdowns.
   * Locales come from the recipes since only those can change what matches.
   * Presets are the region and locale pairs the recipes target.
   */
  async _getAvailabilityOptions(recipes, { region, locale, version }) {
    const regionCodes = Services.intl
      .getAvailableLocaleDisplayNames("region")
      .filter(code => /^[a-z]{2}$/.test(code));
    const regionNames = Services.intl.getRegionDisplayNames(
      undefined,
      regionCodes
    );
    const regions = regionCodes
      .map((code, i) => ({ value: code.toUpperCase(), label: regionNames[i] }))
      .sort((a, b) => a.label.localeCompare(b.label));
    if (!regions.some(r => r.value === region)) {
      regions.unshift({ value: region, label: region || "Unknown" });
    }

    const localeCodes = [
      ...new Set([
        locale,
        ...GLOBAL_FEED_AUDIENCES.map(a => a.locale),
        ...Services.locale.availableLocales,
        ...recipes.flatMap(r => r.locales ?? []),
      ]),
    ];
    const localeNames = Services.intl.getLocaleDisplayNames(
      undefined,
      localeCodes
    );
    const locales = localeCodes
      .map((code, i) => ({ value: code, label: localeNames[i] }))
      .sort((a, b) => a.label.localeCompare(b.label));

    const audiences = targetedAudiences(recipes).filter(
      a =>
        !GLOBAL_FEED_AUDIENCES.some(
          g => g.region === a.region && g.locale === a.locale
        )
    );
    const presetRegionNames = Services.intl.getRegionDisplayNames(
      undefined,
      audiences.map(a => a.region)
    );
    const presetLocaleNames = Services.intl.getLocaleDisplayNames(
      undefined,
      audiences.map(a => a.locale)
    );
    const presets = [
      ...GLOBAL_FEED_AUDIENCES.map(({ region: r, locale: l, label }) => ({
        region: r,
        locale: l,
        label: `${label} (${r}, ${l})`,
      })),
      ...audiences.map(({ region: r, locale: l, count }, i) => ({
        region: r,
        locale: l,
        label: `${presetRegionNames[i]}, ${presetLocaleNames[i]} (${r}, ${l}): ${count} ${count === 1 ? "recipe" : "recipes"}`,
      })),
    ];

    const versions = [...(await this._getVersionChoices())];
    for (const [value, label] of [
      [
        AppConstants.MOZ_APP_VERSION,
        `This build (${AppConstants.MOZ_APP_VERSION})`,
      ],
      [version, version],
    ]) {
      if (!versions.some(v => v.value === value)) {
        versions.push({
          value,
          label,
          channel: value === AppConstants.MOZ_APP_VERSION ? buildChannel() : "",
        });
      }
    }

    return { regions, locales, presets, versions };
  }

  /**
   * Returns the current Nightly, Beta and Release versions, the three Releases
   * before that and the latest ESR, from whattrainisitnow.com. Versions that
   * can't be fetched are estimated from the ones that could, else from this
   * build's version and channel.
   *
   * @returns {Promise<Array<{value: string, label: string, channel: string}>>}
   */
  async _getVersionChoices() {
    if (this._versionChoices) {
      return this._versionChoices;
    }
    /**
     * @param {string} url
     * @returns {Promise<any>}
     */
    const getJSON = async url => {
      const response = await fetch(url, {
        credentials: "omit",
        signal: AbortSignal.timeout(EXTERNAL_FETCH_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(`${url} failed with ${response.status}`);
      }
      return response.json();
    };
    const results = await Promise.allSettled([
      getJSON(`${RELEASE_SCHEDULE_URL}nightly`),
      getJSON(`${RELEASE_SCHEDULE_URL}beta`),
      getJSON(`${RELEASE_SCHEDULE_URL}release`),
      getJSON(ESR_RELEASES_URL),
    ]);
    for (const result of results) {
      if (result.status === "rejected") {
        lazy.logConsole.warn("Couldn't get Firefox versions", result.reason);
      }
    }
    const [nightlySchedule, betaSchedule, releaseSchedule, esrReleases] =
      results.map(result =>
        result.status === "fulfilled" ? result.value : null
      );

    // How many versions each channel is behind Nightly.
    const behindNightly = { nightly: 0, beta: 1, release: 2 };
    const fetched = {
      nightly: parseInt(nightlySchedule?.version, 10),
      beta: parseInt(betaSchedule?.version, 10),
      release: parseInt(releaseSchedule?.version, 10),
    };
    const buildBehind = behindNightly[buildChannel()];
    const nightlyVersion =
      Object.entries(fetched)
        .map(([channel, version]) => version + behindNightly[channel])
        .find(version => !Number.isNaN(version)) ??
      // An ESR build can't tell how far behind Nightly it is.
      (buildBehind === undefined
        ? NaN
        : parseInt(AppConstants.MOZ_APP_VERSION, 10) + buildBehind);
    const versionOf = channel =>
      fetched[channel] || nightlyVersion - behindNightly[channel];
    const suffixOf = channel => (fetched[channel] ? "" : " (estimated)");

    const [esr] = Object.values(esrReleases ?? {})
      .flat()
      // Shown and sent back as an option value, so only version strings.
      .filter(v => typeof v === "string" && /^\d+\.\d+(\.\d+)?$/.test(v))
      .sort((a, b) => Services.vc.compare(b, a));

    const choices = [
      ...(Number.isNaN(nightlyVersion)
        ? []
        : [
            {
              value: `${versionOf("nightly")}.0a1`,
              label: `Nightly ${versionOf("nightly")}${suffixOf("nightly")}`,
              channel: "nightly",
            },
            {
              value: `${versionOf("beta")}.0`,
              label: `Beta ${versionOf("beta")}${suffixOf("beta")}`,
              channel: "beta",
            },
            ...[0, 1, 2, 3].map(behind => ({
              value: `${versionOf("release") - behind}.0`,
              label: `Release ${versionOf("release") - behind}${behind ? ` (Release -${behind})` : ""}${suffixOf("release")}`,
              channel: "release",
            })),
          ]),
      ...(esr ? [{ value: esr, label: `ESR ${esr}`, channel: "esr" }] : []),
    ];
    if (results.every(result => result.status === "fulfilled")) {
      this._versionChoices = choices;
    }
    return choices;
  }

  /**
   * @returns {Promise<Array<{target_locale: string, url: string,
   *   hash?: string}>>} The langpacks available for this build.
   */
  async _getLangpacks() {
    if (
      Services.prefs.getBoolPref("intl.multilingual.downloadEnabled", false)
    ) {
      return (
        (await lazy.LangPackMatcher.mockable.getAvailableLangpacks()) ?? []
      );
    }
    if (buildChannel() !== "nightly") {
      return [];
    }
    const response = await fetch(NIGHTLY_LANGPACKS_URL, {
      credentials: "omit",
      signal: AbortSignal.timeout(EXTERNAL_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`Langpack listing failed with ${response.status}`);
    }
    const listing = await response.text();
    const version = AppConstants.MOZ_APP_VERSION.replace(/\./g, "\\.");
    const files = listing.matchAll(
      new RegExp(`firefox-${version}\\.([\\w-]+)\\.langpack\\.xpi`, "g")
    );
    // The listing links each file twice.
    return [...new Map(files)].map(([name, target_locale]) => ({
      target_locale,
      url: NIGHTLY_LANGPACKS_URL + name,
    }));
  }

  /**
   * Nightly langpacks come from an archive listing that doesn't give the
   * add-on version LangPackMatcher requires, so they're installed directly.
   *
   * @param {{target_locale: string, url: string, id?: string}} langpack
   * @returns {Promise<boolean>}
   */
  async _installLangpack(langpack) {
    if (langpack.id) {
      return lazy.LangPackMatcher.ensureLangPackInstalled(langpack, "internal");
    }
    try {
      const install = await lazy.AddonManager.getInstallForURL(langpack.url, {
        telemetryInfo: { source: "internal" },
      });
      await install.install();
      return true;
    } catch (e) {
      lazy.logConsole.warn(`Couldn't install ${langpack.url}`, e);
      return false;
    }
  }

  /**
   * Switches the app locale to the best langpack for a locale, installing it
   * if needed, and remembers the original locales so Reset can restore them.
   *
   * @param {string} [locale]
   * @returns {Promise<string|undefined>} A problem to show the developer.
   */
  async _applyAppLocale(locale) {
    if (!locale) {
      return undefined;
    }
    const negotiate = available =>
      Services.locale.negotiateLanguages([locale], available)[0];
    let match = negotiate(await lazy.LangPackMatcher.getAvailableLocales());
    if (!match) {
      let langpacks = [];
      try {
        langpacks = await this._getLangpacks();
      } catch (e) {
        lazy.logConsole.warn("Couldn't get the available langpacks", e);
      }
      const target = negotiate(langpacks.map(l => l.target_locale));
      const langpack = langpacks.find(l => l.target_locale === target);
      if (!langpack || !(await this._installLangpack(langpack))) {
        return `No langpack for ${locale} could be installed, so the UI stays in ${Services.locale.appLocaleAsBCP47}.`;
      }
      match = target;
    }
    if (match !== Services.locale.appLocaleAsBCP47) {
      if (!this._prefs.get(DEVTOOLS_ORIGINAL_LOCALES_PREF)) {
        this._prefs.set(
          DEVTOOLS_ORIGINAL_LOCALES_PREF,
          JSON.stringify(Services.locale.requestedLocales)
        );
      }
      Services.locale.requestedLocales = [match];
    }
    return undefined;
  }

  _restoreAppLocale() {
    const locales = this._readJSONPref(
      DEVTOOLS_ORIGINAL_LOCALES_PREF,
      null,
      value => Array.isArray(value) && value.every(isValidLocale)
    );
    if (locales) {
      Services.locale.requestedLocales = locales;
    }
    this._prefs.reset(DEVTOOLS_ORIGINAL_LOCALES_PREF);
  }

  async _getNewtabRecipes() {
    const collection = Services.prefs.getStringPref(
      NIMBUS_COLLECTION_PREF,
      "nimbus-desktop-experiments"
    );
    return (await lazy.RemoteSettings(collection).get()).filter(isNewtabRecipe);
  }

  /**
   * Reads one of the devtools' JSON bookkeeping prefs. They can be edited in
   * about:config, so a malformed one counts as unset rather than stopping
   * Reset part way.
   *
   * @param {string} name
   * @param {any} fallback - returned when unset or malformed
   * @param {Function} isValid - checks the parsed value's shape
   * @returns {any}
   */
  _readJSONPref(name, fallback, isValid) {
    try {
      const value = JSON.parse(this._prefs.get(name) ?? "null");
      return value !== null && isValid(value) ? value : fallback;
    } catch (e) {
      return fallback;
    }
  }

  _getForcedEnrollments() {
    // Only optin- slugs, which only force-enrollment creates, so this can't
    // unenroll this profile's own enrollments.
    return this._readJSONPref(
      DEVTOOLS_FORCED_ENROLLMENTS_PREF,
      [],
      Array.isArray
    ).filter(slug => typeof slug === "string" && slug.startsWith("optin-"));
  }

  _getPrefBackup() {
    return this._readJSONPref(DEVTOOLS_PREF_BACKUP_PREF, null, isPlainObject);
  }

  /**
   * Returns the names, relative to the New Tab branch, of the user-set prefs
   * that Apply and Reset may change: not the devtools' own, not the widget
   * interaction prefs, which have their own backup, and not ones an active
   * Nimbus enrollment set, since changing those would unenroll it.
   *
   * @param {nsIPrefBranch} branch
   * @returns {string[]}
   */
  _clearablePrefs(branch) {
    const nimbusPrefs = new Set(
      lazy.ExperimentAPI.manager.store
        .getAll()
        .filter(enrollment => enrollment.active)
        .flatMap(enrollment => [
          ...(enrollment.prefs ?? []).map(pref => pref.name),
          ...Object.keys(enrollment.prefFlips?.originalValues ?? {}),
        ])
    );
    return branch
      .getChildList("")
      .filter(
        name =>
          branch.prefHasUserValue(name) &&
          !DEVTOOLS_KEPT_PREFS.test(name) &&
          !WIDGET_INTERACTION_PREF.test(name) &&
          !nimbusPrefs.has(this._prefs._branchStr + name)
      );
  }

  /**
   * Clears this profile's New Tab prefs so the page uses the defaults a new
   * profile would, keeping the ones _clearablePrefs leaves alone.
   */
  _clearUserPrefs() {
    if (this._getPrefBackup()) {
      return;
    }
    const branch = Services.prefs.getBranch(this._prefs._branchStr);
    const backup = {};
    for (const name of this._clearablePrefs(branch)) {
      switch (branch.getPrefType(name)) {
        case branch.PREF_BOOL:
          backup[name] = branch.getBoolPref(name);
          break;
        case branch.PREF_INT:
          backup[name] = branch.getIntPref(name);
          break;
        default:
          backup[name] = branch.getStringPref(name);
      }
    }
    // Saved before clearing, so a failure part way leaves them restorable.
    this._prefs.set(DEVTOOLS_PREF_BACKUP_PREF, JSON.stringify(backup));
    Object.keys(backup).forEach(name => branch.clearUserPref(name));
  }

  /**
   * Puts back the prefs Apply cleared, and clears ones first set since, so the
   * profile ends up as it was. Call after the region and overrides are
   * restored: a user value equal to the default at the time it is set is
   * dropped, so restoring under the applied defaults could lose it.
   */
  _restoreUserPrefs() {
    const backup = this._getPrefBackup();
    if (!backup) {
      return;
    }
    const branch = Services.prefs.getBranch(this._prefs._branchStr);
    for (const name of this._clearablePrefs(branch)) {
      if (!Object.hasOwn(backup, name)) {
        branch.clearUserPref(name);
      }
    }
    for (const [name, value] of Object.entries(backup)) {
      if (typeof value === "boolean") {
        branch.setBoolPref(name, value);
      } else if (typeof value === "number") {
        branch.setIntPref(name, value);
      } else {
        branch.setStringPref(name, value);
      }
    }
    this._prefs.reset(DEVTOOLS_PREF_BACKUP_PREF);
  }

  _widgetInteractionPrefs() {
    return [...PREFS_CONFIG.keys()].filter(name =>
      WIDGET_INTERACTION_PREF.test(name)
    );
  }

  _hasInteractedWithWidgets() {
    return this._widgetInteractionPrefs().some(name => this._prefs.get(name));
  }

  /**
   * Marks every widget as interacted with, or none, remembering the values
   * from before the first time so Reset can restore them.
   *
   * @param {boolean} interacted
   */
  _setWidgetInteraction(interacted) {
    const names = this._widgetInteractionPrefs();
    const branch = Services.prefs.getBranch(this._prefs._branchStr);
    if (!this._prefs.get(DEVTOOLS_INTERACTION_BACKUP_PREF)) {
      const backup = Object.fromEntries(
        names.map(name => [
          name,
          branch.prefHasUserValue(name) ? this._prefs.get(name) : null,
        ])
      );
      this._prefs.set(DEVTOOLS_INTERACTION_BACKUP_PREF, JSON.stringify(backup));
    }
    for (const name of names) {
      if (interacted) {
        this._prefs.set(name, true);
      } else {
        this._prefs.reset(name);
      }
    }
  }

  _restoreWidgetInteraction() {
    const backup = this._readJSONPref(
      DEVTOOLS_INTERACTION_BACKUP_PREF,
      {},
      isPlainObject
    );
    for (const [name, value] of Object.entries(backup)) {
      if (value === null) {
        this._prefs.reset(name);
      } else {
        this._prefs.set(name, value);
      }
    }
    this._prefs.reset(DEVTOOLS_INTERACTION_BACKUP_PREF);
  }

  _getTouchedPrefs() {
    return this._readJSONPref(DEVTOOLS_TOUCHED_PREFS_PREF, [], Array.isArray);
  }

  _trackTouchedPrefs(names) {
    const branch = Services.prefs.getBranch(this._prefs._branchStr);
    const touched = new Set(this._getTouchedPrefs());
    const before = touched.size;
    // Only New Tab prefs that exist, and a bounded list, since the names come
    // from content.
    for (const name of names) {
      if (
        touched.size < MAX_TOUCHED_PREFS &&
        branch.getPrefType(name) !== branch.PREF_INVALID
      ) {
        touched.add(name);
      }
    }
    if (touched.size !== before) {
      this._prefs.set(
        DEVTOOLS_TOUCHED_PREFS_PREF,
        JSON.stringify([...touched])
      );
    }
  }

  /**
   * @returns {string[]} The prefs the devtools pane wrote that still differ
   *   from their defaults, leaving out ones Nimbus now manages.
   */
  _changedTouchedPrefs() {
    const touched = new Set(this._getTouchedPrefs());
    const branch = Services.prefs.getBranch(this._prefs._branchStr);
    return this._clearablePrefs(branch).filter(name => touched.has(name));
  }

  _clearTouchedPrefs() {
    const branch = Services.prefs.getBranch(this._prefs._branchStr);
    this._changedTouchedPrefs().forEach(name => branch.clearUserPref(name));
    this._prefs.reset(DEVTOOLS_TOUCHED_PREFS_PREF);
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
    const originalRegion = this._prefs.get(DEVTOOLS_ORIGINAL_REGION_PREF);
    const locale = this._prefs.get(DEVTOOLS_LOCALE_OVERRIDE_PREF);
    const channel = this._prefs.get(DEVTOOLS_CHANNEL_OVERRIDE_PREF);
    const forced = this._getForcedEnrollments().filter(
      slug => lazy.ExperimentAPI.manager.store.get(slug)?.active
    ).length;
    const touched = this._changedTouchedPrefs().length;
    const backup = this._getPrefBackup();
    return [
      originalRegion !== undefined &&
        `region ${lazy.Region.home || "undetected"} (was ${originalRegion || "undetected"})`,
      this._prefs.get(DEVTOOLS_ORIGINAL_LOCALES_PREF) &&
        `UI language ${Services.locale.appLocaleAsBCP47}`,
      locale && `locale ${locale} for New Tab's own defaults`,
      channel && `channel ${channel} for New Tab's own defaults`,
      forced &&
        `${forced} forced ${forced === 1 ? "enrollment" : "enrollments"}`,
      backup &&
        `default New Tab prefs (${Object.keys(backup).length} of yours cleared)`,
      this._prefs.get(DEVTOOLS_INTERACTION_BACKUP_PREF) &&
        (this._hasInteractedWithWidgets()
          ? "widgets marked as interacted with"
          : "widgets marked as never interacted with"),
      this._prefs.get(DEVTOOLS_ENABLED_NIMBUS_DEBUG_PREF) && "nimbus.debug",
      touched &&
        `${touched} ${touched === 1 ? "pref" : "prefs"} changed in the devtools`,
    ].filter(Boolean);
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

  /**
   * @returns {Array<{name: string, defaultValue: any, value: any,
   *   touched: boolean}>} Every New Tab pref with a user value, other than
   *   the devtools' own, with its default (undefined if it has none).
   */
  _getChangedPrefs() {
    const branchName = this._prefs._branchStr;
    const branch = Services.prefs.getBranch(branchName);
    const defaults = Services.prefs.getDefaultBranch(branchName);
    const touched = new Set(this._getTouchedPrefs());
    const read = (prefBranch, name) => {
      try {
        switch (prefBranch.getPrefType(name)) {
          case prefBranch.PREF_BOOL:
            return prefBranch.getBoolPref(name);
          case prefBranch.PREF_INT:
            return prefBranch.getIntPref(name);
          case prefBranch.PREF_STRING:
            return prefBranch.getStringPref(name);
        }
      } catch (e) {
        // A pref with only a user value has no default to read.
      }
      return undefined;
    };
    return (
      branch
        .getChildList("")
        // The devtools' own bookkeeping is summarized as what Apply changed.
        .filter(
          name => branch.prefHasUserValue(name) && !name.startsWith("devtools.")
        )
        .sort()
        .map(name => ({
          name,
          defaultValue: read(defaults, name),
          value: read(branch, name),
          touched: touched.has(name),
        }))
    );
  }

  _setOverride(pref, value, actual) {
    if (value && value !== actual) {
      this._prefs.set(pref, value);
    } else {
      this._prefs.reset(pref);
    }
  }

  _unenrollForced() {
    for (const slug of this._getForcedEnrollments()) {
      if (lazy.ExperimentAPI.manager.store.get(slug)?.active) {
        lazy.ExperimentAPI.manager.unenroll(slug);
      }
    }
    this._prefs.reset(DEVTOOLS_FORCED_ENROLLMENTS_PREF);
  }

  /**
   * Switches the home region, then replaces any enrollments the devtools
   * forced earlier with the chosen recipe branches. Like Nimbus, at most one
   * rollout and one experiment is enrolled per feature, taking recipes in
   * collection order.
   *
   * @param {object} options
   * @param {string} options.region
   * @param {string} [options.locale] Used for newtab's own locale dependent
   *   defaults; the UI language needs a langpack.
   * @param {string} [options.channel] Used for newtab's own channel dependent
   *   defaults; the code that runs is still this build's.
   * @param {boolean} [options.defaultPrefs] Whether to clear this profile's New
   *   Tab prefs until Reset, as a new profile would have.
   * @param {boolean} [options.widgetsInteracted] Whether to mark every widget
   *   as interacted with, which some recipes target.
   * @param {string} [options.version] Used to pick default branches.
   * @param {boolean} [options.useDefaultEnrollments] Whether to ignore
   *   enrollments and enroll in every rollout that reaches all matching
   *   clients, as for values the pane hasn't evaluated.
   * @param {{[slug: string]: string}} [options.enrollments] Branch per recipe.
   * @returns {Promise<string[]>} Problems to show the developer.
   */
  async apply({
    region,
    locale,
    channel,
    version,
    defaultPrefs,
    widgetsInteracted,
    useDefaultEnrollments,
    enrollments: requestedEnrollments,
  }) {
    // These come from content, so anything malformed is dropped.
    const messages = [];
    const upperRegion = String(region ?? "").toUpperCase();
    const validRegion = /^[A-Z]{2}$/.test(upperRegion)
      ? upperRegion
      : undefined;
    if (region && !validRegion) {
      messages.push(`Ignored the region ${region}, which isn't a region code.`);
    }
    const validLocale = isValidLocale(locale) ? locale : undefined;
    // "default" stands for this build's own channel.
    const validChannel =
      channel === "default"
        ? buildChannel()
        : DEVTOOLS_CHANNELS.find(c => c === channel);
    let enrollments = isPlainObject(requestedEnrollments)
      ? requestedEnrollments
      : {};
    if (useDefaultEnrollments === true) {
      // The branches picked in the pane were for other values, so use what
      // most clients with these values get: every rollout that reaches all
      // of them.
      messages.push(
        "Enrolled in the rollouts that reach every client with these values, since the Branch column was for the previous Evaluate."
      );
      const { recipes } = await this.getAvailability({
        region: validRegion,
        locale: validLocale,
        channel: validChannel,
        version,
        widgetsInteracted,
      });
      enrollments = Object.fromEntries(
        recipes
          .filter(r => r.matches && r.isRollout && r.bucketPercent === 100)
          .map(r => [r.slug, r.branches[0]])
      );
    }
    const chosen = Object.entries(enrollments).filter(
      ([, branch]) => typeof branch === "string" && branch
    );
    const canForceEnroll = Services.prefs.getBoolPref(NIMBUS_DEBUG_PREF, false);
    if (chosen.length && !canForceEnroll) {
      messages.push(
        `Skipped the chosen enrollments because ${NIMBUS_DEBUG_PREF} is off.`
      );
    }

    if (defaultPrefs === true) {
      this._clearUserPrefs();
    }
    // Only when it changes, so that applying with the box untouched leaves
    // this profile's own interaction prefs as they are.
    if (
      typeof widgetsInteracted === "boolean" &&
      (this._prefs.get(DEVTOOLS_INTERACTION_BACKUP_PREF) ||
        widgetsInteracted !== this._hasInteractedWithWidgets())
    ) {
      this._setWidgetInteraction(widgetsInteracted);
    }
    // Before the override, so it's only kept if the langpack's locale differs.
    const localeProblem = await this._applyAppLocale(validLocale);
    if (localeProblem) {
      messages.push(localeProblem);
    }
    this._setOverride(
      DEVTOOLS_LOCALE_OVERRIDE_PREF,
      validLocale,
      Services.locale.appLocaleAsBCP47
    );
    this._setOverride(
      DEVTOOLS_CHANNEL_OVERRIDE_PREF,
      validChannel,
      buildChannel()
    );
    await this.applyRegion(validRegion);
    if (defaultPrefs !== true) {
      // After the region and overrides, as in reset().
      this._restoreUserPrefs();
    }
    this._unenrollForced();
    if (canForceEnroll) {
      messages.push(...(await this._forceEnroll(new Map(chosen))));
    }
    return messages;
  }

  /**
   * Force-enrolls in the chosen recipe branches like Nimbus would: at most one
   * rollout and one experiment per feature, taking recipes in collection order.
   *
   * @param {Map<string, string>} chosenBranches - branch per recipe slug
   * @returns {Promise<string[]>} Problems to show the developer.
   */
  async _forceEnroll(chosenBranches) {
    const messages = [];
    const forced = [];
    const takenBy = new Map();
    for (const recipe of await this._getNewtabRecipes()) {
      const branch = chosenBranches.get(recipe.slug);
      if (!branch) {
        continue;
      }
      const type = recipe.isRollout ? "rollout" : "experiment";
      const conflict = recipe.featureIds.find(id =>
        takenBy.has(`${type}:${id}`)
      );
      if (conflict) {
        messages.push(
          `Skipped ${recipe.slug}: the ${type} ${takenBy.get(`${type}:${conflict}`)} already uses ${conflict}.`
        );
        continue;
      }
      if (!(recipe.branches ?? []).some(b => b.slug === branch)) {
        messages.push(`Skipped ${recipe.slug}: it has no branch ${branch}.`);
        continue;
      }
      // Forcing it anyway would replace this profile's own enrollment, which
      // Nimbus never re-enrolls once it was replaced by a forced one.
      const own = lazy.ExperimentAPI.manager.store.get(recipe.slug);
      if (own?.active && own.branch.slug === branch) {
        recipe.featureIds.forEach(id =>
          takenBy.set(`${type}:${id}`, recipe.slug)
        );
        continue;
      }
      const replaced = this._enrollmentsReplacedBy(recipe);
      try {
        await lazy.ExperimentAPI.optInToExperiment({
          slug: recipe.slug,
          branch,
        });
        for (const slug of replaced) {
          messages.push(
            `Forcing ${recipe.slug} replaces your enrollment in ${slug}, which Reset can't bring back.`
          );
        }
        forced.push(`optin-${recipe.slug}`);
        // Recorded right away, so Reset still finds it if the browser closes
        // before the loop ends.
        this._prefs.set(
          DEVTOOLS_FORCED_ENROLLMENTS_PREF,
          JSON.stringify(forced)
        );
        recipe.featureIds.forEach(id =>
          takenBy.set(`${type}:${id}`, recipe.slug)
        );
      } catch (e) {
        messages.push(`Couldn't enroll in ${recipe.slug}: ${e.message}`);
      }
    }
    return messages;
  }

  /**
   * Returns this profile's own enrollments that force-enrolling in a recipe
   * replaces: the same kind, rollout or experiment, on a shared feature.
   *
   * @param {object} recipe
   * @returns {string[]}
   */
  _enrollmentsReplacedBy(recipe) {
    return lazy.ExperimentAPI.manager.store
      .getAll()
      .filter(
        enrollment =>
          enrollment.active &&
          !enrollment.slug.startsWith("optin-") &&
          !!enrollment.isRollout === !!recipe.isRollout &&
          enrollment.featureIds?.some(id => recipe.featureIds.includes(id))
      )
      .map(enrollment => enrollment.slug);
  }

  /**
   * Changes the browser's home region for real, remembering the original one.
   *
   * @param {string} requestedRegion
   */
  async applyRegion(requestedRegion) {
    const region = requestedRegion?.toUpperCase();
    const overridden =
      this._prefs.get(DEVTOOLS_ORIGINAL_REGION_PREF) !== undefined;
    if (
      !/^[A-Z]{2}$/.test(region) ||
      (region === lazy.Region.home && !overridden)
    ) {
      return;
    }
    if (!overridden) {
      this._prefs.set(DEVTOOLS_ORIGINAL_REGION_PREF, lazy.Region.home || "");
    }
    // Nimbus is deliberately not re-evaluated for this region: that would
    // enroll this real client in live recipes for an audience it isn't in, and
    // unenroll it from region-targeted experiments for good. The simulated
    // audience comes from the forced optin- enrollments instead.
    lazy.Region._setHomeRegion(region);
  }

  /**
   * @returns {boolean} Whether anything Apply or the pane changed is still in
   *   effect, going by the bookkeeping prefs.
   */
  _hasDevtoolsState() {
    return DEVTOOLS_BOOKKEEPING_PREFS.some(
      name => this._prefs.get(name) !== undefined
    );
  }

  async reset() {
    if (!this._hasDevtoolsState()) {
      return;
    }
    this._unenrollForced();
    this._prefs.reset(DEVTOOLS_LOCALE_OVERRIDE_PREF);
    this._prefs.reset(DEVTOOLS_CHANNEL_OVERRIDE_PREF);
    this._restoreAppLocale();
    const original = this._prefs.get(DEVTOOLS_ORIGINAL_REGION_PREF);
    if (original !== undefined) {
      if (/^[A-Z]{2}$/.test(original)) {
        lazy.Region._setHomeRegion(original);
      } else if (original === "") {
        // The region was never detected. Region only detects it again on the
        // next startup.
        Services.prefs.clearUserPref("browser.search.region");
      }
      // Only once restored, so a failure above leaves Reset able to retry.
      this._prefs.reset(DEVTOOLS_ORIGINAL_REGION_PREF);
    }
    this._restoreWidgetInteraction();
    // Before restoring, so a backed-up pref the pane also changed gets its
    // backed-up value rather than none.
    this._clearTouchedPrefs();
    this._restoreUserPrefs();
    if (this._prefs.get(DEVTOOLS_ENABLED_NIMBUS_DEBUG_PREF) === true) {
      Services.prefs.clearUserPref(NIMBUS_DEBUG_PREF);
    }
    this._prefs.reset(DEVTOOLS_ENABLED_NIMBUS_DEBUG_PREF);
    // Re-evaluates Nimbus under the real region, which brings back rollouts
    // the region change unenrolled. updateRecipes returns right away while
    // another update runs, so wait for that one first.
    // ponytail: relies on the loader's finishedUpdating(); still races with an
    // update starting in between.
    try {
      const loader = lazy.ExperimentAPI._rsLoader;
      await loader.finishedUpdating();
      await loader.updateRecipes(NIMBUS_DEVTOOLS_TRIGGER);
    } catch (e) {
      lazy.logConsole.error("Couldn't re-evaluate Nimbus after Reset", e);
    }
  }

  /**
   * Refetches the content feed, which caches its responses and doesn't watch
   * the region or locale, keeping the user's blocks and impressions.
   */
  _refreshContent() {
    this.store.dispatch({ type: at.DISCOVERY_STREAM_DEV_REFETCH_CONTENT });
  }

  _afterProfileChange() {
    this._refreshContent();
    this._broadcastDevtoolsChanges();
  }

  async _handleDevtoolsAction(action) {
    if (!this._prefs.get(DEVTOOLS_ENABLED_PREF)) {
      return;
    }
    const { fromTarget } = action.meta;
    const changesProfile =
      action.type === at.DISCOVERY_STREAM_DEV_AVAILABILITY_APPLY ||
      (action.type === at.DISCOVERY_STREAM_DEV_AVAILABILITY_RESET &&
        this._hasDevtoolsState());
    let data;
    try {
      let messages = [];
      switch (action.type) {
        case at.DISCOVERY_STREAM_DEV_AVAILABILITY_APPLY:
          try {
            messages = await this.apply(action.data);
          } finally {
            // Whatever part of Apply ran, the page and the notice follow it.
            this._afterProfileChange();
          }
          break;
        case at.DISCOVERY_STREAM_DEV_AVAILABILITY_RESET:
          try {
            await this.reset();
          } finally {
            if (changesProfile) {
              this._afterProfileChange();
            }
          }
          break;
        case at.DISCOVERY_STREAM_DEV_ENABLE_NIMBUS_DEBUG:
          if (!Services.prefs.getBoolPref(NIMBUS_DEBUG_PREF, false)) {
            Services.prefs.setBoolPref(NIMBUS_DEBUG_PREF, true);
            this._prefs.set(DEVTOOLS_ENABLED_NIMBUS_DEBUG_PREF, true);
          }
          break;
      }
      this._broadcastDevtoolsChanges();
      data = { ...(await this.getAvailability(action.data)), messages };
    } catch (e) {
      lazy.logConsole.error("Failed to evaluate feature availability", e);
      // Answered anyway, so the pane can say so instead of loading forever.
      data = { error: String(e) };
    }
    this.store.dispatch(
      ac.OnlyToOneContent(
        { type: at.DISCOVERY_STREAM_DEV_AVAILABILITY_UPDATE, data },
        fromTarget
      )
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
      case at.DISCOVERY_STREAM_DEV_AVAILABILITY_REQUEST:
      case at.DISCOVERY_STREAM_DEV_AVAILABILITY_APPLY:
      case at.DISCOVERY_STREAM_DEV_AVAILABILITY_RESET:
      case at.DISCOVERY_STREAM_DEV_ENABLE_NIMBUS_DEBUG:
        // One at a time, so a second click can't interleave with an Apply or
        // Reset that is still changing enrollments and prefs.
        this._devtoolsQueue = this._devtoolsQueue
          .then(() => this._handleDevtoolsAction(action))
          // A failure must not stop the actions queued after it.
          .catch(e =>
            lazy.logConsole.error("Failed to handle a devtools action", e)
          );
        break;
      case at.DISCOVERY_STREAM_DEV_TRACK_PREFS:
        if (
          this._prefs.get(DEVTOOLS_ENABLED_PREF) &&
          Array.isArray(action.data?.names) &&
          action.data.names.every(name => typeof name === "string")
        ) {
          this._trackTouchedPrefs(action.data.names);
          this._broadcastDevtoolsChanges();
        }
        break;
    }
  }
}
