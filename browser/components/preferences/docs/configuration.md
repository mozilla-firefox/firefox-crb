# Configuration

The Settings UI is described by plain-object configs. A pane config lists the
groups it shows, a group config lists its controls, and a control config names
the [Setting](setting.md) it renders. Pane configs are registered with
`SettingPaneManager`, group configs with `SettingGroupManager`, and settings
with [`Preferences.addSetting`](preferences.md#registration).

Group, control, and option configs share the `SettingElementConfig` fields,
such as `id`, `l10nId`, and `controlAttrs`. The tables below include them.

## SettingPaneConfig

Panes are registered with `SettingPaneManager.registerPane`, usually through
`CONFIG_PANES` in
{searchfox}`preferences.js <browser/components/preferences/preferences.js>`.
The registered form, `SettingPaneFullConfig`, also carries an `id` set from
the registration key.

```{js:autotypedef} SettingPaneConfig
```

## SettingPaneManager

The registry that holds every registered pane config. `about:preferences`
walks it to instantiate `<setting-pane>` elements and to resolve parent
panes for sub-panes.

```{js:autofunction} SettingPaneManager.registerPane
```

```{js:autofunction} SettingPaneManager.registerPanes
```

```{js:autofunction} SettingPaneManager.get
```

```{js:autofunction} SettingPaneManager.getWithParents
```

```{js:autofunction} SettingPaneManager.isVisible
```

```{js:autofunction} SettingPaneManager.importPane
```

```{js:autofunction} friendlyPrefCategoryNameToInternalName
```

## SettingGroupConfig

Groups are registered with `SettingGroupManager.registerGroups`, keyed by the
ID a pane lists in its `groupIds`.

```{js:autotypedef} SettingGroupConfig
```

## SettingGroupManager

The registry that holds every registered group config. Groups can be
registered lazily; other code can subscribe to registrations via
`onRegister` to wire itself up when a specific group appears.

```{js:autofunction} SettingGroupManager.registerGroup
```

```{js:autofunction} SettingGroupManager.registerGroups
```

```{js:autofunction} SettingGroupManager.get
```

```{js:autofunction} SettingGroupManager.has
```

```{js:autofunction} SettingGroupManager.onRegister
```

## SettingControlConfig

Each entry in a group's `items`. Its `id` names the `Setting` the control
renders.

```{js:autotypedef} SettingControlConfig
```

`controlAttrs` keys use the [spread directive](elements.md#spread-directive)
prefixes: `?` for boolean attributes, `.` for direct properties, no prefix for
regular attributes. It can't carry `headingLevel` in any form; set
`headingLevel` at the top level of the config instead.

## SettingOptionConfig

Each entry in a control's `options`, such as a radio button in a radio group.

```{js:autotypedef} SettingOptionConfig
```

Full typedefs in
{searchfox}`setting-pane.mjs <browser/components/preferences/widgets/setting-pane/setting-pane.mjs>`,
{searchfox}`setting-group.mjs <browser/components/preferences/widgets/setting-group/setting-group.mjs>`,
{searchfox}`setting-control.mjs <browser/components/preferences/widgets/setting-control/setting-control.mjs>`,
and
{searchfox}`setting-element.mjs <browser/components/preferences/widgets/setting-element/setting-element.mjs>`.
