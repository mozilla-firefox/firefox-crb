/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package mozilla.components.feature.tab.settings.migration

import androidx.datastore.preferences.core.emptyPreferences
import androidx.datastore.preferences.core.preferencesOf
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlinx.coroutines.test.runTest
import mozilla.components.feature.tab.settings.datastore.inactiveTabsEnabledKey
import mozilla.components.feature.tab.settings.datastore.tabGroupsEnabledKey

class LegacyTabSettingsMigrationTest {

    @Test
    fun `GIVEN both legacy settings exist and the data store is empty THEN both are migrated`() = runTest {
        val migration = createMigration(tabGroupsEnabled = false, inactiveTabsEnabled = false)

        assertTrue(migration.shouldMigrate(emptyPreferences()))
        assertEquals(
            expected = preferencesOf(tabGroupsEnabledKey to false, inactiveTabsEnabledKey to false),
            actual = migration.migrate(emptyPreferences()),
        )
    }

    @Test
    fun `GIVEN no legacy settings exist THEN nothing is migrated`() = runTest {
        val migration = createMigration(tabGroupsEnabled = null, inactiveTabsEnabled = null)

        assertFalse(migration.shouldMigrate(emptyPreferences()))
        assertEquals(expected = emptyPreferences(), actual = migration.migrate(emptyPreferences()))
    }

    @Test
    fun `GIVEN only one legacy setting exists THEN only that setting is migrated`() = runTest {
        val migration = createMigration(tabGroupsEnabled = null, inactiveTabsEnabled = false)

        assertTrue(migration.shouldMigrate(emptyPreferences()))
        assertEquals(
            expected = preferencesOf(inactiveTabsEnabledKey to false),
            actual = migration.migrate(emptyPreferences()),
        )
    }

    @Test
    fun `GIVEN the data store already holds a setting THEN the legacy value for it is not applied`() = runTest {
        val migration = createMigration(tabGroupsEnabled = false, inactiveTabsEnabled = false)
        val currentData = preferencesOf(tabGroupsEnabledKey to true)

        assertTrue(migration.shouldMigrate(currentData))
        assertEquals(
            expected = preferencesOf(tabGroupsEnabledKey to true, inactiveTabsEnabledKey to false),
            actual = migration.migrate(currentData),
        )
    }

    @Test
    fun `GIVEN the data store already holds every legacy setting THEN the migration does not run`() = runTest {
        val migration = createMigration(tabGroupsEnabled = false, inactiveTabsEnabled = false)
        val currentData = preferencesOf(tabGroupsEnabledKey to true, inactiveTabsEnabledKey to true)

        assertFalse(migration.shouldMigrate(currentData))
    }

    @Test
    fun `GIVEN the data store already holds every legacy setting WHEN the migration is invoked THEN the migration returns the current values`() =
        runTest {
            val migration = createMigration(tabGroupsEnabled = false, inactiveTabsEnabled = false)
            val currentData = preferencesOf(tabGroupsEnabledKey to true, inactiveTabsEnabledKey to true)

            assertEquals(currentData, migration.migrate(currentData = currentData))
        }

    @Test
    fun `WHEN the migration is cleaned up THEN the legacy settings are kept`() = runTest {
        val legacySettings = FakeLegacyTabSettings(tabGroupsEnabled = false, inactiveTabsEnabled = false)
        val migration = LegacyTabSettingsMigration(legacySettings)

        migration.migrate(emptyPreferences())
        migration.cleanUp()

        assertFalse(legacySettings.cleared)
        // confirm cleanUp() does not nuke the legacy settings until the function implemented
        assertEquals(false, legacySettings.tabGroupsEnabled())
        assertEquals(false, legacySettings.inactiveTabsEnabled())
    }

    private fun createMigration(
        tabGroupsEnabled: Boolean?,
        inactiveTabsEnabled: Boolean?,
    ) = LegacyTabSettingsMigration(FakeLegacyTabSettings(tabGroupsEnabled, inactiveTabsEnabled))

    private class FakeLegacyTabSettings(
        private val tabGroupsEnabled: Boolean?,
        private val inactiveTabsEnabled: Boolean?,
    ) : LegacyTabSettings {

        var cleared = false
            private set

        override fun tabGroupsEnabled(): Boolean? = tabGroupsEnabled

        override fun inactiveTabsEnabled(): Boolean? = inactiveTabsEnabled

        override fun clear() {
            cleared = true
        }
    }
}
