# [Android Components](../../../README.md) > Feature > Tab Settings

A component for persisting tab-related user settings, such as whether the tab groups and inactive
tabs features are enabled.

`TabSettingsRepository` is the entry point. It exposes a `StateFlow` of `TabSettings` describing the
current settings and functions for updating each of them. `DefaultTabSettingsRepository` is the
DataStore-backed implementation; the data store and its keys are internal to this component so
that consumers only depend on the repository abstraction.

Updates are applied to the `StateFlow` immediately and persisted asynchronously, so a read that
follows a write observes the new value. If persisting a setting fails, that setting is reverted to
its last persisted value.

The `StateFlow` emits null until the settings have been read from disk. Settings the user has never
set take their value from the `TabSettings` passed as `defaultSettings`, which lets the embedding
app decide product defaults, for example from a remote feature flag.

### Setting up the dependency

Use Gradle to download the library from [maven.mozilla.org](https://maven.mozilla.org/) ([Setup repository](../../../README.md#maven-repository)):

```Groovy
implementation "org.mozilla.components:feature-tab-settings:{latest-version}"
```

### Usage

```Kotlin
val repository =
    DefaultTabSettingsRepository(
        context = applicationContext,
        scope = applicationScope,
        defaultSettings = TabSettings(tabGroupsEnabled = true, inactiveTabsEnabled = true),
    )

// Starts reading the persisted settings. Subsequent calls are no-ops.
repository.initialize()

repository.settingsSnapshot.collect { settings ->
    // settings is null until the first read from disk completes.
}

repository.setInactiveTabsEnabled(false)
```

### Migrating from another storage mechanism

Settings persisted elsewhere before this component was adopted can be migrated in the first time
the data store is opened. Implement `LegacyTabSettings` over the old storage and have the
`Application` implement `LegacyTabSettings.Provider` to supply it:

```Kotlin
class MyApplication : Application(), LegacyTabSettings.Provider {
    override val legacyTabSettings: LegacyTabSettings
        get() = SharedPreferencesLegacyTabSettings(preferences)
}
```

Only settings the data store does not already hold are copied, so the migration is idempotent and
the legacy values can be left in place. Return null from a `LegacyTabSettings` accessor when the
user never set that setting, so that `defaultSettings` keeps applying to it.

### Testing

`FakeTabSettingsRepository` is published as a test fixture for components which depend on a
`TabSettingsRepository`:

```Groovy
testImplementation testFixtures(project(':components:feature-tab-settings'))
```

## License

    This Source Code Form is subject to the terms of the Mozilla Public
    License, v. 2.0. If a copy of the MPL was not distributed with this
    file, You can obtain one at http://mozilla.org/MPL/2.0/
