(components-preferences)=

# Settings UI

You can get to the Firefox Settings UI by navigating to `about:preferences`
in the URL bar or by clicking Settings in the Firefox menu. The entire UI is
built from a small set of Lit custom elements backed by Firefox's
preferences.

Each top-level screen in Settings (Home, Search, Privacy, ...) is rendered by
a [`<setting-pane>`](elements.md#settingpane). Each pane renders one or more
[`<setting-group>`](elements.md#settinggroup)s, and each of those groups
renders individual [`<setting-control>`](elements.md#settingcontrol)s. Each
control is backed by a [Setting](setting.md), which may in turn be backed by a
[Preference](preference.md).

```{mermaid}
flowchart TD
    pane["setting-pane<br/><small>Home, Search, Privacy, ...</small>"] -->|one or more| group["setting-group"]
    group -->|one or more| control["setting-control"]
    control -->|backed by| setting["Setting"]
    setting -.->|may be backed by| pref["Preference<br/><small>Services.prefs</small>"]

    classDef element fill:#dbe7ff,stroke:#7aa2f7,color:#1e3a8a
    classDef object fill:#d8f3dc,stroke:#74c69d,color:#1b4332
    class pane,group,control element
    class setting,pref object
```

Panes, groups, and controls are described by plain-object
[configs](configuration.md). Real-world examples of panes can be seen at
{searchfox}`browser/components/preferences/config <browser/components/preferences/config/>`.

## Definitions

| Term | Definition |
|---|---|
| preferences | Has several meanings. It can mean the preferences backend (`Services.prefs`), the preferences page (`about:preferences`), or the [`Preferences`](preferences.md) object that registers `Preference` and `Setting` objects. |
| pref | A `Services.prefs` preference. |
| setting | A user-controllable option. |
| control | The UI that users interact with to manage settings. |
| Preference | A [`Preference`](preference.md) object, backed by a pref. |
| Setting | A [`Setting`](setting.md) object, backed by a pref or some other database. Note that not all `Setting`s have a user-facing control. |
| config | The data representing UI layout and how it connects to Settings. Panes, groups, and controls each have their own [config shape](configuration.md). |

## Basic example

Here's a basic way to map a setting directly to its pref. The pref has to be
[registered](preferences.md#registration) first. The setting then maps to it,
a group lists the setting so a `setting-group` renders it, and a pane lists
the group.

```js
// First ensure the pref is registered
Preferences.add({ id: "general.autoScroll", type: "bool" });

// Map a new useAutoScroll setting directly to the general.autoScroll pref
Preferences.addSetting({
  id: "useAutoScroll",
  pref: "general.autoScroll",
});

// Show it in a group. The control defaults to a checkbox.
SettingGroupManager.registerGroups({
  browsing: {
    l10nId: "browsing-group",
    items: [{ id: "useAutoScroll", l10nId: "use-autoscroll" }],
  },
});

// Show the group on a pane.
SettingPaneManager.registerPane("tabsBrowsing", {
  l10nId: "tabs-browsing-pane-heading",
  groupIds: ["browsing"],
});
```

## Advanced example

```js
// Backed by a pref, but mapping a checkbox to an int pref
Preferences.addSetting({
  id: "useFullKeyboardNavigation",
  pref: "accessibility.tabfocus",
  visible: () => AppConstants.platform == "macosx",
  // This get function will be called any time the Setting needs to check the value.
  // Primarily it will be called on page load and it will be passed the value read from prefs.
  get(prefVal) {
    this._storedFullKeyboardNavigation = prefVal;
    return prefVal == 7;
  },
  // This set function will be called when the Setting is being changed,
  // primarily when the user has interacted with the control.
  // The first argument is the value of the control, in this case a checkbox.
  set(checked) {
    if (checked) {
      return 7;
    }
    if (this._storedFullKeyboardNavigation != 7) {
      // Restore the old value, even though it is unexpected
      return this._storedFullKeyboardNavigation;
    }
    // Expected value when the checkbox is unchecked
    return 1;
  },
});
```

## Setting lifecycle

### Setup

A setting is created when its config module calls `Preferences.addSetting`,
usually while the module loads. The new `Setting` looks up the config's
`pref`, which has to be registered first, subscribes to changes of that pref
and of the settings listed in `deps`, and calls `setup` once.

Use `setup` to listen to anything else the setting depends on. It's passed an
`emitChange` function. Call it when the external state changes so the control
re-renders, and return a function that removes the listeners again.

```js
Preferences.addSetting({
  id: "externalExample",
  setup(emitChange) {
    ExternalModule.addObserver(emitChange);
    return () => ExternalModule.removeObserver(emitChange);
  },
  get: () => ExternalModule.getCurrentValue(),
  set: val => ExternalModule.setCurrentValue(val),
});
```

### Rendering

A `setting-control` renders when the group that lists it renders, and again
each time its `Setting` emits `change`. Each render calls `get` for the
value, `visible` to decide whether to show the control, `getControlConfig` to
let the setting adjust its config, and `disabled` (along with the pref's
locked state and any controlling extension).

```{mermaid}
flowchart LR
    group["setting-group lists the setting"] --> render["setting-control renders"]
    change(["change event"]) --> render
    render --> get["get()"]
    render --> visible["visible()"]
    render --> getControlConfig["getControlConfig()"]
    render --> disabled["disabled()"]

    classDef callback fill:#d8f3dc,stroke:#74c69d,color:#1b4332
    classDef internal fill:#dbe7ff,stroke:#7aa2f7,color:#1e3a8a
    classDef neutral fill:#eef0f4,stroke:#c9ced8,color:#1f2937
    class group,render neutral
    class change internal
    class get,visible,getControlConfig,disabled callback
```

Rendering is optional. A setting that no group lists never renders, which is
fine for settings that only exist as `deps` for other settings.

### Updates

When the user changes the control, the control calls `userChange` on the
setting, which calls `set` and then `onUserChange`. For a setting with a
`pref`, the return value of `set` is written to the pref. Without a `pref`,
`set` has to store the value somewhere `get` can read it back, and the
setting has to emit `change` itself, through the `emitChange` function from
`setup` or `setting.emit("change")`.

Clicks, message bar dismissals, and reorders call `onUserClick`,
`onMessageBarDismiss`, and `onUserReorder` instead, without changing the
value.

```{mermaid}
flowchart LR
    user([User]) -->|changes the control| set["set()"]
    set --> onUserChange["onUserChange()"]
    user -.->|click, dismiss, reorder| handlers["onUserClick()<br/>onMessageBarDismiss()<br/>onUserReorder()"]
    set -->|writes the return value| pref["Preference"]
    pref -.->|change| change(["change event"])
    deps["deps Settings"] -.->|change| change
    emitChange["emitChange()"] -.-> change
    change --> render["re-renders, see Rendering"]

    classDef callback fill:#d8f3dc,stroke:#74c69d,color:#1b4332
    classDef internal fill:#dbe7ff,stroke:#7aa2f7,color:#1e3a8a
    classDef neutral fill:#eef0f4,stroke:#c9ced8,color:#1f2937
    class user,deps,render neutral
    class set,onUserChange,handlers,emitChange callback
    class pref,change internal
```

A `Setting` emits `change` on its own when its pref changes, when one of its
`deps` changes, or when its controlling extension changes. Every `change`
re-renders the control, so changes made from other pages or by other settings
show up too.

### Teardown

When the page unloads, `Preferences.onUnload` calls `destroy` on every
setting. That runs the function returned by `setup` and removes the pref and
extension listeners, so anything [`setup`](#setup) subscribed to has to be
undone in the function it returns.

## Asynchronous settings

Settings that aren't backed by `Services.prefs` may need to communicate with
an async backend to get or set the setting. This is handled by passing a
subclass of [`Preferences.AsyncSetting`](setting.md#asyncsetting) as the
setting config. It caches all values returned by its functions until it emits
a change event. At that point it calls all of its functions again to refresh
the cache, then notifies the settings infrastructure to update.

The usual `Setting` callbacks are `async` and `getControlConfig()` isn't
passed the current `config` object. Default values can be set with
`defaultValue`, `defaultDisabled`, `defaultVisible`, and
`defaultGetControlConfig`. The `beforeRefresh()` method is called after each
change, before the values are cached.

Here's an `AsyncSetting` backed by a made-up service that stores a nickname
and notifies its observers when it changes:

```js
Preferences.addSetting(
  class extends Preferences.AsyncSetting {
    static id = "nickname";
    defaultValue = "";
    setup() {
      NicknameService.addObserver(this.emitChange);
      return () => NicknameService.removeObserver(this.emitChange);
    }
    async get() {
      return NicknameService.getNickname();
    }
    async set(val) {
      await NicknameService.setNickname(val);
    }
  }
);
```

## Setting state and `this`

Use a method to reference state stored on the setting config. An arrow
function would bind `this` to the outer scope (likely `window`) rather than
the config object.

```js
Preferences.addSetting({
  id: "usesInternalState",
  pref: "need.more.state",
  _internalState: true,
  visible() {
    return this._internalState;
  },
});
```

## Adding a new settings pane

A settings pane is a distinct page in `about:preferences` with its own
navigation entry, icon, and collection of setting groups.

A new settings pane might be needed when:

- Reorganizing existing settings into a more focused category (e.g.,
  splitting Downloads from General).
- Adding a substantial new feature area that warrants its own page (e.g., AI
  Controls).

This guide covers both creating new panes and converting existing settings.

### Steps

#### 1. Create a config module

Create a new `.mjs` file in `browser/components/preferences/config/` to house
the pane's configuration and logic, then add it to
`browser/components/preferences/jar.mn`. See
[JAR Manifests](/build/buildsystem/jar-manifests.md) for more info on
`jar.mn` files.

```js
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Preferences } from "chrome://global/content/preferences/Preferences.mjs";
import { SettingGroupManager } from "chrome://browser/content/preferences/config/SettingGroupManager.mjs";

// Add any preferences that need to be tracked
Preferences.addAll([
  { id: "your.feature.enabled", type: "bool" },
]);

// Register settings with Preferences.addSetting
Preferences.addSetting({
  id: "featureEnabled",
  pref: "your.feature.enabled",
});

// Register your setting groups configuration
SettingGroupManager.registerGroups({
  yourGroupId: {
    l10nId: "your-group-fluent-id",
    headingLevel: 2,
    iconSrc: "chrome://browser/skin/your-icon.svg",
    items: [
      {
        id: "featureEnabled",
        l10nId: "feature-enabled-label",
      },
    ],
  },
});
```

This module is the central location for all configuration related to the
pane. It should:

- Use `Preferences.addAll()` to register the prefs that the pane's settings
  use or control.
- Use `Preferences.addSetting()` to configure behavior for these settings,
  like conditional visibility or dependencies on other settings. See
  [Setting lifecycle](#setting-lifecycle).
- Use `SettingGroupManager.registerGroups()` to define the UI structure with
  headings, icons, and setting items.
- Include any helper functions and event handlers specific to its settings.
- Export any functions that need to be called from legacy JavaScript files
  during migration.

#### 2. Move code from legacy files

When converting existing settings, move the relevant code from the legacy pane
file (e.g., `main.js`, `sync.js`) to the new module, then import the module so
the legacy code keeps working.

```js
// In main.js or the appropriate legacy file:
const { PaneHelpers } = ChromeUtils.importESModule(
  "chrome://browser/content/preferences/config/[pane-name].mjs",
  { global: "current" }
);
```

#### 3. Add an entry to `CONFIG_PANES`

Add an entry to the `CONFIG_PANES` object in
{searchfox}`preferences.js <browser/components/preferences/preferences.js>`.
Each entry is registered with `SettingPaneManager.registerPane`.

```js
const CONFIG_PANES = Object.freeze({
  // ... existing panes ...
  yourPane: {
    l10nId: "preferences-your-pane-header",
    iconSrc: "chrome://browser/skin/preferences/category-your-pane.svg",
    groupIds: ["groupId1", "groupId2", "groupId3"],
    module: "chrome://browser/content/preferences/config/your-pane.mjs",
    visible: () =>
      Services.prefs.getBoolPref("browser.preferences.yourPane.enabled", false),
  },
});
```

`module` should match the module created in step 1. The other fields are
listed in [SettingPaneConfig](configuration.md#settingpaneconfig).

#### 4. Add a navigation button

Add a navigation button for the new pane to `preferences.xhtml`.

```html
<html:moz-page-nav-button id="category-your-pane"
  view="paneYourPane"
  iconsrc="chrome://browser/skin/preferences/category-your-pane.svg"
  data-l10n-id="pane-your-pane-title">
</html:moz-page-nav-button>
```

The `moz-page-nav-button` creates the sidebar navigation entry. Its `view`
attribute should be `pane` followed by the pane ID in PascalCase. The button
is shown or hidden based on the `visible` function in the `CONFIG_PANES`
entry.

#### 5. Handle legacy settings migration

When converting existing settings, remove the old `<setting-group>` element
and its corresponding `initSettingGroup()` call from the legacy `.inc.xhtml`
and `.js` files.

#### 6. Add Fluent strings

Add Fluent strings for the pane's header and sidebar entry.

```ftl
## Your Pane

# This heading appears at the top of the new pane
preferences-your-pane-section =
    .heading = Your Pane Title

# This appears in the sidebar navigation entry
pane-your-pane-title = Your Pane
```

#### 7. Add telemetry

Add telemetry to track user interactions with the new pane.

Add a metric to `browser/modules/metrics.yaml`:

```yaml
browser.ui.interaction:
  preferences_pane_your_pane:
    type: labeled_counter
    description: >
      Records the items interacted with in the Your Pane section
      of preferences. See
      https://firefox-source-docs.mozilla.org/browser/BrowserUsageTelemetry.html
    bugs:
      - https://bugzil.la/XXXXXXX
    data_reviews:
      - https://bugzil.la/XXXXXXX
    notification_emails:
      - your-email@mozilla.com
      - team-email@mozilla.com
    expires: never
```

Add the pane to the `PREFERENCES_PANES` array in
`browser/modules/BrowserUsageTelemetry.sys.mjs`:

```js
const PREFERENCES_PANES = [
  // ... existing panes ...
  "paneYourPane",
];
```

Add `preferences-paneYourPane` to the `about:preferences` categories listed in
[BrowserUsageTelemetry](/browser/BrowserUsageTelemetry.md).

#### 8. Add icons and verify against mockups

Create icons for the pane, and verify that all visual elements and strings
match the mockups.

### Creating a sub-pane

A sub-pane is registered with `SettingPaneManager.registerPane` and a
`parent` set to the ID of the pane it belongs to. It's opened with
`gotoPref("yourSubPaneId")`. See the `customHomepage` sub-pane in
{searchfox}`preferences.js <browser/components/preferences/preferences.js>`
for an example.

### Testing and verification

#### Manual verification

Build Firefox and check that:

1. The navigation button appears in the sidebar (or is hidden if `visible()`
   returns false).
2. Clicking the navigation button displays the pane.
3. All settings render correctly with proper labels.
4. Settings properly update their associated prefs.
5. Icons display correctly.
6. The page header shows the correct title and description.

#### Run tests

ID or timing changes commonly cause some test failures. Run the preferences
tests locally or on try to find and fix them:

```sh
# Run preferences tests
./mach test browser/components/preferences/tests/

# Or run a specific test
./mach test browser/components/preferences/tests/browser/browser_your_feature.js

# Run the full test suite on try
./mach try auto
```

### Example conversions

These conversions are complete or in progress and can be used for reference:

- Account and Sync pane (bug 1968107)
- Accessibility pane (bug 1968116)

## API reference

```{toctree}
:maxdepth: 1

configuration
elements
preferences
preference
setting
```
