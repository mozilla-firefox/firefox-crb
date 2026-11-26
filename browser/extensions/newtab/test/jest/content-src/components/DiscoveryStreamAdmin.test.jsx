/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { WrapWithProvider } from "test/jest/test-utils";
import {
  CollapseToggle,
  DiscoveryStreamAdminInner,
  DevtoolsChangesNotice,
  DiscoveryStreamAdminUI,
  FeatureAvailability,
  explainWidgetVisibility,
  ToggleStoryButton,
} from "content-src/components/DiscoveryStreamAdmin/DiscoveryStreamAdmin";
import { actionCreators as ac, actionTypes as at } from "common/Actions.mjs";
import {
  WIDGET_REGISTRY,
  isWidgetEnabled,
  isWidgetsContainerVisible,
} from "common/WidgetsRegistry.mjs";
import React from "react";

const CONTEXTUAL_PREFS = {
  "discoverystream.contextualContent.selectedFeed": "foo",
  "discoverystream.contextualContent.feeds": "foo, bar",
};

const getDebugFeatures = ({
  artsCurrent = 0,
  artsOverride = undefined,
  sportsCurrent = 0,
  sportsOverride = undefined,
} = {}) => ({
  arts: {
    numValues: 4,
    currentValue: artsCurrent,
    ...(artsOverride !== undefined ? { overrideValue: artsOverride } : {}),
  },
  sports: {
    numValues: 4,
    currentValue: sportsCurrent,
    ...(sportsOverride !== undefined ? { overrideValue: sportsOverride } : {}),
  },
});

const getInferredState = debugFeatures => ({
  inferredInterests: {},
  coarseInferredInterests: {},
  coarsePrivateInferredInterests: {},
  debugFeatures,
});

const getDiscoveryStreamState = () => ({
  config: { enabled: true },
  layout: [],
  spocs: { frequency_caps: [] },
  feeds: { data: {} },
  blocks: {},
  impressions: { feed: {} },
});

function renderUI({
  otherPrefs = CONTEXTUAL_PREFS,
  discoveryStream = getDiscoveryStreamState(),
  weather = { suggestions: [] },
  inferred = getInferredState(null),
} = {}) {
  const dispatch = jest.fn();
  const ref = React.createRef();
  const utils = render(
    <DiscoveryStreamAdminUI
      ref={ref}
      dispatch={dispatch}
      otherPrefs={otherPrefs}
      state={{
        DiscoveryStream: discoveryStream,
        Weather: weather,
        InferredPersonalization: inferred,
      }}
    />
  );
  return { ...utils, dispatch, instance: ref.current };
}

// Return the moz-button whose visible label matches `text`.
function buttonByText(container, text) {
  return [...container.querySelectorAll("moz-button")].find(
    node => node.textContent.trim() === text
  );
}

// Return the action of `type` dispatched to the store.
function dispatchedAction(dispatch, type) {
  return dispatch.mock.calls
    .map(([action]) => action)
    .find(a => a.type === type);
}

// Simulate moz-toggle flipping its `pressed` property and firing `toggle`.
function fireToggle(element, pressed) {
  Object.defineProperty(element, "pressed", {
    value: pressed,
    configurable: true,
  });
  fireEvent(element, new CustomEvent("toggle", { bubbles: true }));
}

describe("<CollapseToggle>", () => {
  it("should render a plain button toggle by default", () => {
    const { container } = render(
      <WrapWithProvider>
        <CollapseToggle devtoolsCollapsed={true} dispatch={jest.fn()} />
      </WrapWithProvider>
    );
    expect(
      container.querySelector("button.discoverystream-admin-toggle")
    ).toBeInTheDocument();
  });

  it("should render a moz-button toggle when Nova is enabled", () => {
    const { container } = render(
      <CollapseToggle
        devtoolsCollapsed={true}
        dispatch={jest.fn()}
        Prefs={{ values: { "nova.enabled": true } }}
      />
    );
    expect(
      container.querySelector("moz-button.discoverystream-admin-toggle")
    ).toBeInTheDocument();
    expect(
      container.querySelector("button.discoverystream-admin-toggle")
    ).not.toBeInTheDocument();
  });
});

