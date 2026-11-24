/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package mozilla.components.feature.tab.settings.migration

import androidx.datastore.core.DataMigration
import androidx.datastore.preferences.core.Preferences
import mozilla.components.feature.tab.settings.datastore.inactiveTabsEnabledKey
import mozilla.components.feature.tab.settings.datastore.tabGroupsEnabledKey

/**
 * Copies each [LegacyTabSettings] value into the data store the first time the data store is opened without it.
 * Settings the data store already holds are never overwritten, so the migration is idempotent even though the legacy
 * settings are left in place.
 *
 * @param legacySettings The [LegacyTabSettings] to copy from. A setting it reports as null was never set by the user,
 *   so it is not migrated and the repository's default settings keep applying to it.
 */
internal class LegacyTabSettingsMigration(private val legacySettings: LegacyTabSettings) : DataMigration<Preferences> {

    /**
     * Returns whether any legacy setting still needs to be copied, which is the case when the legacy settings hold a
     * value for a setting that [currentData] does not hold yet. DataStore calls this every time the data store is
     * opened, so it stays false once every legacy setting has been copied.
     *
     * @param currentData The [Preferences] currently held by the data store.
     */
    override suspend fun shouldMigrate(currentData: Preferences): Boolean = pendingValues(currentData).isNotEmpty()

    /**
     * Returns [currentData] with the legacy value added for each setting it does not hold yet. Settings it already
     * holds are left untouched.
     *
     * @param currentData The [Preferences] currently held by the data store.
     */
    override suspend fun migrate(currentData: Preferences): Preferences =
        currentData
            .toMutablePreferences()
            .apply { pendingValues(currentData).forEach { (key, value) -> this[key] = value } }
            .toPreferences()

    /**
     * Intentionally does nothing. The legacy settings are kept for a few releases so that downgrading to a version
     * without this migration keeps the user's choices.
     */
    override suspend fun cleanUp() = Unit

    /**
     * Returns the legacy value for each setting that [currentData] does not hold yet, skipping settings the user never
     * set.
     *
     * @param currentData The [Preferences] currently held by the data store.
     */
    private fun pendingValues(currentData: Preferences): Map<Preferences.Key<Boolean>, Boolean> = buildMap {
        if (!currentData.contains(tabGroupsEnabledKey)) {
            legacySettings.tabGroupsEnabled()?.let { put(tabGroupsEnabledKey, it) }
        }
        if (!currentData.contains(inactiveTabsEnabledKey)) {
            legacySettings.inactiveTabsEnabled()?.let { put(inactiveTabsEnabledKey, it) }
        }
    }
}
