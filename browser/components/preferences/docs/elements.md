# Custom elements

The Settings UI is rendered by these Lit custom elements. `about:preferences`
creates a `<setting-pane>` for each registered pane config, the pane renders
a `<setting-group>` for each of its `groupIds`, and each group renders a
`<setting-control>` for each of its `items`. Configs never reference the
elements directly, so they're internal to the Settings UI. See
[Configuration](configuration.md) for what a config can set.

## SettingPane

```{js:autoclass} SettingPane
:members:
```

## SettingGroup

```{js:autoclass} SettingGroup
:members:
```

## SettingControl

```{js:autoclass} SettingControl
:members:
```

```{js:autoclass} SettingNotDefinedError
:members:
```

## SettingElement

```{js:autoclass} SettingElement
:members:
```

### spread directive

```{js:autoclass} SpreadDirective
:members:
```

```{js:autofunction} spread
```