describe("<DiscoveryStreamAdminInner>", () => {
  const innerProps = () => ({
    location: { routes: [""] },
    Prefs: { values: CONTEXTUAL_PREFS },
    DiscoveryStream: getDiscoveryStreamState(),
    Weather: { suggestions: [] },
    InferredPersonalization: getInferredState(null),
    dispatch: jest.fn(),
  });

  it("should render", () => {
    const { container } = render(
      <DiscoveryStreamAdminInner collapsed={false} {...innerProps()} />
    );
    expect(
      container.querySelector(".discoverystream-admin")
    ).toBeInTheDocument();
  });

  it("should set a .collapsed class on the outer div when collapsed", () => {
    const { container } = render(
      <DiscoveryStreamAdminInner collapsed={true} {...innerProps()} />
    );
    expect(container.querySelector(".discoverystream-admin")).toHaveClass(
      "collapsed"
    );
  });

  it("should set an .expanded class on the outer div when not collapsed", () => {
    const { container } = render(
      <DiscoveryStreamAdminInner collapsed={false} {...innerProps()} />
    );
    const admin = container.querySelector(".discoverystream-admin");
    expect(admin).toHaveClass("expanded");
    expect(admin).not.toHaveClass("collapsed");
  });

  it("should render the Discovery Stream Admin heading", () => {
    const { getByText } = render(
      <DiscoveryStreamAdminInner collapsed={false} {...innerProps()} />
    );
    expect(getByText("Discovery Stream Admin")).toBeInTheDocument();
  });

  it("should dismiss the panel from the close button", () => {
    globalThis.location.hash = "#devtools";
    const { container } = render(
      <DiscoveryStreamAdminInner collapsed={false} {...innerProps()} />
    );
    fireEvent.click(
      container.querySelector("moz-button.discoverystream-admin-close")
    );
    expect(globalThis.location.hash).toBe("");
  });

  it("should dismiss the panel when Escape is pressed", () => {
    globalThis.location.hash = "#devtools";
    render(<DiscoveryStreamAdminInner collapsed={false} {...innerProps()} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(globalThis.location.hash).toBe("");
  });

  it("should not dismiss when Escape is pressed inside an input", () => {
    globalThis.location.hash = "#devtools";
    const { container } = render(
      <DiscoveryStreamAdminInner collapsed={false} {...innerProps()} />
    );
    fireEvent.keyDown(container.querySelector("input"), { key: "Escape" });
    expect(globalThis.location.hash).toBe("#devtools");
  });
});

describe("<DiscoveryStreamAdminUI>", () => {
  it("should render the Layout section", () => {
    const { getByText } = renderUI();
    expect(getByText("Layout")).toBeInTheDocument();
  });

  it("should render an expanded spoc as JSON", () => {
    const discoveryStream = getDiscoveryStreamState();
    discoveryStream.spocs = {
      frequency_caps: [],
      data: { newtab_spocs: { items: [{ id: 12345 }] } },
    };
    const { container, instance } = renderUI({ discoveryStream });
    act(() => instance.onStoryToggle({ id: 12345 }));
    const pre = container.querySelector(".message-summary pre");
    expect(pre.textContent).toBe('{\n  "id": 12345\n}');
  });

  it("should fire refreshCache with DISCOVERY_STREAM_DEV_REFRESH_CACHE", () => {
    const { container, dispatch } = renderUI();
    fireEvent.click(buttonByText(container, "Refresh Cache"));
    expect(dispatch).toHaveBeenCalledWith(
      ac.OnlyToMain({ type: at.DISCOVERY_STREAM_DEV_REFRESH_CACHE })
    );
  });

  it("should fire expireCache with DISCOVERY_STREAM_DEV_EXPIRE_CACHE", () => {
    const { container, dispatch } = renderUI();
    fireEvent.click(buttonByText(container, "Expire Cache"));
    expect(dispatch).toHaveBeenCalledWith(
      ac.OnlyToMain({ type: at.DISCOVERY_STREAM_DEV_EXPIRE_CACHE })
    );
  });

  it("should fire systemTick with DISCOVERY_STREAM_DEV_SYSTEM_TICK", () => {
    const { container, dispatch } = renderUI();
    fireEvent.click(buttonByText(container, "Trigger System Tick"));
    expect(dispatch).toHaveBeenCalledWith(
      ac.OnlyToMain({ type: at.DISCOVERY_STREAM_DEV_SYSTEM_TICK })
    );
  });

  it("should fire idleDaily with DISCOVERY_STREAM_DEV_IDLE_DAILY", () => {
    const { container, dispatch } = renderUI();
    fireEvent.click(buttonByText(container, "Trigger Idle Daily"));
    expect(dispatch).toHaveBeenCalledWith(
      ac.OnlyToMain({ type: at.DISCOVERY_STREAM_DEV_IDLE_DAILY })
    );
  });

  it("should fire syncRemoteSettings with DISCOVERY_STREAM_DEV_SYNC_RS", () => {
    const { container, dispatch } = renderUI();
    fireEvent.click(buttonByText(container, "Sync Remote Settings"));
    expect(dispatch).toHaveBeenCalledWith(
      ac.OnlyToMain({ type: at.DISCOVERY_STREAM_DEV_SYNC_RS })
    );
  });

  describe("inferred personalization overrides controls", () => {
    const inferredPrefs = {
      ...CONTEXTUAL_PREFS,
      "discoverystream.sections.personalization.inferred.enabled": true,
    };

    const renderInferred = debugFeatures =>
      renderUI({
        otherPrefs: inferredPrefs,
        inferred: getInferredState(debugFeatures),
      });

    it('should render the "Recompute Interest Vector" button', () => {
      const { container } = renderInferred(
        getDebugFeatures({ artsCurrent: 1, artsOverride: 2 })
      );
      expect(buttonByText(container, "Recompute Interest Vector")).toBeTruthy();
    });

    it('should dispatch a refresh when "Recompute Interest Vector" is clicked', () => {
      const { container, dispatch } = renderInferred(
        getDebugFeatures({ artsCurrent: 1, artsOverride: 2 })
      );
      fireEvent.click(buttonByText(container, "Recompute Interest Vector"));
      expect(dispatch).toHaveBeenCalledWith(
        ac.OnlyToMain({ type: at.INFERRED_PERSONALIZATION_REFRESH })
      );
    });

    it('should render the "Refresh Story Cache" button', () => {
      const { container } = renderInferred(
        getDebugFeatures({ artsCurrent: 1, artsOverride: 2 })
      );
      expect(buttonByText(container, "Refresh Story Cache")).toBeTruthy();
    });

    it('should refreshCache when "Refresh Story Cache" is clicked', () => {
      const { container, dispatch } = renderInferred(
        getDebugFeatures({ artsCurrent: 1, artsOverride: 2 })
      );
      fireEvent.click(buttonByText(container, "Refresh Story Cache"));
      expect(dispatch).toHaveBeenCalledWith(
        ac.OnlyToMain({ type: at.DISCOVERY_STREAM_DEV_REFRESH_CACHE })
      );
    });

    it("should dispatch null overrides when toggle is turned off", () => {
      const { instance, dispatch } = renderInferred(
        getDebugFeatures({ artsCurrent: 1, artsOverride: 2 })
      );
      act(() =>
        instance.handleDebugOverridesToggle({ target: { pressed: false } })
      );
      expect(dispatch).toHaveBeenCalledWith(
        ac.OnlyToMain({
          type: at.INFERRED_PERSONALIZATION_DEBUG_OVERRIDES_SET,
          data: null,
        })
      );
    });

    it("should keep slider values in pendingOverrides while overrides are off", () => {
      const { instance } = renderInferred(
        getDebugFeatures({ artsCurrent: 1, artsOverride: 2 })
      );
      act(() =>
        instance.handleDebugOverridesToggle({ target: { pressed: false } })
      );
      expect(instance.state.pendingOverrides).toEqual({ arts: 2, sports: 0 });

      act(() => instance.handleDebugOverrideChange("arts", 3));
      expect(instance.state.pendingOverrides.arts).toBe(3);
    });

    it("should restore and send pending overrides when toggle is turned on", () => {
      const { instance, dispatch } = renderInferred(
        getDebugFeatures({ artsCurrent: 1, artsOverride: 2 })
      );
      act(() =>
        instance.setState({ pendingOverrides: { arts: 3, sports: 1 } })
      );
      act(() =>
        instance.handleDebugOverridesToggle({ target: { pressed: true } })
      );
      expect(dispatch).toHaveBeenCalledWith(
        ac.OnlyToMain({
          type: at.INFERRED_PERSONALIZATION_DEBUG_OVERRIDES_SET,
          data: { arts: 3, sports: 1 },
        })
      );
    });

    it("should reset pending overrides to 0 and send reset when enabled", () => {
      const { instance, dispatch } = renderInferred(
        getDebugFeatures({ artsCurrent: 1, artsOverride: 2 })
      );
      act(() =>
        instance.setState({ pendingOverrides: { arts: 3, sports: 1 } })
      );
      act(() => instance.handleResetAllOverrides());
      expect(instance.state.pendingOverrides).toEqual({ arts: 0, sports: 0 });
      expect(dispatch).toHaveBeenCalledWith(
        ac.OnlyToMain({
          type: at.INFERRED_PERSONALIZATION_DEBUG_OVERRIDES_SET,
          data: { arts: 0, sports: 0 },
        })
      );
    });

    it("should enable reset button only when at least one override is non-zero", () => {
      const disabled = renderInferred(
        getDebugFeatures({ artsCurrent: 1, artsOverride: 0, sportsOverride: 0 })
      );
      expect(
        buttonByText(disabled.container, "Reset overrides").hasAttribute(
          "disabled"
        )
      ).toBe(true);

      const enabled = renderInferred(
        getDebugFeatures({ artsCurrent: 1, artsOverride: 2, sportsOverride: 0 })
      );
      expect(
        buttonByText(enabled.container, "Reset overrides").hasAttribute(
          "disabled"
        )
      ).toBe(false);
    });
  });

  describe("IAB Banner Ad Sizes", () => {
    const IAB_PREFS = {
      ...CONTEXTUAL_PREFS,
      "discoverystream.sections.enabled": true,
      "discoverystream.sections.contextualAds.enabled": true,
      "discoverystream.placements.spocs": "newtab_spocs",
      "discoverystream.placements.spocs.counts": "6",
      "newtabAdSize.billboard": false,
      "newtabAdSize.mediumRectangle": false,
    };

    const renderIAB = (otherPrefs = {}) =>
      renderUI({ otherPrefs: { ...IAB_PREFS, ...otherPrefs } });

    it("should add the billboard placement when the toggle is turned on", () => {
      const { container, dispatch } = renderIAB();
      fireToggle(container.querySelector("#newtab_billboard"), true);
      expect(dispatch).toHaveBeenCalledWith(
        ac.SetPref("newtabAdSize.billboard", true)
      );
      expect(dispatch).toHaveBeenCalledWith(
        ac.SetPref(
          "discoverystream.placements.spocs",
          "newtab_spocs, newtab_billboard"
        )
      );
      expect(dispatch).toHaveBeenCalledWith(
        ac.SetPref("discoverystream.placements.spocs.counts", "6, 1")
      );
      expect(dispatch).toHaveBeenCalledWith(
        ac.SetPref(
          "discoverystream.placements.contextualBanners",
          "newtab_billboard"
        )
      );
      expect(dispatch).toHaveBeenCalledWith(
        ac.SetPref("discoverystream.placements.contextualBanners.counts", "1")
      );
    });

    it("should remove the billboard placement when the toggle is turned off", () => {
      const { container, dispatch } = renderIAB({
        "discoverystream.placements.spocs": "newtab_spocs, newtab_billboard",
        "discoverystream.placements.spocs.counts": "6, 1",
        "newtabAdSize.billboard": true,
      });
      fireToggle(container.querySelector("#newtab_billboard"), false);
      expect(dispatch).toHaveBeenCalledWith(
        ac.SetPref("newtabAdSize.billboard", false)
      );
      expect(dispatch).toHaveBeenCalledWith(
        ac.SetPref("discoverystream.placements.spocs", "newtab_spocs")
      );
      expect(dispatch).toHaveBeenCalledWith(
        ac.SetPref("discoverystream.placements.spocs.counts", "6")
      );
      expect(dispatch).toHaveBeenCalledWith(
        ac.SetPref("discoverystream.placements.contextualBanners", "")
      );
      expect(dispatch).toHaveBeenCalledWith(
        ac.SetPref("discoverystream.placements.contextualBanners.counts", "")
      );
    });

    it("should update the medium rectangle placement independently", () => {
      const { container, dispatch } = renderIAB({
        "discoverystream.placements.spocs": "newtab_spocs, newtab_billboard",
        "discoverystream.placements.spocs.counts": "6, 1",
        "newtabAdSize.billboard": true,
      });
      fireToggle(container.querySelector("#newtab_rectangle"), true);
      expect(dispatch).toHaveBeenCalledWith(
        ac.SetPref("newtabAdSize.mediumRectangle", true)
      );
      expect(dispatch).toHaveBeenCalledWith(
        ac.SetPref(
          "discoverystream.placements.spocs",
          "newtab_spocs, newtab_billboard, newtab_rectangle"
        )
      );
      expect(dispatch).toHaveBeenCalledWith(
        ac.SetPref(
          "discoverystream.placements.contextualBanners",
          "newtab_billboard"
        )
      );
    });

    it("should refresh the cache after an ad size changes", () => {
      const { container, dispatch } = renderIAB();
      fireToggle(container.querySelector("#newtab_billboard"), true);
      expect(dispatch).toHaveBeenCalledWith(
        ac.OnlyToMain({ type: at.DISCOVERY_STREAM_DEV_REFRESH_CACHE })
      );
    });
  });

  describe("Widgets", () => {
    const renderWidgets = (otherPrefs = { "widgets.system.enabled": false }) =>
      renderUI({ otherPrefs });

    afterEach(() => {
      delete document.l10n;
    });

    it("should flip widgets.system.enabled from the master toggle", () => {
      const { container, dispatch } = renderWidgets();
      fireToggle(container.querySelector("#widgets-system-enabled"), true);
      expect(dispatch).toHaveBeenCalledWith(
        ac.SetPref("widgets.system.enabled", true)
      );
    });

    it("should flip a widget's system pref from its toggle", () => {
      const { container, dispatch } = renderWidgets({
        "widgets.system.enabled": true,
      });
      fireToggle(
        container.querySelector('[id="widgets.system.lists.enabled"]'),
        true
      );
      expect(dispatch).toHaveBeenCalledWith(
        ac.SetPref("widgets.system.lists.enabled", true)
      );
    });

    it("should sort the toggles A-Z by their customize panel label", async () => {
      // jsdom has no document.l10n; the labels are attribute-only messages.
      const labels = {
        "newtab-custom-widget-clock-toggle": "Clock",
        "newtab-custom-widget-crossword-toggle": "Crossword",
        "newtab-custom-widget-horoscopes-toggle": "Horoscopes",
        "newtab-custom-widget-lists-toggle": "Lists",
        "newtab-custom-widget-picture-toggle": "Picture of the day",
        "newtab-custom-widget-privacy-toggle": "Privacy",
        "newtab-custom-widget-search-toggle": "Search",
        "newtab-custom-widget-solitaire-toggle": "Solitaire",
        "newtab-custom-widget-stocks-toggle2": "Finance",
        "newtab-custom-widget-timer-toggle": "Timer",
        "newtab-custom-widget-travel-toggle": "Travel",
        "newtab-custom-widget-weather-toggle": "Weather",
      };
      document.l10n = {
        formatMessages: async keys =>
          keys.map(({ id }) => ({
            attributes: [{ name: "label", value: labels[id] }],
          })),
      };

      const { container } = renderWidgets({ "widgets.system.enabled": true });
      const order = () =>
        [...container.querySelectorAll('[id^="widgets.system."]')].map(toggle =>
          toggle.getAttribute("data-l10n-id")
        );
      await waitFor(() => expect(order()).toHaveLength(12));

      // Written by hand so the test does not mirror the sort.
      expect(order()).toEqual([
        "newtab-custom-widget-clock-toggle",
        "newtab-custom-widget-crossword-toggle",
        "newtab-custom-widget-stocks-toggle2",
        "newtab-custom-widget-horoscopes-toggle",
        "newtab-custom-widget-lists-toggle",
        "newtab-custom-widget-picture-toggle",
        "newtab-custom-widget-privacy-toggle",
        "newtab-custom-widget-search-toggle",
        "newtab-custom-widget-solitaire-toggle",
        "newtab-custom-widget-timer-toggle",
        "newtab-custom-widget-travel-toggle",
        "newtab-custom-widget-weather-toggle",
      ]);
    });

    it("should disable per-widget toggles when the widget system is off", () => {
      const { container } = renderWidgets();
      expect(
        container
          .querySelector('[id="widgets.system.lists.enabled"]')
          .hasAttribute("disabled")
      ).toBe(true);
    });

    it("should enable the system and every widget from the Enable all button", () => {
      const { container, dispatch } = renderWidgets();
      fireEvent.click(buttonByText(container, "Enable all"));
      const action = dispatchedAction(dispatch, at.SET_MULTIPLE_PREFS);
      expect(action).toBeTruthy();
      expect(action.data.values["widgets.system.enabled"]).toBe(true);
      expect(action.data.values["widgets.system.lists.enabled"]).toBe(true);
    });

    it("should disable the system and every widget from the Disable all button", () => {
      const allEnabled = { "widgets.system.enabled": true };
      for (const widget of WIDGET_REGISTRY) {
        allEnabled[widget.systemEnabledPref] = true;
      }
      const { container, dispatch } = renderWidgets(allEnabled);
      fireEvent.click(buttonByText(container, "Disable all"));
      const action = dispatchedAction(dispatch, at.SET_MULTIPLE_PREFS);
      expect(action).toBeTruthy();
      expect(action.data.values["widgets.system.enabled"]).toBe(false);
      expect(action.data.values["widgets.system.lists.enabled"]).toBe(false);
    });

    // Names of prefs cleared via CLEAR_PREF actions.
    const clearedPrefs = dispatch =>
      dispatch.mock.calls
        .map(([action]) => action)
        .filter(a => a.type === at.CLEAR_PREF)
        .map(a => a.data.name);

    it("should clear every widget interaction pref from Reset interaction", () => {
      const { container, dispatch } = renderWidgets({
        "widgets.system.enabled": true,
        "widgets.lists.interaction": true,
        "widgets.crossword.interaction": true,
        "widgets.lists.enabled": true,
        "discoverystream.foo": true,
      });
      fireEvent.click(buttonByText(container, "Reset interaction"));
      expect(clearedPrefs(dispatch).sort()).toEqual([
        "widgets.crossword.interaction",
        "widgets.lists.interaction",
      ]);
    });

    it("should clear every widgets.* pref from Reset to defaults", () => {
      const { container, dispatch } = renderWidgets({
        "widgets.system.enabled": true,
        "widgets.lists.enabled": true,
        "widgets.lists.interaction": true,
        "discoverystream.foo": true,
      });
      fireEvent.click(buttonByText(container, "Reset to defaults"));
      const cleared = clearedPrefs(dispatch);
      expect(cleared.sort()).toEqual([
        "widgets.lists.enabled",
        "widgets.lists.interaction",
        "widgets.system.enabled",
      ]);
      expect(cleared).not.toContain("discoverystream.foo");
    });

    it("should flip a bespoke widget feature pref from its toggle", () => {
      const { container, dispatch } = renderWidgets({
        "widgets.system.enabled": true,
        "widgets.pictureOfTheDay.setAsWallpaper.enabled": false,
      });
      fireToggle(
        container.querySelector(
          '[id="widgets.pictureOfTheDay.setAsWallpaper.enabled"]'
        ),
        true
      );
      expect(dispatch).toHaveBeenCalledWith(
        ac.SetPref("widgets.pictureOfTheDay.setAsWallpaper.enabled", true)
      );
    });

    it("should flip the privacy VPN messages pref from its toggle", () => {
      const { container, dispatch } = renderWidgets({
        "widgets.system.enabled": true,
        "widgets.privacy.showVpnMessages": false,
      });
      fireToggle(
        container.querySelector('[id="widgets.privacy.showVpnMessages"]'),
        true
      );
      expect(dispatch).toHaveBeenCalledWith(
        ac.SetPref("widgets.privacy.showVpnMessages", true)
      );
    });
  });
});

describe("Train Hop section", () => {
  it("shows the installed version and raw trainhopConfig JSON", () => {
    const config = { widgets: { enabled: true } };
    const { container } = renderUI({
      otherPrefs: {
        ...CONTEXTUAL_PREFS,
        trainhopVersion: "156.0.0",
        trainhopConfig: config,
      },
    });
    expect(container.textContent).toContain("156.0.0");
    expect(container.querySelector("pre.trainhop-config").textContent).toBe(
      JSON.stringify(config, null, 2)
    );
  });

  it("shows an empty state instead of the config dump when config is empty", () => {
    const { container } = renderUI({
      otherPrefs: { ...CONTEXTUAL_PREFS, trainhopConfig: {} },
    });
    expect(container.querySelector("pre.trainhop-config")).toBeNull();
    expect(container.textContent).toContain("No train-hop config");
  });
});

describe("<ToggleStoryButton>", () => {
  it("should fire onClick with its story", () => {
    const onClick = jest.fn();
    const { container } = render(
      <ToggleStoryButton story="spoc" onClick={onClick} />
    );
    fireEvent.click(container.querySelector("moz-button"));
    expect(onClick).toHaveBeenCalledWith("spoc");
  });
});

describe("<DiscoveryStreamAdminUI> Layouts", () => {
  // Rendered order is alphabetical by displayed label, not declaration order.
  const VARIANTS = [
    "auto-minimize-widgets",
    "nova-full-width",
    "side-by-side-content-lead",
    "side-by-side-content-lead-five",
    "side-by-side-widgets-lead",
    "side-by-side-widgets-lead-five",
    "spaces-buttons-bottom",
    "spaces-buttons-top",
    "spaces-floating-arrows",
    "spaces-peek",
    "spaces-preview-cards",
    "spaces-preview-illustrated",
    "spaces-preview-kit",
    "spaces-thematic-v1",
    // @experiment(remove) { bug 2078816 }
    "widget-first-content-slot",
    // @experiment(remove) { bug 2069496 }
    "widgets-ad-large",
  ];
  // Everything isSideBySideActive gates on, so the status line stays quiet.
  const ACTIVE_PREFS = {
    "feeds.section.topstories": true,
    "feeds.system.topstories": true,
    "widgets.system.enabled": true,
    "widgets.enabled": true,
    "widgets.system.lists.enabled": true,
    "widgets.lists.enabled": true,
  };
  const radios = container => [
    ...container.querySelectorAll("input[name='page-layout-variant']"),
  ];

  it("renders one radio per variant with the pref value checked", () => {
    const { container } = renderUI({
      otherPrefs: { "pageLayouts.variant": "side-by-side-widgets-lead" },
    });

    expect(radios(container).map(r => r.value)).toEqual(VARIANTS);
    expect(
      radios(container)
        .filter(r => r.checked)
        .map(r => r.value)
    ).toEqual(["side-by-side-widgets-lead"]);
  });

  it("falls back to the default variant when the pref is unset", () => {
    const { container } = renderUI({ otherPrefs: {} });

    expect(radios(container).find(r => r.checked).value).toBe(
      "nova-full-width"
    );
  });

  it("sets the pref when a variant is picked", () => {
    const { container, dispatch } = renderUI({ otherPrefs: {} });

    fireEvent.click(
      radios(container).find(r => r.value === "side-by-side-content-lead-five")
    );

    const action = dispatchedAction(dispatch, at.SET_PREF);
    expect(action.data).toEqual({
      name: "pageLayouts.variant",
      value: "side-by-side-content-lead-five",
    });
  });

  it("clears the pref from the reset button", () => {
    const { container, dispatch } = renderUI({
      otherPrefs: { "pageLayouts.variant": "side-by-side-content-lead" },
    });

    const reset = buttonByText(container, "Reset layout");
    expect(reset.hasAttribute("disabled")).toBe(false);

    fireEvent.click(reset);

    expect(dispatchedAction(dispatch, at.CLEAR_PREF).data).toEqual({
      name: "pageLayouts.variant",
    });
  });

  it("disables reset while the pref is already at the default", () => {
    const { container } = renderUI({
      otherPrefs: { "pageLayouts.variant": "nova-full-width" },
    });

    expect(
      buttonByText(container, "Reset layout").hasAttribute("disabled")
    ).toBe(true);
  });

  // The pref is dead while an enrollment is in play, so the panel has to say so.
  it("warns that a train-hop enrollment overrides the pref", () => {
    const { container } = renderUI({
      otherPrefs: {
        ...ACTIVE_PREFS,
        "pageLayouts.variant": "side-by-side-content-lead",
        trainhopConfig: {
          pageLayouts: { variant: "side-by-side-widgets-lead-five" },
        },
      },
    });

    const warning = container.querySelector(".layout-status-warning");
    expect(warning).toBeInTheDocument();
    expect(warning.textContent).toContain("side-by-side-widgets-lead-five");
    // The radio still reflects the pref, which is what reset clears.
    expect(radios(container).find(r => r.checked).value).toBe(
      "side-by-side-content-lead"
    );
  });

  it("says why a side-by-side variant is not laying out", () => {
    const { container } = renderUI({
      otherPrefs: {
        ...ACTIVE_PREFS,
        "feeds.section.topstories": false,
        "pageLayouts.variant": "side-by-side-content-lead",
      },
    });

    // Assert on the pref name, not the prose, so copy edits don't break this.
    expect(container.querySelector(".layout-status").textContent).toContain(
      "feeds.section.topstories"
    );
  });

  it("stays quiet for the default variant and for a working side-by-side", () => {
    const withDefault = renderUI({ otherPrefs: ACTIVE_PREFS }).container;
    expect(withDefault.querySelector(".layout-status")).toBeNull();

    const working = renderUI({
      otherPrefs: {
        ...ACTIVE_PREFS,
        "pageLayouts.variant": "side-by-side-content-lead",
      },
    }).container;
    expect(working.querySelector(".layout-status")).toBeNull();
  });
});

describe("Feature availability section", () => {
  const AVAILABILITY = {
    region: "DE",
    locale: "de",
    channel: "release",
    version: "151.0",
    options: {
      regions: [
        { value: "DE", label: "Germany" },
        { value: "FR", label: "France" },
      ],
      locales: [{ value: "de", label: "German" }],
      presets: [
        {
          region: "DE",
          locale: "de",
          label: "Germany, German (DE, de): 9 recipes",
        },
        {
          region: "FR",
          locale: "de",
          label: "France, German (FR, de): 1 recipe",
        },
      ],
      versions: [
        { value: "151.0", label: "Release 151", channel: "release" },
        {
          value: "150.0",
          label: "Release 150 (Release -1)",
          channel: "release",
        },
        { value: "140.9.0", label: "ESR 140.9.0", channel: "esr" },
      ],
    },
    originalRegion: undefined,
    nimbusDebug: true,
    widgetsInteracted: false,
    recipes: [
      {
        slug: "de-rollout",
        isRollout: true,
        featureIds: ["newtabTrainhop"],
        bucketPercent: 100,
        targeting: "region in ['DE']",
        matches: true,
        enrolledBranch: "control",
        userFacingDescription: "Widgets for Germany",
        branches: ["control"],
        widgets: [{ branch: "control", widgets: ["lists", "crossword"] }],
        profileTargeting: ["profile age"],
      },
      {
        slug: "fr-rollout",
        isRollout: true,
        featureIds: ["newtabTrainhop"],
        bucketPercent: 100,
        targeting: "region in ['FR']",
        matches: false,
        enrolledBranch: null,
        branches: ["control"],
        widgets: [{ branch: "control", widgets: ["privacy"] }],
        profileTargeting: [],
      },
      {
        slug: "de-experiment",
        isRollout: false,
        featureIds: ["newtabTrainhop"],
        bucketPercent: 25,
        targeting: "region in ['DE']",
        matches: true,
        enrolledBranch: null,
        branches: ["control", "widgets-only"],
        widgets: [{ branch: "widgets-only", widgets: ["focusTimer"] }],
        profileTargeting: [],
      },
    ],
    prefs: [
      { name: "weather.temperatureUnits", current: "f", simulated: "c" },
      { name: "showWeather", current: true, simulated: true },
    ],
  };

  function renderAvailability(availability = AVAILABILITY) {
    const dispatch = jest.fn();
    const utils = render(
      <FeatureAvailability availability={availability} dispatch={dispatch} />
    );
    return { ...utils, dispatch };
  }

  it("requests availability only once the section is opened", () => {
    jest.useFakeTimers();
    let rendered;
    try {
      rendered = renderUI();
      // Not even the retry asks while the section is closed.
      act(() => jest.advanceTimersByTime(30000));
    } finally {
      jest.useRealTimers();
    }
    const { container, dispatch } = rendered;
    const details = [...container.querySelectorAll("details")].find(
      d => d.querySelector("summary").textContent === "Feature availability"
    );
    expect(
      dispatchedAction(dispatch, at.DISCOVERY_STREAM_DEV_AVAILABILITY_REQUEST)
    ).toBeUndefined();

    details.open = true;
    fireEvent(details, new Event("toggle"));

    expect(
      dispatchedAction(dispatch, at.DISCOVERY_STREAM_DEV_AVAILABILITY_REQUEST)
    ).toEqual(
      ac.OnlyToMain({ type: at.DISCOVERY_STREAM_DEV_AVAILABILITY_REQUEST })
    );
  });

  it("renders recipes and highlights prefs that would change", () => {
    const { container, getByLabelText } = renderAvailability();
    expect(container.textContent).toContain("de-rollout");
    expect(container.textContent).toContain("fr-rollout");
    expect(container.querySelectorAll("tr.changed")).toHaveLength(1);

    fireEvent.click(getByLabelText("Only matching"));
    expect(container.textContent).not.toContain("fr-rollout");
  });

  it("shows descriptions, widgets, profile dependencies and the widgets matching recipes enable", () => {
    const { container } = renderAvailability();
    expect(container.textContent).toContain("Widgets for Germany");
    expect(container.textContent).toContain("lists, crossword");
    expect(container.textContent).toContain(
      "Also depends on this profile's profile age"
    );
    const sources = [
      ...container.querySelectorAll(".availability-widget-sources li"),
    ].map(li => li.textContent);
    expect(sources).toEqual([
      "lists: de-rollout (rollout, 100% of clients)",
      "crossword: de-rollout (rollout, 100% of clients)",
      "focusTimer: de-experiment (experiment, 25% of clients, 1 of 2 branches: widgets-only)",
    ]);
  });

  it("sets region and locale from an audience and only shows them for Custom", () => {
    const { getByLabelText } = renderAvailability();
    const audience = getByLabelText("Audience");
    const regionRow = () =>
      getByLabelText("Region").closest(".availability-row");
    expect(audience.value).toBe("DE|de");
    expect(regionRow().hidden).toBe(true);

    fireEvent.change(audience, { target: { value: "FR|de" } });
    expect(getByLabelText("Region").value).toBe("FR");
    expect(getByLabelText("Locale").value).toBe("de");
    expect(regionRow().hidden).toBe(true);

    fireEvent.change(audience, { target: { value: "" } });
    expect(regionRow().hidden).toBe(false);
    expect(getByLabelText("Region").value).toBe("FR");
  });

  it("shows region and locale when the evaluated pair isn't an audience", () => {
    const { getByLabelText } = renderAvailability({
      ...AVAILABILITY,
      region: "JP",
      locale: "de",
      options: {
        ...AVAILABILITY.options,
        regions: [
          ...AVAILABILITY.options.regions,
          { value: "JP", label: "Japan" },
        ],
      },
    });
    expect(getByLabelText("Audience").value).toBe("");
    expect(getByLabelText("Region").closest(".availability-row").hidden).toBe(
      false
    );
  });

  it("sends whether widgets were interacted with, checked or not", () => {
    const { getByLabelText, getByText, dispatch } = renderAvailability({
      ...AVAILABILITY,
      widgetsInteracted: true,
    });
    const box = getByLabelText("Has interacted with widgets");
    expect(box.checked).toBe(true);

    fireEvent.click(box);
    fireEvent.click(getByText("Evaluate"));
    expect(
      dispatchedAction(dispatch, at.DISCOVERY_STREAM_DEV_AVAILABILITY_REQUEST)
        .data.widgetsInteracted
    ).toBe(false);
  });

  it("picks the channel that goes with a version", () => {
    const { getByLabelText } = renderAvailability();
    fireEvent.change(getByLabelText("Version"), {
      target: { value: "140.9.0" },
    });
    expect(getByLabelText("Channel").value).toBe("esr");
  });

  it("preselects the evaluated values in the dropdowns", () => {
    const { getByLabelText } = renderAvailability();
    expect(getByLabelText("Region").value).toBe("DE");
    expect(getByLabelText("Locale").value).toBe("de");
    expect(getByLabelText("Version").value).toBe("151.0");
  });

  it("disables the buttons until the answer arrives", () => {
    const dispatch = jest.fn();
    const { getByText, rerender } = render(
      <FeatureAvailability availability={AVAILABILITY} dispatch={dispatch} />
    );
    fireEvent.click(getByText("Evaluate"));
    expect(getByText("Evaluate")).toHaveAttribute("aria-disabled", "true");
    expect(getByText("Working...")).toBeInTheDocument();

    rerender(
      <FeatureAvailability
        availability={{ ...AVAILABILITY }}
        dispatch={dispatch}
      />
    );
    expect(getByText("Evaluate")).not.toHaveAttribute("aria-disabled", "true");
  });

  it("offers a retry while loading, and asks again on its own", () => {
    jest.useFakeTimers();
    try {
      const dispatch = jest.fn();
      const { getByText } = render(
        <FeatureAvailability availability={null} dispatch={dispatch} />
      );
      expect(getByText(/Loading/)).toBeInTheDocument();
      fireEvent.click(getByText("Retry"));
      // Keeps asking for as long as there's no answer.
      act(() => jest.advanceTimersByTime(16000));
      expect(
        dispatch.mock.calls.filter(
          ([a]) => a.type === at.DISCOVERY_STREAM_DEV_AVAILABILITY_REQUEST
        )
      ).toHaveLength(3);
    } finally {
      jest.useRealTimers();
    }
  });

  it("keeps focus on a button while its request is pending, and announces the result", () => {
    const dispatch = jest.fn();
    const { getByText, container, rerender } = render(
      <FeatureAvailability availability={AVAILABILITY} dispatch={dispatch} />
    );
    const status = container.querySelector("[role=status]");
    expect(status).toBeInTheDocument();
    const evaluate = getByText("Evaluate");
    evaluate.focus();
    fireEvent.click(evaluate);
    expect(evaluate.disabled).toBe(false);
    expect(evaluate).toHaveAttribute("aria-disabled", "true");
    expect(document.activeElement).toBe(evaluate);
    expect(status.textContent).toBe("Working...");
    // A second click while pending does nothing.
    fireEvent.click(evaluate);
    expect(
      dispatch.mock.calls.filter(
        ([a]) => a.type === at.DISCOVERY_STREAM_DEV_AVAILABILITY_REQUEST
      )
    ).toHaveLength(1);

    rerender(
      <FeatureAvailability
        availability={{ ...AVAILABILITY }}
        dispatch={dispatch}
      />
    );
    expect(container.querySelector("[role=status]")).toBe(status);
    expect(status.textContent).toBe("Done.");
  });

  it("names each targeting disclosure after its recipe", () => {
    const { getByText } = renderAvailability();
    expect(getByText("Targeting for de-rollout")).toBeInTheDocument();
  });

  it("doesn't keep asking after an error", () => {
    jest.useFakeTimers();
    try {
      const dispatch = jest.fn();
      render(
        <FeatureAvailability
          availability={{ error: "Error: offline" }}
          dispatch={dispatch}
        />
      );
      act(() => jest.advanceTimersByTime(30000));
      expect(dispatch).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it("shows why loading failed", () => {
    const { container } = render(
      <FeatureAvailability
        availability={{ error: "Error: no collection" }}
        dispatch={jest.fn()}
      />
    );
    expect(container.textContent).toContain(
      "Couldn't load feature availability: Error: no collection"
    );
  });

  it("shows each recipe's targeting in its own full-width row", () => {
    const { container } = renderAvailability();
    const cell = container.querySelector(
      "tr.availability-targeting-row td[colspan='7']"
    );
    expect(cell.textContent).toContain("region in ['DE']");
  });

  it("labels the widget visibility columns", () => {
    const { container } = render(
      <DiscoveryStreamAdminUI
        dispatch={jest.fn()}
        otherPrefs={CONTEXTUAL_PREFS}
        state={{
          DiscoveryStream: getDiscoveryStreamState(),
          Weather: { suggestions: [] },
          InferredPersonalization: getInferredState(null),
        }}
      />
    );
    const headers = [
      ...container.querySelectorAll(".widget-visibility thead th"),
    ].map(th => th.textContent);
    expect(headers).toEqual(["Widget", "State", "Reason"]);
  });
});

describe("explainWidgetVisibility", () => {
  it("agrees with isWidgetEnabled on which widgets show", () => {
    const states = [
      {},
      { "widgets.system.enabled": true, "widgets.enabled": true },
      {
        "widgets.system.enabled": true,
        "widgets.enabled": true,
        trainhopConfig: { widgets: { listsEnabled: true, timerEnabled: true } },
        "widgets.lists.enabled": true,
        "widgets.focusTimer.enabled": true,
      },
      {
        trainhopConfig: { widgets: { enabled: true, clocksEnabled: true } },
        "widgets.enabled": true,
        "widgets.clocks.enabled": true,
        recordsHistory: false,
      },
    ];
    for (const prefs of states) {
      for (const widget of WIDGET_REGISTRY.filter(
        w => !w.retired && w.id !== "weather"
      )) {
        expect([
          widget.id,
          explainWidgetVisibility(widget, prefs).shown,
        ]).toEqual([
          widget.id,
          isWidgetsContainerVisible(prefs) &&
            isWidgetEnabled(widget, prefs, prefs["widgets.enabled"]),
        ]);
      }
    }
  });

  const lists = WIDGET_REGISTRY.find(w => w.id === "lists");
  const weather = WIDGET_REGISTRY.find(w => w.id === "weather");
  const visiblePrefs = {
    "widgets.system.enabled": true,
    "widgets.enabled": true,
    "widgets.system.lists.enabled": true,
    "widgets.lists.enabled": true,
  };

  it("says widgets can't mount without the Discovery Stream layout", () => {
    expect(
      explainWidgetVisibility(lists, visiblePrefs, {
        discoveryStreamEnabled: false,
      }).reason
    ).toContain("discoverystream.config");
  });

  it("explains a shown widget by what made it available", () => {
    expect(explainWidgetVisibility(lists, visiblePrefs)).toEqual({
      shown: true,
      reason: "Available via widgets.system.lists.enabled",
    });
  });

  it.each([
    [{ "widgets.system.enabled": false }, "widgets container is off"],
    [{ "widgets.enabled": false }, "(widgets.enabled)"],
    [
      { "widgets.system.lists.enabled": false },
      "none of widgets.system.lists.enabled, trainhopConfig.widgets.listsEnabled",
    ],
    [{ "widgets.lists.enabled": false }, "(widgets.lists.enabled)"],
  ])("names the first check that hides it for %o", (overrides, reason) => {
    const result = explainWidgetVisibility(lists, {
      ...visiblePrefs,
      ...overrides,
    });
    expect(result.shown).toBe(false);
    expect(result.reason).toContain(reason);
  });

  it("explains a widget hidden because the profile records no history", () => {
    const privacy = WIDGET_REGISTRY.find(w => w.id === "privacy");
    expect(
      explainWidgetVisibility(privacy, {
        ...visiblePrefs,
        [privacy.systemEnabledPref]: true,
        [privacy.enabledPref]: true,
        recordsHistory: false,
      })
    ).toEqual({
      shown: false,
      reason: "Needs browsing history, which this profile doesn't record",
    });
  });

  it("checks the weather-only conditions", () => {
    const prefs = {
      ...visiblePrefs,
      "widgets.system.weather.enabled": true,
      "widgets.weather.enabled": true,
      showWeather: true,
    };
    expect(
      explainWidgetVisibility(weather, prefs, { weatherInitialized: true })
        .reason
    ).toContain("system.showWeather");
    expect(
      explainWidgetVisibility(
        weather,
        { ...prefs, "system.showWeather": true },
        { weatherInitialized: false }
      ).reason
    ).toBe("Weather data hasn't loaded");
    expect(
      explainWidgetVisibility(
        weather,
        { ...prefs, "system.showWeather": true },
        { weatherInitialized: true }
      ).shown
    ).toBe(true);
  });
});

describe("<DevtoolsChangesNotice>", () => {
  it("renders nothing without changes", () => {
    const { container } = render(
      <DevtoolsChangesNotice changes={[]} dispatch={jest.fn()} />
    );
    expect(container.firstChild).toBeNull();
  });

  it("lists the changes and resets them", () => {
    const dispatch = jest.fn();
    const { container } = render(
      <DevtoolsChangesNotice
        changes={["region DE (was US)", "2 forced enrollments"]}
        dispatch={dispatch}
      />
    );
    const bar = container.querySelector("moz-message-bar");
    // A standing state, so not an alert on every New Tab.
    expect(bar.getAttribute("role")).toBe("status");
    expect(bar.getAttribute("message")).toBe(
      "The New Tab devtools changed: region DE (was US); 2 forced enrollments."
    );
    const reset = container.querySelector("moz-button");
    fireEvent.click(reset);
    expect(dispatch).toHaveBeenCalledWith(
      ac.OnlyToMain({ type: at.DISCOVERY_STREAM_DEV_AVAILABILITY_RESET })
    );
    expect(reset).toHaveAttribute("disabled");
  });

  it("offers Reset again if the changes are still there afterwards", () => {
    const dispatch = jest.fn();
    const { container, rerender } = render(
      <DevtoolsChangesNotice
        changes={["region DE (was US)"]}
        dispatch={dispatch}
      />
    );
    fireEvent.click(container.querySelector("moz-button"));
    // Reset only managed part of it.
    rerender(
      <DevtoolsChangesNotice changes={["nimbus.debug"]} dispatch={dispatch} />
    );
    expect(container.querySelector("moz-button")).not.toHaveAttribute(
      "disabled"
    );
  });
});
