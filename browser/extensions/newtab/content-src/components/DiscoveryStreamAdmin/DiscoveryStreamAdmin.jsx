/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

import { actionCreators as ac, actionTypes as at } from "common/Actions.mjs";
import {
  WIDGET_REGISTRY,
  getWidgetAddableSources,
  getWidgetsContainerSources,
  hasContentAreaWidgets,
  isWidgetDataUnavailable,
  isWidgetsContainerVisible,
} from "common/WidgetsRegistry.mjs";
import {
  DEFAULT_PAGE_LAYOUT_VARIANT,
  PAGE_LAYOUT_VARIANTS,
  PREF_PAGE_LAYOUT_VARIANT,
  isSideBySideAssigned,
  isSpaceOverridden,
  isSpacesAssigned,
  isSpacesThematicAssigned,
  PREF_SPACES_CONFIG,
  SPACE_IDS,
  resolvePageLayoutVariant,
  resolvePopulatedSpaces,
  resolveThematicSpacesConfig,
} from "common/PageLayoutVariants.mjs";
// @nova-cleanup(move-directory): Update import path after useWidgetLabels moves
// to components/CustomizeMenu/WidgetsManagementPanel/
import { useWidgetLabels } from "content-src/components/Nova/CustomizeMenu/WidgetsManagementPanel/useWidgetLabels.jsx";
import { connect } from "react-redux";
import React from "react";

// Pref Constants
const PREF_AD_SIZE_MEDIUM_RECTANGLE = "newtabAdSize.mediumRectangle";
const PREF_AD_SIZE_BILLBOARD = "newtabAdSize.billboard";
const PREF_SECTIONS_ENABLED = "discoverystream.sections.enabled";
const PREF_SPOC_PLACEMENTS = "discoverystream.placements.spocs";
const PREF_SPOC_COUNTS = "discoverystream.placements.spocs.counts";
const PREF_CONTEXTUAL_ADS_ENABLED =
  "discoverystream.sections.contextualAds.enabled";
const PREF_CONTEXTUAL_BANNER_PLACEMENTS =
  "discoverystream.placements.contextualBanners";
const PREF_CONTEXTUAL_BANNER_COUNTS =
  "discoverystream.placements.contextualBanners.counts";
const PREF_UNIFIED_ADS_ENABLED = "unifiedAds.spocs.enabled";
const PREF_UNIFIED_ADS_ENDPOINT = "unifiedAds.endpoint";
const PREF_ALLOWED_ENDPOINTS = "discoverystream.endpoints";
const PREF_OHTTP_CONFIG = "discoverystream.ohttp.configURL";
const PREF_OHTTP_RELAY = "discoverystream.ohttp.relayURL";
const PREF_WIDGETS_SYSTEM_ENABLED = "widgets.system.enabled";

// Internal, pref-gated widget features that default off but we want to test in
// devtools. Hand-maintained (outside the automatic registry-driven toggles).
// Each `pref` is the full activity-stream-relative pref; toggles reuse
// handleWidgetToggle, which sets the pref named by the toggle's id.
const WIDGET_EXTRA_FEATURES = {
  pictureOfTheDay: [
    {
      pref: "widgets.pictureOfTheDay.setAsWallpaper.enabled",
      label: "Set as wallpaper",
    },
  ],
  privacy: [{ pref: "widgets.privacy.showVpnMessages", label: "VPN messages" }],
};

