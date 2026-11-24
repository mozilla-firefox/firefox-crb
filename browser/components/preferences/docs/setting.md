# Setting

`Setting` represents a setting on the preferences page. It may be backed by
the `Services.prefs` backend through a `Preference`, or it may be a custom
setting that has some other backend. The `Setting` object handles the
interaction with the backend either way, and the `setting-group` and
`setting-control` elements update the UI to match the current value.

Instances are created by `Preferences.addSetting` from a
[SettingConfig](#settingconfig) or an [AsyncSetting](#asyncsetting)
subclass, and a `setting-control` renders the matching `Setting` for its
config `id`.

## Setting class

```{js:autoclass} Setting
:members:
```

## SettingConfig

The object passed to `Preferences.addSetting`.

```{js:autotypedef} SettingConfig
```

Every callback is passed `deps` and the `Setting` object as its last two
arguments. `deps` holds the settings listed in the config's `deps`, keyed by
their ID.

## SettingControllingExtensionInfo

The shape of a setting's `controllingExtensionInfo`. Setting it declares that
the setting can be controlled by an extension, if a relevant extension is
registered in the Extension Settings Store. A config supplies `storeId`,
`l10nId`, `allowControl`, and `supportPage`; the `Setting` fills in the rest
from the store.

```{js:autotypedef} SettingControllingExtensionInfo
```

Full typedefs in
{searchfox}`Setting.mjs <toolkit/content/preferences/Setting.mjs>`.

## AsyncSetting

`AsyncSetting` is the base class for settings with an asynchronous backend.
A subclass is passed to `Preferences.addSetting` in place of a plain
`SettingConfig`, and its results are cached until it emits `change`.

```{js:autoclass} AsyncSetting
:members:
```

Full source in
{searchfox}`AsyncSetting.mjs <toolkit/content/preferences/AsyncSetting.mjs>`.
