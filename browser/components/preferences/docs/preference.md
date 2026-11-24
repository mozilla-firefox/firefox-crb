# Preference

`Preference` represents a `Services.prefs` preference. Instances are created
by `Preferences.add` or `Preferences.addAll` from a
[PreferenceConfig](#preferenceconfig). A `Setting` whose config names a
`pref` reads and writes its value through the matching `Preference`.

## Preference class

```{js:autoclass} Preference
:members:
```

## PreferenceConfig

The object passed to `Preferences.add` for each pref.

```{js:autotypedef} PreferenceConfig
```

Full typedef in
{searchfox}`Preference.mjs <toolkit/content/preferences/Preference.mjs>`.
