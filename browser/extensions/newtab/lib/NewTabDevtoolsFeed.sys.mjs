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
  ASRouterTargeting: "resource:///modules/asrouter/ASRouterTargeting.sys.mjs",
  ExperimentAPI: "resource://nimbus/ExperimentAPI.sys.mjs",
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
// The global English and Spanish story feeds (bug 2066559) serve any region
// without a feed of its own, so each is offered as an audience in such a region.
const GLOBAL_FEED_AUDIENCES = [
  { region: "AU", locale: "en-US", label: "Global English feed" },
  { region: "MX", locale: "es-MX", label: "Global Spanish feed" },
];
const EXTERNAL_FETCH_TIMEOUT_MS = 5000;
const WIDGET_INTERACTION_PREF = /^widgets\..+\.interaction$/;
// A recipe reading a widget interaction pref, e.g. to target engaged users.
const WIDGET_INTERACTION_TARGETING =
  /(['"])browser\.newtabpage\.activity-stream\.widgets\.[^'"]+\.interaction\1\|preferenceValue/g;
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

  async _getNewtabRecipes() {
    const collection = Services.prefs.getStringPref(
      NIMBUS_COLLECTION_PREF,
      "nimbus-desktop-experiments"
    );
    return (await lazy.RemoteSettings(collection).get()).filter(isNewtabRecipe);
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

  async _handleDevtoolsAction(action) {
    if (!this._prefs.get(DEVTOOLS_ENABLED_PREF)) {
      return;
    }
    let data;
    try {
      data = await this.getAvailability(action.data);
    } catch (e) {
      lazy.logConsole.error("Failed to evaluate feature availability", e);
      // Answered anyway, so the pane can say so instead of loading forever.
      data = { error: String(e) };
    }
    this.store.dispatch(
      ac.OnlyToOneContent(
        { type: at.DISCOVERY_STREAM_DEV_AVAILABILITY_UPDATE, data },
        action.meta.fromTarget
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
        this._devtoolsQueue = this._devtoolsQueue
          .then(() => this._handleDevtoolsAction(action))
          // A failure must not stop the actions queued after it.
          .catch(e =>
            lazy.logConsole.error("Failed to handle a devtools action", e)
          );
        break;
    }
  }
}
