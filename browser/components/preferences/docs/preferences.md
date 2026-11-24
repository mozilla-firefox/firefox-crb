# Preferences

`Preferences` is the object that registers `Preference` and `Setting`
objects for a preferences window. `Preference`s are registered with `add` or
`addAll`, and `Setting`s with `addSetting`.

## Registration

Settings that depend on a pref require that pref to be registered before
`Preferences.addSetting` is called. Prefs are registered with `add` or
`addAll`. Most of the modules in
{searchfox}`browser/components/preferences/config <browser/components/preferences/config/>`
start by registering their prefs this way.

```{js:autofunction} Preferences.add
```

```{js:autofunction} Preferences.addAll
```

```{js:autofunction} Preferences.get
```

```{js:autofunction} Preferences.getAll
```

```{js:autofunction} Preferences.addSetting
```

```{js:autofunction} Preferences.getSetting
```

Full source in
{searchfox}`Preferences.mjs <toolkit/content/preferences/Preferences.mjs>`.
