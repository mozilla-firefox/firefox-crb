/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package mozilla.components.feature.tab.settings.datastore

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import mozilla.components.feature.tab.settings.migration.LegacyTabSettings
import mozilla.components.feature.tab.settings.migration.LegacyTabSettingsMigration

/**
 * [DataStore] for persisting tab-related user settings. When the [android.app.Application] implements
 * [LegacyTabSettings.Provider], its legacy settings are migrated in the first time the store is opened.
 */
internal val Context.tabSettingsDataStore: DataStore<Preferences> by
    preferencesDataStore(
        name = "tab_settings",
        produceMigrations = { context ->
            listOfNotNull(
                (context.applicationContext as? LegacyTabSettings.Provider)
                    ?.legacyTabSettings
                    ?.let(::LegacyTabSettingsMigration)
            )
        },
    )

/** Datastore key for reading/writing whether the tab groups feature is enabled. */
internal val tabGroupsEnabledKey = booleanPreferencesKey("tabGroupsEnabledKey")

/** Datastore key for reading/writing whether the inactive tabs feature is enabled. */
internal val inactiveTabsEnabledKey = booleanPreferencesKey("inactiveTabsEnabledKey")