// Indents a JSON string for editing, or hands back whatever it was given when
// that is not possible -- a draft mid-edit is often not valid JSON.
function prettyJson(value) {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

/**
 * Explains whether a widget renders, following the same checks as Widgets.jsx.
 *
 * @param {object} widget - a WIDGET_REGISTRY entry
 * @param {object} prefs - current pref values from the Redux store
 * @param {object} state
 * @param {boolean} state.discoveryStreamEnabled - whether the Discovery Stream
 *   layout, which mounts the widgets, is on
 * @param {boolean} state.weatherInitialized - whether weather data has loaded
 * @returns {{shown: boolean, reason: string}}
 */
export function explainWidgetVisibility(
  widget,
  prefs,
  { discoveryStreamEnabled = true, weatherInitialized } = {}
) {
  const hidden = reason => ({ shown: false, reason });
  if (!discoveryStreamEnabled) {
    return hidden(
      "The Discovery Stream layout that holds the widgets is off (discoverystream.config)"
    );
  }
  if (!isWidgetsContainerVisible(prefs)) {
    return hidden(
      "The widgets container is off: none of widgets.system.enabled, the newtabWidgets Nimbus feature's enabled, trainhopConfig.widgets.enabled or trainhopConfig.widgetsSettings.enabled is set. On Release a newtabTrainhop rollout normally turns it on"
    );
  }
  if (
    !prefs["widgets.enabled"] &&
    !isSpaceOverridden(SPACE_IDS.WIDGETS, prefs)
  ) {
    return hidden("The user turned all widgets off (widgets.enabled)");
  }
  if (isWidgetDataUnavailable(widget, prefs)) {
    return hidden(
      prefs.recordsHistory === false && widget.requiresHistory
        ? "Needs browsing history, which this profile doesn't record"
        : "Needs search partner codes this Firefox version can't generate"
    );
  }
  const sources = getWidgetAddableSources(widget, prefs);
  if (!sources.length) {
    const candidates = [
      widget.systemEnabledPref,
      widget.trainhopEnabledKey &&
        `trainhopConfig.widgets.${widget.trainhopEnabledKey}`,
      widget.trainhopNamespace &&
        `trainhopConfig.${widget.trainhopNamespace}.visible`,
      widget.widgetsSettingsVisibleKey &&
        `trainhopConfig.widgetsSettings.${widget.widgetsSettingsVisibleKey}`,
    ].filter(Boolean);
    return hidden(`Not available: none of ${candidates.join(", ")} is set`);
  }
  if (!prefs[widget.enabledPref]) {
    return hidden(`The user turned it off (${widget.enabledPref})`);
  }
  if (widget.id === "weather") {
    if (!prefs.showWeather) {
      return hidden("The user turned weather off (showWeather)");
    }
    if (
      !prefs["system.showWeather"] &&
      !prefs.trainhopConfig?.weather?.enabled
    ) {
      return hidden(
        "Weather isn't enabled here (system.showWeather or trainhopConfig.weather.enabled)"
      );
    }
    if (!weatherInitialized) {
      return hidden("Weather data hasn't loaded");
    }
  }
  return { shown: true, reason: `Available via ${sources.join(", ")}` };
}

function WidgetVisibility({ prefs, state }) {
  const containerSources = getWidgetsContainerSources(prefs);
  return (
    <>
      <h4>Why each widget is or isn&apos;t showing</h4>
      <p>
        Widgets container:{" "}
        {containerSources.length
          ? `on via ${containerSources.join(", ")}`
          : "off"}
        . See the Train Hop section for the trainhopConfig your enrollments
        deliver, and Feature availability for which recipes set it.
      </p>
      <table className="availability-table widget-visibility">
        <thead>
          <tr>
            <th>Widget</th>
            <th>State</th>
            <th>Reason</th>
          </tr>
        </thead>
        <tbody>
          {WIDGET_REGISTRY.filter(widget => !widget.retired).map(widget => {
            const { shown, reason } = explainWidgetVisibility(
              widget,
              prefs,
              state
            );
            return (
              <Row
                key={widget.id}
                className={shown ? "message-item" : "message-item changed"}
              >
                <td className="min">{widget.id}</td>
                <td className="min">{shown ? "Shown" : "Hidden"}</td>
                <td>{reason}</td>
              </Row>
            );
          })}
        </tbody>
      </table>
    </>
  );
}

// Sorted A-Z by the customize panel label, the rule the panel and the
// about:preferences Widgets group use. onToggle sets the pref named by the
// toggle's id.
function WidgetSystemToggles({ otherPrefs, widgetsSystemEnabled, onToggle }) {
  const activeWidgets = WIDGET_REGISTRY.filter(w => !w.retired);
  const labels = useWidgetLabels(activeWidgets);
  const sortedWidgets = labels
    ? [...activeWidgets].sort((a, b) =>
        (labels.get(a.id) ?? a.id).localeCompare(labels.get(b.id) ?? b.id)
      )
    : [];

  return sortedWidgets.map(widget => (
    <React.Fragment key={widget.id}>
      <div className="toggle-wrapper">
        <moz-toggle
          id={widget.systemEnabledPref}
          pressed={otherPrefs[widget.systemEnabledPref] || null}
          disabled={!widgetsSystemEnabled || null}
          ontoggle={onToggle}
          data-l10n-id={widget.customizeL10nId}
        />
      </div>
      {(WIDGET_EXTRA_FEATURES[widget.id] || []).map(feature => (
        <div
          className="toggle-wrapper"
          key={feature.pref}
          style={{ marginInlineStart: "var(--space-large)" }}
        >
          <moz-toggle
            id={feature.pref}
            pressed={otherPrefs[feature.pref] || null}
            disabled={!widgetsSystemEnabled || null}
            ontoggle={onToggle}
            label={feature.label}
          />
        </div>
      ))}
    </React.Fragment>
  ));
}

// Devtools-only copy, so not localized. A variant with no entry falls back to its
// raw pref value and renders no description.
const PAGE_LAYOUTS_INFO = {
  // @experiment(remove) { bug 2066527 }
  [PAGE_LAYOUT_VARIANTS.AUTO_MINIMIZE_WIDGETS]: {
    label: "Auto-minimize Widgets",
    description:
      "Nova, but the widgets section collapses to just its title a few " +
      "seconds after load.",
  },
  [PAGE_LAYOUT_VARIANTS.NOVA_FULL_WIDTH]: {
    label: "Nova",
    description:
      "Today's layout. Widgets sit in a row above the stories, and both run " +
      "the full width of the screen.",
  },
  [PAGE_LAYOUT_VARIANTS.SIDE_BY_SIDE_CONTENT_LEAD]: {
    label: "Side-by-side (Content lead)",
    description:
      "Stories on the left, widgets stacked in one narrow column on the " +
      "right. Stories get up to three cards across.",
  },
  [PAGE_LAYOUT_VARIANTS.SIDE_BY_SIDE_WIDGETS_LEAD]: {
    label: "Side-by-side (Widgets lead)",
    description:
      "Widgets stacked in one narrow column on the left, stories on the " +
      "right. Stories get up to three cards across.",
  },
  [PAGE_LAYOUT_VARIANTS.SIDE_BY_SIDE_CONTENT_LEAD_FIVE]: {
    label: "Side-by-side (Content lead, five columns)",
    description:
      "Same as Content lead, but stories get a fourth card across on wide " +
      "screens.",
  },
  [PAGE_LAYOUT_VARIANTS.SIDE_BY_SIDE_WIDGETS_LEAD_FIVE]: {
    label: "Side-by-side (Widgets lead, five columns)",
    description:
      "Same as Widgets lead, but stories get a fourth card across on wide " +
      "screens.",
  },
  [PAGE_LAYOUT_VARIANTS.SPACES_BUTTONS_BOTTOM]: {
    label: "Spaces (Buttons at the bottom)",
    description:
      "Stories, widgets and Highlights each get their own panel, navigated " +
      "with a segmented control floating at the bottom of the window.",
  },
  [PAGE_LAYOUT_VARIANTS.SPACES_BUTTONS_TOP]: {
    label: "Spaces (Buttons at the top)",
    description: "Same as above, with the segmented control above the content.",
  },
  [PAGE_LAYOUT_VARIANTS.SPACES_THEMATIC_V1]: {
    label: "Spaces (Thematic)",
    description:
      "Panels named for interests rather than for what is in them, each " +
      "holding the whole side-by-side pair over only its own content topics " +
      "and widgets.",
  },
  [PAGE_LAYOUT_VARIANTS.SPACES_FLOATING_ARROWS]: {
    label: "Spaces (Floating arrows)",
    description:
      "Same panels as the buttons variants, navigated with an arrow at each " +
      "edge leading to the space beyond it instead of a segmented control. " +
      "pageLayouts.spacesOrder sets the order.",
  },
  [PAGE_LAYOUT_VARIANTS.SPACES_PREVIEW_KIT]: {
    label: "Spaces (Preview with Kit)",
    description:
      "Buttons at the bottom, where each tab previews its space with an " +
      "illustration of Kit moving through it.",
  },
  [PAGE_LAYOUT_VARIANTS.SPACES_PREVIEW_ILLUSTRATED]: {
    label: "Spaces (Preview without Kit)",
    description: "Same as above, with the illustrations alone.",
  },
  [PAGE_LAYOUT_VARIANTS.SPACES_PREVIEW_CARDS]: {
    label: "Spaces (Preview with cards)",
    description:
      "Buttons at the bottom, where each tab previews its space's first " +
      "medium story card, else its first widget or Recent activity card.",
  },
  [PAGE_LAYOUT_VARIANTS.SPACES_PEEK]: {
    label: "Spaces (Peek)",
    description:
      "Buttons at the bottom, plus a preview of the spaces on either side in " +
      "the page margins. Clicking one navigates there.",
  },
  // @experiment(remove) { bug 2069496 }
  [PAGE_LAYOUT_VARIANTS.WIDGETS_AD_LARGE]: {
    label: "Widgets row ad (large)",
    description:
      "Nova, plus a large sponsored card at the end of the first widget row. " +
      "At one card column it sits second. It stays large when minimized.",
  },
  // @experiment(remove) { bug 2078816 }
  [PAGE_LAYOUT_VARIANTS.WIDGET_FIRST_CONTENT_SLOT]: {
    label: "Widget in first content slot",
    description:
      "A widget occupies the first card of Popular Today. " +
      "pageLayouts.widgetFirstContentSlot.widget picks the widget type.",
  },
};

// Falls back to the raw pref value for a variant with no PAGE_LAYOUTS_INFO entry.
function variantLabel(variant) {
  return PAGE_LAYOUTS_INFO[variant]?.label ?? variant;
}

const Row = props => (
  <tr className="message-item" {...props}>
    {props.children}
  </tr>
);

function relativeTime(timestamp) {
  if (!timestamp) {
    return "";
  }
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  const minutes = Math.floor((Date.now() - timestamp) / 60000);
  if (seconds < 2) {
    return "just now";
  } else if (seconds < 60) {
    return `${seconds} seconds ago`;
  } else if (minutes === 1) {
    return "1 minute ago";
  } else if (minutes < 600) {
    return `${minutes} minutes ago`;
  }
  return new Date(timestamp).toLocaleString();
}

export class ToggleStoryButton extends React.PureComponent {
  constructor(props) {
    super(props);
    this.handleClick = this.handleClick.bind(this);
  }

  handleClick() {
    this.props.onClick(this.props.story);
  }

  render() {
    return <moz-button onClick={this.handleClick}>collapse/open</moz-button>;
  }
}

export class TogglePrefCheckbox extends React.PureComponent {
  constructor(props) {
    super(props);
    this.onChange = this.onChange.bind(this);
  }

  onChange(event) {
    this.props.onChange(this.props.pref, event.target.checked);
  }

  render() {
    return (
      <>
        <input
          type="checkbox"
          checked={this.props.checked}
          onChange={this.onChange}
          disabled={this.props.disabled}
        />{" "}
        {this.props.pref}{" "}
      </>
    );
  }
}

const AVAILABILITY_CHANNELS = ["release", "beta", "nightly", "esr"];
const AVAILABILITY_FORM_ID = "feature-availability-form";
const AVAILABILITY_RECIPE_COLUMNS = 8;
const AVAILABILITY_RETRY_MS = 8000;
const AVAILABILITY_CHANGES_DEBOUNCE_MS = 250;
const DEVTOOLS_ENABLED_PREF = "asrouter.devtoolsEnabled";
const ENROLL_FIELD_PREFIX = "enroll:";

/**
 * Lists, per widget, the matching recipe branches that make it available.
 *
 * @param {object[]} recipes - availability recipe results
 * @returns {Map<string, string[]>} widget id to descriptions of its sources
 */
function widgetSources(recipes) {
  const sources = new Map();
  for (const r of recipes.filter(recipe => recipe.matches)) {
    const branchesByWidget = new Map();
    for (const { branch, widgets } of r.widgets) {
      for (const id of widgets) {
        branchesByWidget.set(id, [...(branchesByWidget.get(id) ?? []), branch]);
      }
    }
    for (const [id, branches] of branchesByWidget) {
      const type = r.isRollout ? "rollout" : "experiment";
      const branchNote =
        branches.length < r.branches.length
          ? `, ${branches.length} of ${r.branches.length} branches: ${branches.join(", ")}`
          : "";
      sources.set(id, [
        ...(sources.get(id) ?? []),
        `${r.slug} (${type}, ${r.bucketPercent}% of clients${branchNote})`,
      ]);
    }
  }
  return sources;
}

const MATCH_LABELS = new Map([
  [true, "Yes"],
  [false, "No"],
  [null, "Error"],
]);

function formatPrefValue(value) {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/**
 * Shows which newtab Nimbus recipes and region/locale dependent default prefs
 * apply to a given region, locale, channel and version, and lets the browser's
 * home region be switched for real.
 */
// Memoized: the pane re-renders on every feed and pref update, and this
// renders a row pair per recipe.
export const FeatureAvailability = React.memo(function FeatureAvailability({
  availability,
  devtoolsChanges: currentChanges = [],
  dispatch,
}) {
  const [onlyMatching, setOnlyMatching] = React.useState(false);
  const formRef = React.useRef(null);
  // The audience picked since the last result, keyed by that result so a new
  // one starts from its own region and locale.
  const [audienceChoice, setAudienceChoice] = React.useState(null);
  // Set while a request is in flight, so Apply can't be clicked again before
  // the last one finished.
  const [pending, setPending] = React.useState(false);
  const pendingRef = React.useRef(false);
  pendingRef.current = pending;
  // Announced by the always-present status region once a request finishes.
  const [statusText, setStatusText] = React.useState("");
  React.useEffect(() => {
    if (pendingRef.current) {
      setStatusText(
        availability?.error
          ? `Failed: ${availability.error}`
          : ["Done.", ...(availability?.messages ?? [])].join(" ")
      );
    }
    setPending(false);
  }, [availability]);

  const requestAvailability = React.useCallback(
    () =>
      dispatch(
        ac.OnlyToMain({ type: at.DISCOVERY_STREAM_DEV_AVAILABILITY_REQUEST })
      ),
    [dispatch]
  );
  // Ask again while no answer at all has arrived, rather than showing Loading
  // forever. An error is an answer: it offers Retry instead.
  const loaded = !!availability?.recipes;
  const waiting = !availability;
  React.useEffect(() => {
    if (!waiting) {
      return undefined;
    }
    const timer = setInterval(requestAvailability, AVAILABILITY_RETRY_MS);
    return () => clearInterval(timer);
  }, [waiting, requestAvailability]);

  // What's applied changed since this result: another tab's Apply or Reset,
  // the notice's Reset, or a pref changed in the pane. This tab's own
  // requests are answered directly. Starts from the result's own list, so a
  // result older than the reopened section is refreshed too.
  const changesKey = currentChanges.join("\n");
  const seenChangesKey = React.useRef(
    (availability?.devtoolsChanges ?? currentChanges).join("\n")
  );
  React.useEffect(() => {
    if (seenChangesKey.current === changesKey) {
      return undefined;
    }
    seenChangesKey.current = changesKey;
    // Coalesces the several broadcasts one change can cause.
    const timer = setTimeout(() => {
      if (loaded && !pendingRef.current) {
        requestAvailability();
      }
    }, AVAILABILITY_CHANGES_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [changesKey, loaded, requestAvailability]);
  const sourcesByWidget = React.useMemo(
    () => widgetSources(availability?.recipes ?? []),
    [availability?.recipes]
  );

  if (!loaded) {
    return (
      <p role="status">
        {availability?.error
          ? `Couldn't load feature availability: ${availability.error}`
          : "Loading..."}{" "}
        <button type="button" className="button" onClick={requestAvailability}>
          Retry
        </button>
      </p>
    );
  }

  const {
    region,
    locale,
    channel,
    version,
    widgetsInteracted,
    options,
    nimbusDebug,
    studiesEnabled,
    changedPrefs = [],
    messages = [],
    error,
  } = availability;

  const send = type => {
    // aria-disabled rather than disabled, so the focused button keeps focus.
    if (pending) {
      return;
    }
    const data = { enrollments: {} };
    for (const [field, value] of new FormData(formRef.current)) {
      if (field.startsWith(ENROLL_FIELD_PREFIX)) {
        data.enrollments[field.slice(ENROLL_FIELD_PREFIX.length)] = value;
      } else {
        data[field] = value;
      }
    }
    // Sent either way, since an unchecked box is missing from FormData.
    data.widgetsInteracted = formRef.current.elements.widgetsInteracted.checked;
    data.defaultPrefs = formRef.current.elements.defaultPrefs.checked;
    // The Branch column belongs to the last result. If the values changed
    // since, let Apply pick the default branches for the new ones.
    const evaluated = { region, locale, channel, version, widgetsInteracted };
    if (Object.keys(evaluated).some(key => data[key] !== evaluated[key])) {
      data.useDefaultEnrollments = true;
      data.enrollments = {};
    }
    setPending(true);
    dispatch(ac.OnlyToMain({ type, data }));
  };
  const onSubmit = e => {
    e.preventDefault();
    send(at.DISCOVERY_STREAM_DEV_AVAILABILITY_REQUEST);
  };
  const clearPref = prefName => {
    if (pending) {
      return;
    }
    dispatch(ac.OnlyToMain({ type: at.CLEAR_PREF, data: { name: prefName } }));
    send(at.DISCOVERY_STREAM_DEV_AVAILABILITY_REQUEST);
  };
  const devtoolsChanges = availability.devtoolsChanges ?? [];
  const audienceFor = (audienceRegion, audienceLocale) =>
    options.presets.some(
      p => p.region === audienceRegion && p.locale === audienceLocale
    )
      ? `${audienceRegion}|${audienceLocale}`
      : "";
  const formKey = [region, locale, channel, version, widgetsInteracted].join();
  const audience =
    audienceChoice?.formKey === formKey
      ? audienceChoice.value
      : audienceFor(region, locale);
  const recipes = onlyMatching
    ? availability.recipes.filter(r => r.matches)
    : availability.recipes;

  return (
    <div className="feature-availability">
      <form
        id={AVAILABILITY_FORM_ID}
        ref={formRef}
        onSubmit={onSubmit}
        key={formKey}
      >
        <div className="availability-row">
          <label>
            Audience{" "}
            <select
              aria-describedby="availability-audience-note"
              value={audience}
              onChange={e => {
                const { value } = e.target;
                if (value) {
                  const [presetRegion, presetLocale] = value.split("|");
                  formRef.current.elements.region.value = presetRegion;
                  formRef.current.elements.locale.value = presetLocale;
                }
                setAudienceChoice({ formKey, value });
              }}
            >
              <option value="">Custom</option>
              {options.presets.map(p => (
                <option
                  key={`${p.region}|${p.locale}`}
                  value={`${p.region}|${p.locale}`}
                >
                  {p.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        {/* Hidden rather than removed, so the form still submits the region and
        locale the audience set. */}
        <div className="availability-row" hidden={audience !== ""}>
          <label>
            Region{" "}
            <select name="region" defaultValue={region}>
              {options.regions.map(r => (
                <option key={r.value} value={r.value}>
                  {r.label} ({r.value})
                </option>
              ))}
            </select>
          </label>
          <label>
            Locale{" "}
            <select name="locale" defaultValue={locale}>
              {options.locales.map(l => (
                <option key={l.value} value={l.value}>
                  {l.label} ({l.value})
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="availability-row">
          <label>
            Channel{" "}
            <select name="channel" defaultValue={channel}>
              {[...new Set([channel, ...AVAILABILITY_CHANNELS])].map(c => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <label>
            Version{" "}
            <select
              name="version"
              defaultValue={version}
              onChange={e => {
                const choice = options.versions.find(
                  v => v.value === e.target.value
                );
                if (choice?.channel) {
                  formRef.current.elements.channel.value = choice.channel;
                }
              }}
            >
              {options.versions.map(v => (
                <option key={v.value} value={v.value}>
                  {v.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="availability-row">
          <label>
            <input
              type="checkbox"
              name="widgetsInteracted"
              defaultChecked={widgetsInteracted}
              aria-describedby="availability-interaction-note"
            />{" "}
            Has interacted with widgets
          </label>
        </div>
        <div className="availability-row">
          <button
            type="submit"
            className="button"
            aria-disabled={pending ? "true" : undefined}
          >
            Evaluate
          </button>
          <button
            type="button"
            className="button"
            aria-disabled={pending ? "true" : undefined}
            onClick={() => send(at.DISCOVERY_STREAM_DEV_AVAILABILITY_APPLY)}
          >
            Apply
          </button>
          <label>
            <input
              type="checkbox"
              name="defaultPrefs"
              // Keyed on what it defaults from, since the form isn't
              // remounted when only what's applied changes.
              key={`${availability.defaultPrefsApplied}-${!devtoolsChanges.length}`}
              defaultChecked={
                availability.defaultPrefsApplied || !devtoolsChanges.length
              }
            />{" "}
            Start from default New Tab prefs
          </label>
          <button
            type="button"
            className="button"
            aria-disabled={pending ? "true" : undefined}
            onClick={() => {
              if (pending) {
                return;
              }
              setPending(true);
              dispatch(
                ac.OnlyToMain({
                  type: at.DISCOVERY_STREAM_DEV_AVAILABILITY_RESET,
                })
              );
            }}
          >
            Reset
          </button>
          <span role="status" className="availability-status">
            {pending ? "Working..." : statusText}
          </span>
        </div>
      </form>
      <p id="availability-audience-note" className="availability-note">
        Audiences are the region and locale pairs our newtab recipes target,
        most targeted first. Choose Custom to pick the region and locale
        yourself. Versions come from whattrainisitnow.com, and picking one also
        picks its channel.
      </p>
      <p id="availability-interaction-note" className="availability-note">
        Some rollouts only target users who have used a widget, read from the
        widgets.*.interaction prefs. The box starts from this profile; Evaluate
        uses it in place of those prefs, and Apply sets or clears them all.
      </p>
      <p className="availability-note">
        Evaluate only simulates targeting, as a client that isn&apos;t enrolled
        in anything. Apply makes this profile as close as it can to a user with
        these values, and what this profile sends to Mozilla follows: it changes
        the home region for real (including browser.search.region, search
        defaults and partner codes, and the region in telemetry), uses the
        locale and channel for New Tab&apos;s own region, locale and channel
        dependent defaults, optionally clears your New Tab prefs (keeping ones
        Nimbus manages), and force-enrolls the branches chosen in the Branch
        column. Rollouts that reach every client are chosen by default; partial
        rollouts and experiments aren&apos;t, as for most users. The UI switches
        to the closest langpack for the locale, installing it if needed, and the
        code that runs is this build&apos;s whatever version you pick. Nimbus
        isn&apos;t re-evaluated for the applied region, so this profile
        isn&apos;t enrolled in live recipes for an audience it isn&apos;t in;
        the forced branches stand in for them. Forcing a branch permanently
        replaces this profile&apos;s own enrollment on the same feature, so use
        a profile you don&apos;t mind changing. Reload the tab to see the
        result. Reset puts back the region, locale, channel, prefs and widget
        interaction, removes the forced enrollments, turns nimbus.debug off if
        this pane turned it on, and re-evaluates Nimbus. It can&apos;t bring
        back enrollments a forced branch replaced, and installed langpacks stay
        installed.
      </p>
      {studiesEnabled === false ? (
        <p className="availability-override">
          Apply can&apos;t force-enroll because Nimbus studies are off on this
          profile. They need datareporting.healthreport.uploadEnabled and
          app.shield.optoutstudies.enabled, and no policy disabling studies.
        </p>
      ) : null}
      {nimbusDebug ? null : (
        <p className="availability-override">
          Apply can&apos;t force-enroll while nimbus.debug is off.{" "}
          <button
            type="button"
            className="button"
            onClick={() => send(at.DISCOVERY_STREAM_DEV_ENABLE_NIMBUS_DEBUG)}
          >
            Enable nimbus.debug
          </button>
        </p>
      )}
      {messages.length ? (
        <ul className="availability-override">
          {messages.map(message => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      ) : null}
      {error ? (
        <p className="availability-override">Last request failed: {error}</p>
      ) : null}
      {devtoolsChanges.length ? (
        <p className="availability-override">
          Applied: {devtoolsChanges.join("; ")}.
        </p>
      ) : null}
      <h3>Nimbus recipes ({recipes.length})</h3>
      <h4>Widgets made available by matching recipes</h4>
      {sourcesByWidget.size ? (
        <ul className="availability-widget-sources">
          {[...sourcesByWidget].map(([id, sources]) => (
            <li key={id}>
              {id}: {sources.join("; ")}
            </li>
          ))}
        </ul>
      ) : (
        <p>None</p>
      )}
      <label>
        <input
          type="checkbox"
          checked={onlyMatching}
          onChange={e => setOnlyMatching(e.target.checked)}
        />{" "}
        Only matching
      </label>
      <table className="availability-table">
        <thead>
          <tr>
            <th>Slug</th>
            <th>Type</th>
            <th>Features</th>
            <th>Widgets</th>
            <th>Bucket</th>
            <th>Matches</th>
            <th>Enrolled</th>
            <th>Branch</th>
          </tr>
        </thead>
        <tbody
          key={[
            region,
            locale,
            channel,
            version,
            ...(availability.forcedEnrollments ?? []),
          ].join()}
        >
          {recipes.map(r => (
            <React.Fragment key={r.slug}>
              <Row className="message-item availability-recipe-row">
                <td>
                  <a
                    target="_blank"
                    rel="noopener noreferrer"
                    href={`https://experimenter.services.mozilla.com/nimbus/${r.slug}/summary`}
                  >
                    {r.slug}
                  </a>
                  {r.userFacingDescription ? (
                    <p className="availability-description">
                      {r.userFacingDescription}
                    </p>
                  ) : null}
                </td>
                <td>{r.isRollout ? "Rollout" : "Experiment"}</td>
                <td>{r.featureIds.join(", ")}</td>
                <td>
                  {r.widgets.map(({ branch, widgets }) => (
                    <div key={branch}>
                      {r.widgets.length > 1 ? `${branch}: ` : ""}
                      {widgets.join(", ")}
                    </div>
                  ))}
                </td>
                <td className="min">{r.bucketPercent}%</td>
                <td className="min">
                  {MATCH_LABELS.get(r.matches)}
                  {r.profileTargeting.length ? (
                    <div className="availability-profile-targeting">
                      Also depends on this profile&apos;s{" "}
                      {r.profileTargeting.join(", ")}
                    </div>
                  ) : null}
                </td>
                <td className="min">
                  {r.enrolledBranch ?? ""}
                  {r.forcedBranch ? `forced: ${r.forcedBranch}` : ""}
                </td>
                <td className="min">
                  {r.matches ? (
                    <select
                      form={AVAILABILITY_FORM_ID}
                      name={`${ENROLL_FIELD_PREFIX}${r.slug}`}
                      aria-label={`Branch to enroll in for ${r.slug}`}
                      defaultValue={
                        r.forcedBranch ??
                        // Most clients are only in rollouts that reach all of
                        // them; Nimbus buckets them out of partial ones.
                        (r.isRollout && r.bucketPercent === 100
                          ? r.branches[0]
                          : "")
                      }
                    >
                      <option value="">Don&apos;t enroll</option>
                      {r.branches.map(branch => (
                        <option key={branch} value={branch}>
                          {branch}
                        </option>
                      ))}
                    </select>
                  ) : null}
                </td>
              </Row>
              <Row className="message-item availability-targeting-row">
                <td colSpan={AVAILABILITY_RECIPE_COLUMNS}>
                  <details>
                    <summary>Targeting for {r.slug}</summary>
                    <code>{r.targeting}</code>
                  </details>
                </td>
              </Row>
            </React.Fragment>
          ))}
        </tbody>
      </table>
      <h3>Region and locale dependent prefs</h3>
      <table className="availability-table">
        <thead>
          <tr>
            <th>Pref</th>
            <th>Current</th>
            <th>Simulated</th>
          </tr>
        </thead>
        <tbody>
          {availability.prefs.map(p => (
            <Row
              key={p.name}
              className={
                p.current === p.simulated
                  ? "message-item"
                  : "message-item changed"
              }
            >
              <td>{p.name}</td>
              <td>{formatPrefValue(p.current)}</td>
              <td>{formatPrefValue(p.simulated)}</td>
            </Row>
          ))}
        </tbody>
      </table>
      <h3>Prefs changed from their defaults ({changedPrefs.length})</h3>
      <p className="availability-note">
        Every browser.newtabpage.activity-stream pref with a user value. Ones
        marked devtools were changed in this pane, and Reset clears them; Clear
        resets a single pref.
      </p>
      <table className="availability-table">
        <thead>
          <tr>
            <th>Pref</th>
            <th>Default</th>
            <th>Current</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {changedPrefs.map(p => (
            <Row
              key={p.name}
              className={p.touched ? "message-item changed" : "message-item"}
            >
              <td>
                {p.name}
                {p.touched ? " (devtools)" : ""}
              </td>
              <td>
                <code>
                  {p.defaultValue === undefined
                    ? "none"
                    : formatPrefValue(p.defaultValue)}
                </code>
              </td>
              <td>
                <code>{formatPrefValue(p.value)}</code>
              </td>
              <td className="min">
                {/* The parent ignores content clearing the devtools gate. */}
                {p.name === DEVTOOLS_ENABLED_PREF ? null : (
                  <button
                    type="button"
                    className="button"
                    aria-disabled={pending ? "true" : undefined}
                    aria-label={`Clear ${p.name}`}
                    onClick={() => clearPref(p.name)}
                  >
                    Clear
                  </button>
                )}
              </td>
            </Row>
          ))}
        </tbody>
      </table>
    </div>
  );
});

/**
 * A notice across New Tab while changes the devtools made are still in effect,
 * since the page then doesn't show what a regular install would.
 *
 * @param {object} props
 * @param {string[]} props.changes - see NewTabDevtoolsFeed.getDevtoolsChanges
 * @param {Function} props.dispatch
 */
export function DevtoolsChangesNotice({ changes, dispatch }) {
  const [resetting, setResetting] = React.useState(false);
  // Offered again whenever what's applied changes, in case Reset didn't
  // undo all of it.
  const changesKey = (changes ?? []).join("\n");
  React.useEffect(() => setResetting(false), [changesKey]);
  if (!changes?.length) {
    return null;
  }
  // Like the rest of the devtools, deliberately not localized: it only shows
  // with asrouter.devtoolsEnabled set.
  return (
    <moz-message-bar
      type="warning"
      // A standing state rather than an alert, which would interrupt screen
      // readers on every New Tab.
      role="status"
      class="devtools-changes-notice"
      heading="This New Tab has non-default settings"
      message={`The New Tab devtools changed: ${changes.join("; ")}.`}
    >
      <moz-button
        slot="actions"
        disabled={resetting || null}
        onClick={() => {
          setResetting(true);
          dispatch(
            ac.OnlyToMain({ type: at.DISCOVERY_STREAM_DEV_AVAILABILITY_RESET })
          );
        }}
      >
        Reset to default
      </moz-button>
    </moz-message-bar>
  );
}

export class DiscoveryStreamAdminUI extends React.PureComponent {
  constructor(props) {
    super(props);
    this.expireCache = this.expireCache.bind(this);
    this.refreshCache = this.refreshCache.bind(this);
    this.showPlaceholder = this.showPlaceholder.bind(this);
    this.idleDaily = this.idleDaily.bind(this);
    this.systemTick = this.systemTick.bind(this);
    this.syncRemoteSettings = this.syncRemoteSettings.bind(this);
    this.onStoryToggle = this.onStoryToggle.bind(this);
    this.handleWeatherSubmit = this.handleWeatherSubmit.bind(this);
    this.handleWeatherUpdate = this.handleWeatherUpdate.bind(this);
    this.resetBlocks = this.resetBlocks.bind(this);
    this.refreshInferredPersonalization =
      this.refreshInferredPersonalization.bind(this);
    this.refreshInferredPersonalizationAndDebug =
      this.refreshInferredPersonalizationAndDebug.bind(this);
    this.refreshTopicSelectionCache =
      this.refreshTopicSelectionCache.bind(this);
    this.requestDebugFeatures = this.requestDebugFeatures.bind(this);
    this.setDebugOverrides = this.setDebugOverrides.bind(this);
    this.handleDebugOverridesToggle =
      this.handleDebugOverridesToggle.bind(this);
    this.handleDebugOverrideChange = this.handleDebugOverrideChange.bind(this);
    this.handleResetAllOverrides = this.handleResetAllOverrides.bind(this);
    this.handleSectionsToggle = this.handleSectionsToggle.bind(this);
    this.handleWidgetsSystemToggle = this.handleWidgetsSystemToggle.bind(this);
    this.handleWidgetToggle = this.handleWidgetToggle.bind(this);
    this.handleWidgetsToggleAll = this.handleWidgetsToggleAll.bind(this);
    this.handleResetWidgetInteractions =
      this.handleResetWidgetInteractions.bind(this);
    this.handleResetWidgetsToDefaults =
      this.handleResetWidgetsToDefaults.bind(this);
    this.handlePageLayoutChange = this.handlePageLayoutChange.bind(this);
    this.handleResetPageLayout = this.handleResetPageLayout.bind(this);
    this.handleSpacesConfigChange = this.handleSpacesConfigChange.bind(this);
    this.handleResetSpacesConfig = this.handleResetSpacesConfig.bind(this);
    this.handleSubmitSpacesConfig = this.handleSubmitSpacesConfig.bind(this);
    this.toggleIABBanners = this.toggleIABBanners.bind(this);
    this.handleAllizomToggle = this.handleAllizomToggle.bind(this);
    this.sendConversionEvent = this.sendConversionEvent.bind(this);
    this.handleAvailabilityToggle = this.handleAvailabilityToggle.bind(this);
    this.state = {
      toggledStories: {},
      weatherQuery: "",
      pendingOverrides: {},
      overridesTogglePressed: null,
      // null means "show the pref", so an external change is picked up.
      spacesConfigDraft: null,
      availabilityOpen: false,
    };
  }

  componentDidMount() {
    this.requestDebugFeatures();
  }

  refreshCache() {
    this.props.dispatch(
      ac.OnlyToMain({
        type: at.DISCOVERY_STREAM_DEV_REFRESH_CACHE,
      })
    );
  }

  refreshInferredPersonalization() {
    this.props.dispatch(
      ac.OnlyToMain({
        type: at.INFERRED_PERSONALIZATION_REFRESH,
      })
    );
  }

  refreshInferredPersonalizationAndDebug() {
    this.refreshInferredPersonalization();
  }

  requestDebugFeatures() {
    this.props.dispatch(
      ac.OnlyToMain({
        type: at.INFERRED_PERSONALIZATION_DEBUG_FEATURES_REQUEST,
      })
    );
  }

  setDebugOverrides(overrides) {
    this.props.dispatch(
      ac.OnlyToMain({
        type: at.INFERRED_PERSONALIZATION_DEBUG_OVERRIDES_SET,
        data: overrides,
      })
    );
  }

  getDebugFeaturesList() {
    const { debugFeatures } = this.props.state.InferredPersonalization;
    if (!debugFeatures) {
      return [];
    }
    return Object.keys(debugFeatures)
      .sort()
      .filter(featureName => featureName !== "clicks")
      .map(featureName => ({
        name: featureName,
        ...debugFeatures[featureName],
      }));
  }

  getOverrideValues(features, fallbackToCurrent = false) {
    const overrides = {};
    for (const feature of features) {
      let value = feature.overrideValue;
      if (!Number.isFinite(value) && fallbackToCurrent) {
        value = Number.isFinite(feature.currentValue)
          ? feature.currentValue
          : 0;
      }
      if (Number.isFinite(value)) {
        overrides[feature.name] = value;
      }
    }
    return overrides;
  }

  handleDebugOverridesToggle(e) {
    const { pressed } = e.target;
    const features = this.getDebugFeaturesList();
    const currentOverrides = this.getOverrideValues(features, true);
    if (!pressed) {
      this.setState({
        pendingOverrides: { ...currentOverrides },
        overridesTogglePressed: false,
      });
      this.setDebugOverrides(null);
      return;
    }
    const overrides = Object.keys(this.state.pendingOverrides).length
      ? { ...this.state.pendingOverrides }
      : currentOverrides;
    this.setState({ overridesTogglePressed: true });
    this.setDebugOverrides(overrides);
  }

  handleDebugOverrideChange(featureName, value) {
    const features = this.getDebugFeaturesList();
    const overrides = Object.keys(this.state.pendingOverrides).length
      ? { ...this.state.pendingOverrides }
      : this.getOverrideValues(features, true);
    overrides[featureName] = value;
    this.setState({ pendingOverrides: { ...overrides } });
    if (Object.keys(this.getOverrideValues(features)).length) {
      this.setDebugOverrides(overrides);
    }
  }

  handleResetAllOverrides() {
    const features = this.getDebugFeaturesList();
    const overrides = Object.fromEntries(
      features.map(({ name: featureName }) => [featureName, 0])
    );
    this.setState({ pendingOverrides: { ...overrides } });
    if (Object.keys(this.getOverrideValues(features)).length) {
      this.setDebugOverrides(overrides);
    }
  }

  refreshTopicSelectionCache() {
    this.props.dispatch(
      ac.SetPref("discoverystream.topicSelection.onboarding.displayCount", 0)
    );
    this.props.dispatch(
      ac.SetPref("discoverystream.topicSelection.onboarding.maybeDisplay", true)
    );
  }

  dispatchSimpleAction(type) {
    this.props.dispatch(
      ac.OnlyToMain({
        type,
      })
    );
  }

  resetBlocks() {
    this.props.dispatch(
      ac.OnlyToMain({
        type: at.DISCOVERY_STREAM_DEV_BLOCKS_RESET,
      })
    );
  }

  systemTick() {
    this.dispatchSimpleAction(at.DISCOVERY_STREAM_DEV_SYSTEM_TICK);
  }

  expireCache() {
    this.dispatchSimpleAction(at.DISCOVERY_STREAM_DEV_EXPIRE_CACHE);
  }

  showPlaceholder() {
    this.dispatchSimpleAction(at.DISCOVERY_STREAM_DEV_SHOW_PLACEHOLDER);
  }

  idleDaily() {
    this.dispatchSimpleAction(at.DISCOVERY_STREAM_DEV_IDLE_DAILY);
  }

  syncRemoteSettings() {
    this.dispatchSimpleAction(at.DISCOVERY_STREAM_DEV_SYNC_RS);
  }

  handleWeatherUpdate(e) {
    this.setState({ weatherQuery: e.target.value || "" });
  }

  handleWeatherSubmit(e) {
    e.preventDefault();
    const { weatherQuery } = this.state;
    this.props.dispatch(ac.SetPref("weather.query", weatherQuery));
  }

  toggleIABBanners(e) {
    const { pressed, id } = e.target;

    // Set the active pref to true/false
    switch (id) {
      case "newtab_billboard":
        // Update boolean pref for billboard ad size
        this.props.dispatch(ac.SetPref(PREF_AD_SIZE_BILLBOARD, pressed));

        break;
      case "newtab_rectangle":
        // Update boolean pref for mediumRectangle (MREC) ad size
        this.props.dispatch(ac.SetPref(PREF_AD_SIZE_MEDIUM_RECTANGLE, pressed));

        break;
    }

    // Note: The counts array is passively updated whenever the placements array is updated.
    // The default pref values for each are:
    // PREF_SPOC_PLACEMENTS: "newtab_spocs"
    // PREF_SPOC_COUNTS: "6"
    const generateSpocPrefValues = () => {
      const placements =
        this.props.otherPrefs[PREF_SPOC_PLACEMENTS]?.split(",")
          .map(item => item.trim())
          .filter(item => item) || [];

      const counts =
        this.props.otherPrefs[PREF_SPOC_COUNTS]?.split(",")
          .map(item => item.trim())
          .filter(item => item) || [];

      // Confirm that the IAB type will have a count value of "1"
      const supportIABAdTypes = ["newtab_rectangle", "newtab_billboard"];
      let countValue;
      if (supportIABAdTypes.includes(id)) {
        countValue = "1"; // Default count value for all IAB ad types
      } else {
        throw new Error("IAB ad type not supported");
      }

      if (pressed) {
        // If pressed is true, add the id to the placements array
        if (!placements.includes(id)) {
          placements.push(id);
          counts.push(countValue);
        }
      } else {
        // If pressed is false, remove the id from the placements array
        const index = placements.indexOf(id);
        if (index !== -1) {
          placements.splice(index, 1);
          counts.splice(index, 1);
        }
      }

      return {
        placements: placements.join(", "),
        counts: counts.join(", "),
      };
    };

    const { placements, counts } = generateSpocPrefValues();

    // Update prefs with new values
    this.props.dispatch(ac.SetPref(PREF_SPOC_PLACEMENTS, placements));
    this.props.dispatch(ac.SetPref(PREF_SPOC_COUNTS, counts));

    // If contextual ads, sections, and one of the banners are enabled
    // update the contextualBanner prefs to include the banner value and count
    // Else, clear the prefs
    if (PREF_CONTEXTUAL_ADS_ENABLED && PREF_SECTIONS_ENABLED) {
      if (PREF_AD_SIZE_BILLBOARD && placements.includes("newtab_billboard")) {
        this.props.dispatch(
          ac.SetPref(PREF_CONTEXTUAL_BANNER_PLACEMENTS, "newtab_billboard")
        );
        this.props.dispatch(ac.SetPref(PREF_CONTEXTUAL_BANNER_COUNTS, "1"));
      } else {
        this.props.dispatch(ac.SetPref(PREF_CONTEXTUAL_BANNER_PLACEMENTS, ""));
        this.props.dispatch(ac.SetPref(PREF_CONTEXTUAL_BANNER_COUNTS, ""));
      }
    }

    // The layout is cached, so the new placements only take effect once the
    // cache is rebuilt.
    this.refreshCache();
  }

  handleSectionsToggle(e) {
    const { pressed } = e.target;
    this.props.dispatch(ac.SetPref(PREF_SECTIONS_ENABLED, pressed));
    this.props.dispatch(
      ac.SetPref("discoverystream.sections.cards.enabled", pressed)
    );
  }

  handleWidgetsSystemToggle(e) {
    this.props.dispatch(
      ac.SetPref(PREF_WIDGETS_SYSTEM_ENABLED, e.target.pressed)
    );
  }

  handleWidgetToggle(e) {
    // e.target.id is the widget's systemEnabledPref (widgets.system.<name>.enabled)
    this.props.dispatch(ac.SetPref(e.target.id, e.target.pressed));
  }

  handleWidgetsToggleAll() {
    const value = !this.areAllWidgetsEnabled();
    const values = { [PREF_WIDGETS_SYSTEM_ENABLED]: value };
    for (const widget of WIDGET_REGISTRY) {
      values[widget.systemEnabledPref] = value;
    }
    this.props.dispatch(ac.SetMultiplePrefs(values));
  }

  areAllWidgetsEnabled() {
    const { otherPrefs } = this.props;
    return Boolean(
      otherPrefs[PREF_WIDGETS_SYSTEM_ENABLED] &&
      WIDGET_REGISTRY.every(widget => otherPrefs[widget.systemEnabledPref])
    );
  }

  clearPrefs(prefNames) {
    for (const prefName of prefNames) {
      this.props.dispatch(
        ac.OnlyToMain({ type: at.CLEAR_PREF, data: { name: prefName } })
      );
    }
  }

  handleResetWidgetInteractions() {
    this.clearPrefs(
      Object.keys(this.props.otherPrefs).filter(prefName =>
        /^widgets\..+\.interaction$/.test(prefName)
      )
    );
  }

  handleResetWidgetsToDefaults() {
    this.clearPrefs(
      Object.keys(this.props.otherPrefs).filter(prefName =>
        prefName.startsWith("widgets.")
      )
    );
  }

  handlePageLayoutChange(e) {
    this.props.dispatch(ac.SetPref(PREF_PAGE_LAYOUT_VARIANT, e.target.value));
  }

  handleResetPageLayout() {
    this.clearPrefs([PREF_PAGE_LAYOUT_VARIANT]);
  }

  // Held locally and applied on submit, so typing does not reconfigure the page
  // on every keystroke.
  handleSpacesConfigChange(e) {
    this.setState({ spacesConfigDraft: e.target.value });
  }

  handleSubmitSpacesConfig() {
    const draft = this.state.spacesConfigDraft;
    let value = draft;
    try {
      // Stored compact whatever was typed. An unparseable draft is written as
      // typed, so the config's own warning explains it rather than this.
      value = JSON.stringify(JSON.parse(draft));
    } catch {}
    this.props.dispatch(ac.SetPref(PREF_SPACES_CONFIG, value));
  }

  // Clears the user value, so the pref falls back to the default this build
  // ships. Clearing the draft too, or the box would still show the old edit.
  handleResetSpacesConfig() {
    this.setState({ spacesConfigDraft: null });
    this.clearPrefs([PREF_SPACES_CONFIG]);
  }

  // The spaces config as it stands, so a recipe or a hand-edit can be checked
  // against what the page will actually do with it.
  renderSpacesConfig() {
    const prefs = this.props.otherPrefs;
    const prefValue = prefs[PREF_SPACES_CONFIG] ?? "";
    // The pref holds it compact, which is what about:config and a recipe want.
    // Indented here because this is the one place it gets read and edited.
    const draft = this.state.spacesConfigDraft ?? prettyJson(prefValue);
    const trainhopConfig = prefs.trainhopConfig?.spaces;
    const resolved = resolveThematicSpacesConfig(prefs);

    return (
      <>
        <p className="layout-status">
          Space ids, order, labels, icons, sections and widgets. Nothing is
          merged: an unusable config turns the layout off rather than
          half-applying, so a mistake here is visible.
        </p>
        <textarea
          className="spaces-config-input"
          rows="12"
          value={draft}
          onChange={this.handleSpacesConfigChange}
        />
        <moz-button
          disabled={draft === prettyJson(prefValue) ? true : null}
          onClick={this.handleSubmitSpacesConfig}
        >
          Apply config
        </moz-button>
        <moz-button onClick={this.handleResetSpacesConfig}>
          Reset to default
        </moz-button>
        {trainhopConfig && (
          <p className="layout-status layout-status-warning">
            A train-hop experiment is supplying the config, so editing here does
            nothing. See Train Hop above.
          </p>
        )}
        {!resolved && (
          <p className="layout-status layout-status-warning">
            This config cannot render: it needs an <code>order</code> array of
            ids and a <code>spaces</code> object giving each of them a label.
          </p>
        )}
      </>
    );
  }

  // Names the first isSideBySideActive gate that fails, so a variant falling back to
  // one column says why. Callers check the variant is side-by-side first.
  pageLayoutInactiveReason() {
    const prefs = this.props.otherPrefs;
    if (!prefs["feeds.section.topstories"]) {
      return "stories are turned off (feeds.section.topstories)";
    }
    if (!prefs["feeds.system.topstories"]) {
      return "stories are turned off (feeds.system.topstories)";
    }
    if (!isWidgetsContainerVisible(prefs)) {
      return "widgets are turned off (widgets.system.enabled)";
    }
    if (!hasContentAreaWidgets(prefs)) {
      return "no widgets are showing to sit beside the stories";
    }
    return null;
  }

  // Same idea for spaces, which needs two places to navigate between. Without
  // this an assigned-but-inactive spaces variant is indistinguishable from
  // today's page, since spaces adds no visible frame of its own when it falls
  // back. Callers check the variant is spaces first.
  spacesInactiveReason() {
    // Every thematic space holds the pair, so when they are empty it is the pair
    // that is missing rather than any one space's own feed.
    if (isSpacesThematicAssigned(this.props.otherPrefs)) {
      return this.pageLayoutInactiveReason();
    }
    const populated = resolvePopulatedSpaces(this.props.otherPrefs);
    if (populated.length > 1) {
      return null;
    }
    return populated.length
      ? `only the ${populated[0]} space has content, so there is nowhere to navigate to`
      : "no space has content";
  }

  renderLayouts() {
    const prefs = this.props.otherPrefs;
    // The pref, not the effective value: what the radio sets and reset clears.
    const prefVariant =
      prefs[PREF_PAGE_LAYOUT_VARIANT] || DEFAULT_PAGE_LAYOUT_VARIANT;
    const effectiveVariant = resolvePageLayoutVariant(prefs);
    const trainhopOverride = effectiveVariant !== prefVariant;
    const inactiveReason =
      (isSideBySideAssigned(prefs) && this.pageLayoutInactiveReason()) ||
      (isSpacesAssigned(prefs) && this.spacesInactiveReason());

    return (
      <>
        <div className="layout-variants">
          {Object.values(PAGE_LAYOUT_VARIANTS)
            // By pref value, not label: locale collation orders the
            // parenthesised labels' punctuation unintuitively.
            .sort((a, b) => a.localeCompare(b))
            .map(variant => (
              <label key={variant} className="layout-variant">
                <input
                  type="radio"
                  name="page-layout-variant"
                  value={variant}
                  checked={prefVariant === variant}
                  onChange={this.handlePageLayoutChange}
                />
                <span className="layout-variant-text">
                  <span className="layout-variant-name">
                    {variantLabel(variant)}
                    {variant === DEFAULT_PAGE_LAYOUT_VARIANT
                      ? " (default)"
                      : ""}
                    {/* The pref value, for a Nimbus recipe or about:config. */}
                    <code className="layout-variant-value">{variant}</code>
                  </span>
                  {PAGE_LAYOUTS_INFO[variant]?.description && (
                    <span className="layout-variant-description">
                      {PAGE_LAYOUTS_INFO[variant].description}
                    </span>
                  )}
                </span>
              </label>
            ))}
        </div>
        <moz-button
          disabled={prefVariant === DEFAULT_PAGE_LAYOUT_VARIANT ? true : null}
          onClick={this.handleResetPageLayout}
        >
          Reset layout
        </moz-button>
        {trainhopOverride && (
          <p className="layout-status layout-status-warning">
            A train-hop experiment is forcing <code>{effectiveVariant}</code>,
            so picking a layout here does nothing. See Train Hop above.
          </p>
        )}
        {inactiveReason && (
          <p className="layout-status">
            Showing as one column instead of side-by-side because{" "}
            {inactiveReason}.
          </p>
        )}
      </>
    );
  }

  sendConversionEvent() {
    const detail = {
      partnerId: "295BEEF7-1E3B-4128-B8F8-858E12AA660B",
      lookbackDays: 7,
      impressionType: "default",
    };
    const event = new CustomEvent("FirefoxConversionNotification", {
      detail,
      bubbles: true,
      composed: true,
    });
    window?.dispatchEvent(event);
  }

  renderComponent(width, component) {
    return (
      <table>
        <tbody>
          <Row>
            <td className="min">Type</td>
            <td>{component.type}</td>
          </Row>
          <Row>
            <td className="min">Width</td>
            <td>{width}</td>
          </Row>
          {component.feed && this.renderFeed(component.feed)}
        </tbody>
      </table>
    );
  }

  renderWeatherData() {
    const { suggestions } = this.props.state.Weather;
    let weatherTable;
    if (suggestions) {
      weatherTable = (
        <div className="weather-section">
          <form onSubmit={this.handleWeatherSubmit}>
            <label htmlFor="weather-query">Weather query</label>
            <input
              type="text"
              min="3"
              max="10"
              id="weather-query"
              onChange={this.handleWeatherUpdate}
              value={this.weatherQuery}
            />
            <moz-button onClick={this.handleWeatherSubmit}>Submit</moz-button>
          </form>
          <table>
            <tbody>
              {suggestions.map(suggestion => (
                <tr className="message-item" key={suggestion.city_name}>
                  <td className="message-id">
                    <span>
                      {suggestion.city_name} <br />
                    </span>
                  </td>
                  <td className="message-summary">
                    <pre>{JSON.stringify(suggestion, null, 2)}</pre>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    return weatherTable;
  }

  renderPersonalizationData() {
    const {
      inferredInterests,
      coarseInferredInterests,
      coarsePrivateInferredInterests,
    } = this.props.state.InferredPersonalization;
    const inferredPersonalizationEnabled = Boolean(
      this.props.otherPrefs?.[
        "discoverystream.sections.personalization.inferred.enabled"
      ]
    );
    const hasModelData =
      inferredInterests !== undefined ||
      coarseInferredInterests !== undefined ||
      coarsePrivateInferredInterests !== undefined;
    if (!inferredPersonalizationEnabled || !hasModelData) {
      return null;
    }
    return (
      <div className="personalization-data">
        {this.renderInferredPersonalizationOverrides()}
        <div className="inferred-vectors-row">
          <div className="inferred-vector-column">
            <div className="inferred-vector-title">Raw Interest Values</div>
            <div className="inferred-vector-panel">
              <pre>{JSON.stringify(inferredInterests, null, 2)}</pre>
            </div>
          </div>
          <div className="inferred-vector-column">
            <div className="inferred-vector-title">
              Differentially Private Interest Vector{" "}
            </div>
            <div className="inferred-vector-panel">
              <pre>
                {JSON.stringify(coarsePrivateInferredInterests, null, 2)}
              </pre>
            </div>
          </div>
        </div>
      </div>
    );
  }

  renderInferredPersonalizationOverrides() {
    const { lastUpdated } = this.props.state.InferredPersonalization;
    const features = this.getDebugFeaturesList();
    if (!features.length) {
      return null;
    }
    const overrides = this.getOverrideValues(features);
    const storeOverridesEnabled = !!Object.keys(overrides).length;
    const overridesEnabled =
      this.state.overridesTogglePressed !== null
        ? this.state.overridesTogglePressed
        : storeOverridesEnabled;
    const hasAnyNonZeroOverride = Object.values(overrides).some(
      value => Number.isFinite(value) && value > 0
    );
    return (
      <>
        <div className="inferred-overrides-header">
          <h3 className="inferred-overrides-title">Inferred Personalization</h3>
          <div className="inferred-overrides-actions">
            <moz-button onClick={this.refreshInferredPersonalizationAndDebug}>
              Recompute Interest Vector
            </moz-button>
            <moz-button onClick={this.refreshCache}>
              Refresh Story Cache
            </moz-button>
          </div>
        </div>
        <div className="inferred-overrides-last-refreshed">
          <span className="inferred-overrides-last-refreshed-label">
            Last refreshed
          </span>
          <span>{relativeTime(lastUpdated) || "(no data)"}</span>
        </div>
        <table className="minimal-table inferred-personalization-overrides">
          <tbody>
            <Row className="inferred-overrides-toggle-row">
              <td className="min">Overrides</td>
              <td className="min inferred-score-col" />
              <td>
                <div className="toggle-wrapper">
                  <moz-toggle
                    id="inferred-personalization-overrides"
                    pressed={overridesEnabled || null}
                    ontoggle={this.handleDebugOverridesToggle}
                    label="Enable overrides"
                  />
                </div>
              </td>
            </Row>
            <Row className="inferred-overrides-refresh-row">
              <td colSpan="3">
                <moz-button
                  disabled={hasAnyNonZeroOverride ? null : true}
                  onClick={this.handleResetAllOverrides}
                >
                  Reset overrides
                </moz-button>
              </td>
            </Row>
            <Row className="inferred-overrides-table-header">
              <td />
              <td className="min inferred-score-col">Score</td>
              <td />
            </Row>
            {features.map(feature => {
              const maxValue = Math.max(0, (feature.numValues || 1) - 1);
              const currentCoarseValue = feature.currentValue;
              const pendingValue = this.state.pendingOverrides[feature.name];
              let displayValue = 0;

              if (Number.isFinite(pendingValue)) {
                displayValue = pendingValue;
              } else if (Number.isFinite(feature.overrideValue)) {
                displayValue = feature.overrideValue;
              } else if (Number.isFinite(feature.currentValue)) {
                displayValue = feature.currentValue;
              }

              return (
                <Row key={feature.name} className="inferred-override-row">
                  <td className="min">{feature.name}</td>
                  <td className="min inferred-score-col">
                    {Number.isFinite(currentCoarseValue)
                      ? currentCoarseValue
                      : "-"}
                  </td>
                  <td>
                    <div className="inferred-override-controls">
                      <input
                        className="inferred-override-slider"
                        type="range"
                        min="0"
                        max={String(maxValue)}
                        step="1"
                        value={String(displayValue)}
                        disabled={!overridesEnabled}
                        aria-label={`${feature.name} override`}
                        onChange={e =>
                          this.handleDebugOverrideChange(
                            feature.name,
                            Number(e.target.value)
                          )
                        }
                      />
                      <span className="inferred-override-value">
                        {displayValue}
                      </span>
                    </div>
                  </td>
                </Row>
              );
            })}
          </tbody>
        </table>
      </>
    );
  }

  renderFeedData(url) {
    const { feeds } = this.props.state.DiscoveryStream;
    const feed = feeds.data[url].data;
    return (
      <React.Fragment>
        <h4>Feed url: {url}</h4>
        <table>
          <tbody>
            {feed.recommendations?.map(story => this.renderStoryData(story))}
          </tbody>
        </table>
      </React.Fragment>
    );
  }

  handleAvailabilityToggle(e) {
    this.setState({ availabilityOpen: e.target.open });
    // Only read the Nimbus recipes once the section is opened.
    if (e.target.open && !this.props.state.DiscoveryStream.availability) {
      this.props.dispatch(
        ac.OnlyToMain({ type: at.DISCOVERY_STREAM_DEV_AVAILABILITY_REQUEST })
      );
    }
  }

  renderTrainhop() {
    const {
      trainhopConfig = {},
      trainhopVersion,
      nimbusDebug,
    } = this.props.otherPrefs;
    return (
      <>
        <table className="minimal-table trainhop-info">
          <tbody>
            <Row>
              <td className="min">Installed version</td>
              <td>{trainhopVersion ?? "unknown"}</td>
            </Row>
            <Row>
              <td className="min">nimbus.debug</td>
              <td>{nimbusDebug ? "true" : "false"}</td>
            </Row>
          </tbody>
        </table>
        <p>
          Manage the experiments and rollouts that populate this config in{" "}
          <a target="_blank" rel="noopener noreferrer" href="about:studies">
            about:studies
          </a>
          , or install the{" "}
          <a
            target="_blank"
            rel="noopener noreferrer"
            href="https://github.com/mozilla-extensions/nimbus-devtools/releases"
          >
            Nimbus devtools extension
          </a>
          .
        </p>
        {Object.keys(trainhopConfig || {}).length ? (
          <pre className="trainhop-config">
            {JSON.stringify(trainhopConfig, null, 2)}
          </pre>
        ) : (
          <p className="trainhop-empty">
            No train-hop config. This build isn&apos;t enrolled in any
            newtabTrainhop experiment or rollout.
          </p>
        )}
      </>
    );
  }

  renderFeedsData() {
    const { feeds } = this.props.state.DiscoveryStream;
    return (
      <React.Fragment>
        {Object.keys(feeds.data).map(url => this.renderFeedData(url))}
      </React.Fragment>
    );
  }

  renderImpressionsData() {
    const { impressions } = this.props.state.DiscoveryStream;
    return (
      <>
        <h4>Feed Impressions</h4>
        <table>
          <tbody>
            {Object.keys(impressions.feed).map(key => {
              return (
                <Row key={key}>
                  <td className="min">{key}</td>
                  <td>{relativeTime(impressions.feed[key]) || "(no data)"}</td>
                </Row>
              );
            })}
          </tbody>
        </table>
      </>
    );
  }

  renderBlocksData() {
    const { blocks } = this.props.state.DiscoveryStream;
    return (
      <>
        <h4>Blocks</h4>
        <moz-button onClick={this.resetBlocks}>Reset Blocks</moz-button>{" "}
        <table>
          <tbody>
            {Object.keys(blocks).map(key => {
              return (
                <Row key={key}>
                  <td className="min">{key}</td>
                </Row>
              );
            })}
          </tbody>
        </table>
      </>
    );
  }

  handleAllizomToggle(e) {
    const prefs = this.props.otherPrefs;
    const unifiedAdsSpocsEnabled = prefs[PREF_UNIFIED_ADS_ENABLED];
    if (!unifiedAdsSpocsEnabled) {
      return;
    }
    const { pressed } = e.target;
    const { dispatch } = this.props;
    const allowedEndpoints = prefs[PREF_ALLOWED_ENDPOINTS];
    const setPref = (pref = "", value = "") => {
      dispatch(ac.SetPref(pref, value));
    };
    const clearPref = (pref = "") => {
      dispatch(
        ac.OnlyToMain({
          type: at.CLEAR_PREF,
          data: {
            name: pref,
          },
        })
      );
    };
    if (pressed) {
      setPref(PREF_UNIFIED_ADS_ENDPOINT, "https://ads.allizom.org/");
      setPref(
        PREF_ALLOWED_ENDPOINTS,
        `${allowedEndpoints},https://ads.allizom.org/`
      );
      setPref(
        PREF_OHTTP_CONFIG,
        "https://stage.ohttp-gateway.nonprod.webservices.mozgcp.net/ohttp-configs"
      );
      setPref(
        PREF_OHTTP_RELAY,
        "https://mozilla-ohttp-relay-test.edgecompute.app/"
      );
    } else {
      clearPref(PREF_UNIFIED_ADS_ENDPOINT);
      clearPref(PREF_ALLOWED_ENDPOINTS);
      clearPref(PREF_OHTTP_CONFIG);
      clearPref(PREF_OHTTP_RELAY);
    }
  }

  renderSpocs() {
    const { spocs } = this.props.state.DiscoveryStream;

    const unifiedAdsSpocsEnabled =
      this.props.otherPrefs[PREF_UNIFIED_ADS_ENABLED];

    // Determine which mechanism is querying the UAPI ads server
    const PREF_UNIFIED_ADS_ADSFEED_ENABLED = "unifiedAds.adsFeed.enabled";
    const adsFeedEnabled =
      this.props.otherPrefs[PREF_UNIFIED_ADS_ADSFEED_ENABLED];

    const PREF_UNIFIED_ADS_ADSCLIENT_ENABLED = "unifiedAds.adsClient.enabled";
    const adsClientEnabled =
      this.props.otherPrefs[PREF_UNIFIED_ADS_ADSCLIENT_ENABLED];

    const unifiedAdsEndpoint = this.props.otherPrefs[PREF_UNIFIED_ADS_ENDPOINT];
    const spocsEndpoint = unifiedAdsSpocsEnabled
      ? unifiedAdsEndpoint
      : spocs.spocs_endpoint;

    let spocsData = [];
    let allizomEnabled = spocsEndpoint?.includes("allizom");

    if (
      spocs.data &&
      spocs.data.newtab_spocs &&
      spocs.data.newtab_spocs.items
    ) {
      spocsData = spocs.data.newtab_spocs.items || [];
    }

    return (
      <React.Fragment>
        <table>
          <tbody>
            <Row>
              <td colSpan="2">
                <moz-toggle
                  id="sections-toggle"
                  disabled={!unifiedAdsSpocsEnabled || null}
                  pressed={allizomEnabled || null}
                  ontoggle={this.handleAllizomToggle}
                  label="Toggle allizom"
                />
              </td>
            </Row>
            <Row>
              <td className="min">MAC enabled</td>
              <td>{adsClientEnabled ? "true" : "false"}</td>
            </Row>
            <Row>
              <td className="min">adsfeed enabled</td>
              <td>{adsFeedEnabled ? "true" : "false"}</td>
            </Row>
            <Row>
              <td className="min">spocs endpoint</td>
              <td>{spocsEndpoint}</td>
            </Row>
            <Row>
              <td className="min">Data last fetched</td>
              <td>{relativeTime(spocs.lastUpdated)}</td>
            </Row>
          </tbody>
        </table>
        <moz-button
          style={{ marginBlockStart: "var(--space-large)" }}
          onClick={this.sendConversionEvent}
        >
          Send conversion event
        </moz-button>
        <h4>Spoc data</h4>
        <table>
          <tbody>{spocsData.map(spoc => this.renderStoryData(spoc))}</tbody>
        </table>
        <h4>Spoc frequency caps</h4>
        <table>
          <tbody>
            {spocs.frequency_caps.map(spoc => this.renderStoryData(spoc))}
          </tbody>
        </table>
      </React.Fragment>
    );
  }

  onStoryToggle(story) {
    const { toggledStories } = this.state;
    this.setState({
      toggledStories: {
        ...toggledStories,
        [story.id]: !toggledStories[story.id],
      },
    });
  }

  renderStoryData(story) {
    let storyData = "";
    if (this.state.toggledStories[story.id]) {
      storyData = JSON.stringify(story, null, 2);
    }
    return (
      <tr className="message-item" key={story.id}>
        <td className="message-id">
          <span>
            {story.id} <br />
          </span>
          <ToggleStoryButton story={story} onClick={this.onStoryToggle} />
        </td>
        <td className="message-summary">
          <pre>{storyData}</pre>
        </td>
      </tr>
    );
  }

  renderFeed(feed) {
    const { feeds } = this.props.state.DiscoveryStream;
    if (!feed.url) {
      return null;
    }
    return (
      <React.Fragment>
        <Row>
          <td className="min">Feed url</td>
          <td>{feed.url}</td>
        </Row>
        <Row>
          <td className="min">Data last fetched</td>
          <td>
            {relativeTime(
              feeds.data[feed.url] ? feeds.data[feed.url].lastUpdated : null
            ) || "(no data)"}
          </td>
        </Row>
      </React.Fragment>
    );
  }

  render() {
    const { layout } = this.props.state.DiscoveryStream;
    const sectionsEnabled = this.props.otherPrefs[PREF_SECTIONS_ENABLED];

    // Prefs for IAB Banners
    const mediumRectangleEnabled =
      this.props.otherPrefs[PREF_AD_SIZE_MEDIUM_RECTANGLE];
    const billboardsEnabled = this.props.otherPrefs[PREF_AD_SIZE_BILLBOARD];
    const spocPlacements = this.props.otherPrefs[PREF_SPOC_PLACEMENTS];
    const mediumRectangleEnabledPressed =
      mediumRectangleEnabled && spocPlacements.includes("newtab_rectangle");
    const billboardPressed =
      billboardsEnabled && spocPlacements.includes("newtab_billboard");

    const widgetsSystemEnabled =
      this.props.otherPrefs[PREF_WIDGETS_SYSTEM_ENABLED];

    return (
      <div>
        <div className="admin-button-row">
          <moz-button onClick={this.refreshCache}>Refresh Cache</moz-button>
          <moz-button onClick={this.expireCache}>Expire Cache</moz-button>
          <moz-button onClick={this.systemTick}>Trigger System Tick</moz-button>
          <moz-button onClick={this.idleDaily}>Trigger Idle Daily</moz-button>
          <moz-button onClick={this.syncRemoteSettings}>
            Sync Remote Settings
          </moz-button>
          <moz-button onClick={this.refreshTopicSelectionCache}>
            Refresh Topic selection count
          </moz-button>
          <moz-button onClick={this.showPlaceholder}>
            Show Placeholder Cards
          </moz-button>
        </div>
        <div className="toggle-wrapper">
          <moz-toggle
            id="sections-toggle"
            pressed={sectionsEnabled || null}
            ontoggle={this.handleSectionsToggle}
            label="Toggle DS Sections"
          />
        </div>
        {/* Collapsible Sections for experiments for easy on/off */}
        <details className="details-section">
          <summary>Train Hop</summary>
          {this.renderTrainhop()}
        </details>
        <details
          className="details-section"
          onToggle={this.handleAvailabilityToggle}
        >
          <summary>Feature availability</summary>
          {/* Mounted only while open, so nothing is requested until then. */}
          {this.state.availabilityOpen ? (
            <FeatureAvailability
              availability={this.props.state.DiscoveryStream.availability}
              devtoolsChanges={this.props.state.DiscoveryStream.devtoolsChanges}
              dispatch={this.props.dispatch}
            />
          ) : null}
        </details>
        <details className="details-section">
          <summary>Page Layouts (experimental)</summary>
          {this.renderLayouts()}
        </details>
        {isSpacesThematicAssigned(this.props.otherPrefs) && (
          <details className="details-section">
            <summary>Thematic spaces config</summary>
            {this.renderSpacesConfig()}
          </details>
        )}
        <details className="details-section">
          <summary>IAB Banner Ad Sizes</summary>
          <div className="toggle-wrapper">
            <moz-toggle
              id="newtab_billboard"
              pressed={billboardPressed || null}
              ontoggle={this.toggleIABBanners}
              label="Enable IAB Billboard"
            />
          </div>
          <div className="toggle-wrapper">
            <moz-toggle
              id="newtab_rectangle"
              pressed={mediumRectangleEnabledPressed || null}
              ontoggle={this.toggleIABBanners}
              label="Enable IAB Medium Rectangle (MREC)"
            />
          </div>
        </details>
        <details className="details-section">
          <summary>Widgets</summary>
          <div className="toggle-wrapper">
            <moz-toggle
              id="widgets-system-enabled"
              pressed={widgetsSystemEnabled || null}
              ontoggle={this.handleWidgetsSystemToggle}
              label="Enable widget system"
            />
          </div>
          <div className="admin-button-row">
            <moz-button onClick={this.handleWidgetsToggleAll}>
              {this.areAllWidgetsEnabled() ? "Disable all" : "Enable all"}
            </moz-button>
            <moz-button onClick={this.handleResetWidgetInteractions}>
              Reset interaction
            </moz-button>
            <moz-button
              type="destructive"
              onClick={this.handleResetWidgetsToDefaults}
            >
              Reset to defaults
            </moz-button>
          </div>
          <hr />
          <WidgetSystemToggles
            otherPrefs={this.props.otherPrefs}
            widgetsSystemEnabled={widgetsSystemEnabled}
            onToggle={this.handleWidgetToggle}
          />
          <WidgetVisibility
            prefs={this.props.otherPrefs}
            state={{
              discoveryStreamEnabled:
                !!this.props.state.DiscoveryStream.config?.enabled,
              weatherInitialized: this.props.state.Weather?.initialized,
            }}
          />
        </details>
        <h3>Layout</h3>
        {layout.map((row, rowIndex) => (
          <div key={`row-${rowIndex}`}>
            {row.components.map((component, componentIndex) => (
              <div key={`component-${componentIndex}`} className="ds-component">
                {this.renderComponent(row.width, component)}
              </div>
            ))}
          </div>
        ))}
        <h3>Spocs</h3>
        {this.renderSpocs()}
        <h3>Feeds Data</h3>
        <div className="large-data-container">{this.renderFeedsData()}</div>
        <h3>Impressions Data</h3>
        <div className="large-data-container">
          {this.renderImpressionsData()}
        </div>
        <h3>Blocked Data</h3>
        <div className="large-data-container">{this.renderBlocksData()}</div>
        <h3>Weather Data</h3>
        {this.renderWeatherData()}
        {this.renderPersonalizationData()}
      </div>
    );
  }
}

export class DiscoveryStreamAdminInner extends React.PureComponent {
  constructor(props) {
    super(props);
    this.setState = this.setState.bind(this);
    this.dismiss = this.dismiss.bind(this);
    this.handleKeyDown = this.handleKeyDown.bind(this);
    this.trackingDispatch = this.trackingDispatch.bind(this);
  }

  /**
   * Dispatches like the store, and records which prefs the pane writes so
   * that its changes can be listed and reset later.
   *
   * @param {object} action
   */
  trackingDispatch(action) {
    this.props.dispatch(action);
    let names;
    if (action.type === at.SET_PREF) {
      names = [action.data.name];
    } else if (action.type === at.SET_MULTIPLE_PREFS) {
      names = Object.keys(action.data.values ?? {});
    }
    if (names?.length) {
      this.props.dispatch(
        ac.OnlyToMain({
          type: at.DISCOVERY_STREAM_DEV_TRACK_PREFS,
          data: { names },
        })
      );
    }
  }

  componentDidMount() {
    globalThis.addEventListener("keydown", this.handleKeyDown);
  }

  componentWillUnmount() {
    globalThis.removeEventListener("keydown", this.handleKeyDown);
  }

  dismiss() {
    globalThis.location.hash = "";
  }

  handleKeyDown(e) {
    if (e.key !== "Escape" || e.defaultPrevented) {
      return;
    }
    // Don't hijack Escape while the user is typing in a field.
    const tag = e.target?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") {
      return;
    }
    this.dismiss();
  }

  render() {
    return (
      <div
        className={`discoverystream-admin ${
          this.props.collapsed ? "collapsed" : "expanded"
        }`}
      >
        <moz-button
          className="discoverystream-admin-close"
          type="icon ghost"
          title="Close devtools"
          aria-label="Close devtools"
          iconsrc="chrome://global/skin/icons/close.svg"
          onClick={this.dismiss}
        />
        <main className="main-panel">
          <h1>Discovery Stream Admin</h1>

          <p className="helpLink">
            <span className="icon icon-small-spacer icon-info" />{" "}
            <span>
              Need to access the ASRouter Admin dev tools?{" "}
              <a target="blank" href="about:asrouter">
                Click here
              </a>
            </span>
          </p>

          <React.Fragment>
            <DiscoveryStreamAdminUI
              state={{
                DiscoveryStream: this.props.DiscoveryStream,
                Weather: this.props.Weather,
                InferredPersonalization: this.props.InferredPersonalization,
              }}
              otherPrefs={this.props.Prefs.values}
              dispatch={this.trackingDispatch}
            />
          </React.Fragment>
        </main>
      </div>
    );
  }
}

export function CollapseToggle(props) {
  const { devtoolsCollapsed } = props;
  const label = `${devtoolsCollapsed ? "Expand" : "Collapse"} devtools`;
  // @nova-cleanup(remove-conditional): Remove this novaEnabled read and the
  // ternary below in the returned JSX; always render the moz-button icon button
  // and delete the legacy classic-enabled <button> branch.
  const novaEnabled = props.Prefs?.values?.["nova.enabled"];
  const className = `discoverystream-admin-toggle ${
    devtoolsCollapsed ? "expanded" : "collapsed"
  }`;
  const onToggleClick = () => {
    globalThis.location.hash = devtoolsCollapsed ? "#devtools" : "";
  };

  return (
    <>
      {novaEnabled ? (
        <moz-button
          type="primary"
          className={className}
          title={label}
          aria-label={label}
          iconsrc="chrome://global/skin/icons/developer.svg"
          onClick={onToggleClick}
        />
      ) : (
        <button
          title={label}
          aria-label={label}
          className={`${className} classic-enabled`}
          onClick={onToggleClick}
        >
          <div>
            <img
              role="presentation"
              src="chrome://global/skin/icons/developer.svg"
            />
          </div>
        </button>
      )}
      {!devtoolsCollapsed ? (
        <DiscoveryStreamAdminInner {...props} collapsed={devtoolsCollapsed} />
      ) : null}
    </>
  );
}

const _DiscoveryStreamAdmin = props => <CollapseToggle {...props} />;

export const DiscoveryStreamAdmin = connect(state => ({
  Sections: state.Sections,
  DiscoveryStream: state.DiscoveryStream,
  InferredPersonalization: state.InferredPersonalization,
  Prefs: state.Prefs,
  Weather: state.Weather,
}))(_DiscoveryStreamAdmin);
