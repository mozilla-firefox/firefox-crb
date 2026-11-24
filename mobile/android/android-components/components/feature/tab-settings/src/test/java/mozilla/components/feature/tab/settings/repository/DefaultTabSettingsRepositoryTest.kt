/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package mozilla.components.feature.tab.settings.repository

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.emptyPreferences
import androidx.datastore.preferences.core.preferencesOf
import java.io.IOException
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.emitAll
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import mozilla.components.feature.tab.settings.data.TabSettings
import mozilla.components.feature.tab.settings.datastore.inactiveTabsEnabledKey
import mozilla.components.feature.tab.settings.datastore.tabGroupsEnabledKey

@OptIn(ExperimentalCoroutinesApi::class)
class DefaultTabSettingsRepositoryTest {

    private val defaultSettings = TabSettings(tabGroupsEnabled = true, inactiveTabsEnabled = true)

    // region Initialization and reading persisted settings

    @Test
    fun `GIVEN the repository has not been initialized THEN the settings snapshot is null`() = runTest {
        val repository = createRepository(dataStore = TestPreferencesDataStore())

        runCurrent()

        assertNull(repository.settingsSnapshot.value)
    }

    @Test
    fun `GIVEN no settings have been persisted WHEN the repository is initialized THEN the settings snapshot contains the default settings`() =
        runTest {
            val repository = createRepository(dataStore = TestPreferencesDataStore())

            repository.initialize()
            runCurrent()

            assertEquals(defaultSettings, repository.settingsSnapshot.value)
        }

    @Test
    fun `GIVEN all of the settings have been persisted WHEN the repository is initialized THEN the settings snapshot contains the persisted values`() =
        runTest {
            val initialPersistedSettings = TabSettings(tabGroupsEnabled = false, inactiveTabsEnabled = false)
            val dataStore = TestPreferencesDataStore(initialSettings = initialPersistedSettings)
            val repository = createRepository(dataStore = dataStore)

            repository.initialize()
            runCurrent()

            assertEquals(initialPersistedSettings, repository.settingsSnapshot.value)
        }

    @Test
    fun `GIVEN only tab groups setting has been persisted WHEN the repository is initialized THEN the remaining settings use the default settings`() =
        runTest {
            val dataStore = TestPreferencesDataStore()
            dataStore.preferences.value = preferencesOf(tabGroupsEnabledKey to false)
            val repository = createRepository(dataStore = dataStore)

            repository.initialize()
            runCurrent()

            val expectedSettings = defaultSettings.copy(tabGroupsEnabled = false)

            assertEquals(
                expectedSettings,
                repository.settingsSnapshot.value,
            )
        }

    @Test
    fun `GIVEN only the inactive tabs setting has been persisted WHEN the repository is initialized THEN the remaining settings use the default settings`() =
        runTest {
            val dataStore = TestPreferencesDataStore()
            dataStore.preferences.value = preferencesOf(inactiveTabsEnabledKey to false)
            val repository = createRepository(dataStore = dataStore)

            repository.initialize()
            runCurrent()

            val expectedSettings = defaultSettings.copy(inactiveTabsEnabled = false)

            assertEquals(
                expectedSettings,
                repository.settingsSnapshot.value,
            )
        }

    @Test
    fun `WHEN the repository is initialized multiple times THEN the data store is only observed once`() = runTest {
        val dataStore = TestPreferencesDataStore()
        val repository = createRepository(dataStore = dataStore)

        repository.initialize()
        repository.initialize()
        runCurrent()

        assertEquals(1, dataStore.collectionCount)
    }

    @Test
    fun `GIVEN reading the data store fails WHEN the repository is initialized THEN the settings snapshot contains the default settings`() =
        runTest {
            val repository = createRepository(dataStore = TestPreferencesDataStore(failReads = true))

            repository.initialize()
            runCurrent()

            assertEquals(defaultSettings, repository.settingsSnapshot.value)
        }

    @Test
    fun `GIVEN the repository is initialized WHEN the inactive tabs setting changes THEN the settings snapshot is updated`() =
        runTest {
            val dataStore = TestPreferencesDataStore()
            val repository = createRepository(dataStore = dataStore)
            repository.initialize()
            runCurrent()

            dataStore.preferences.value = preferencesOf(inactiveTabsEnabledKey to false)
            runCurrent()

            assertEquals(
                TabSettings(tabGroupsEnabled = defaultSettings.tabGroupsEnabled, inactiveTabsEnabled = false),
                repository.settingsSnapshot.value,
            )
        }

    @Test
    fun `GIVEN the repository is initialized WHEN the tab groups setting changes THEN the settings snapshot is updated`() =
        runTest {
            val dataStore = TestPreferencesDataStore()
            val repository = createRepository(dataStore = dataStore)
            repository.initialize()
            runCurrent()

            dataStore.preferences.value = preferencesOf(tabGroupsEnabledKey to false)
            runCurrent()

            assertEquals(
                TabSettings(tabGroupsEnabled = false, inactiveTabsEnabled = defaultSettings.inactiveTabsEnabled),
                repository.settingsSnapshot.value,
            )
        }

    // endregion

    // region Updating settings

    @Test
    fun `WHEN tab groups are disabled THEN the settings snapshot is updated immediately and the setting is persisted`() =
        runTest {
            val dataStore = TestPreferencesDataStore()
            val repository = createRepository(dataStore = dataStore)
            repository.initialize()
            runCurrent()

            repository.setTabGroupsEnabled(false)

            assertEquals(false, repository.settingsSnapshot.value?.tabGroupsEnabled)
            assertNull(dataStore.preferences.value[tabGroupsEnabledKey])

            runCurrent()

            assertEquals(false, dataStore.preferences.value[tabGroupsEnabledKey])
            assertEquals(false, repository.settingsSnapshot.value?.tabGroupsEnabled)
        }

    @Test
    fun `WHEN inactive tabs are disabled THEN the settings snapshot is updated immediately and the setting is persisted`() =
        runTest {
            val dataStore = TestPreferencesDataStore()
            val repository = createRepository(dataStore = dataStore)
            repository.initialize()
            runCurrent()

            repository.setInactiveTabsEnabled(false)

            assertEquals(false, repository.settingsSnapshot.value?.inactiveTabsEnabled)
            assertNull(dataStore.preferences.value[inactiveTabsEnabledKey])

            runCurrent()

            assertEquals(false, dataStore.preferences.value[inactiveTabsEnabledKey])
            assertEquals(false, repository.settingsSnapshot.value?.inactiveTabsEnabled)
        }

    @Test
    fun `GIVEN the repository has not been initialized WHEN a setting is updated THEN it is applied to the default settings and persisted`() =
        runTest {
            val dataStore = TestPreferencesDataStore()
            val repository = createRepository(dataStore = dataStore)

            repository.setInactiveTabsEnabled(false)

            assertEquals(defaultSettings.copy(inactiveTabsEnabled = false), repository.settingsSnapshot.value)

            runCurrent()

            assertEquals(false, dataStore.preferences.value[inactiveTabsEnabledKey])
        }

    // endregion

    // region Write failures

    @Test
    fun `GIVEN writing to the data store fails WHEN a setting is updated THEN the setting is reverted to its persisted value`() =
        runTest {
            val initialPersistedSettings = TabSettings(tabGroupsEnabled = false, inactiveTabsEnabled = false)
            val dataStore = TestPreferencesDataStore(initialSettings = initialPersistedSettings, failWrites = true)
            val repository = createRepository(dataStore = dataStore)
            repository.initialize()
            runCurrent()

            repository.setTabGroupsEnabled(true)

            assertEquals(true, repository.settingsSnapshot.value?.tabGroupsEnabled)

            runCurrent()

            assertEquals(initialPersistedSettings, repository.settingsSnapshot.value)
            assertEquals(false, dataStore.preferences.value[tabGroupsEnabledKey])
        }

    @Test
    fun `GIVEN writing to the data store fails WHEN one setting is updated THEN other settings are not reverted`() =
        runTest {
            val dataStore = TestPreferencesDataStore()
            val repository = createRepository(dataStore = dataStore)
            repository.initialize()
            runCurrent()

            repository.setInactiveTabsEnabled(false)
            runCurrent()
            dataStore.failWrites = true
            repository.setTabGroupsEnabled(false)
            runCurrent()

            assertEquals(
                TabSettings(tabGroupsEnabled = defaultSettings.tabGroupsEnabled, inactiveTabsEnabled = false),
                repository.settingsSnapshot.value,
            )
        }

    // endregion

    // region Test helpers

    private fun TestScope.createRepository(dataStore: DataStore<Preferences>) =
        DefaultTabSettingsRepository(
            dataStore = dataStore,
            scope = backgroundScope,
            defaultSettings = defaultSettings,
        )

    /**
     * A [DataStore] backed by an in-memory [MutableStateFlow] that can be configured to fail reads and writes.
     *
     * @param initialSettings The [TabSettings] initially persisted in the data store, or null if no settings have been
     *   persisted.
     * @property failReads Whether collecting [data] throws an [IOException].
     * @property failWrites Whether [updateData] throws an [IOException].
     */
    private class TestPreferencesDataStore(
        initialSettings: TabSettings? = null,
        var failReads: Boolean = false,
        var failWrites: Boolean = false,
    ) : DataStore<Preferences> {

        val preferences = MutableStateFlow(initialSettings?.toPreferences() ?: emptyPreferences())

        var collectionCount = 0
            private set

        override val data: Flow<Preferences> = flow {
            collectionCount++
            if (failReads) throw IOException("Failed to read preferences.")
            emitAll(preferences)
        }

        override suspend fun updateData(transform: suspend (t: Preferences) -> Preferences): Preferences {
            if (failWrites) throw IOException("Failed to write preferences.")
            return transform(preferences.value).also { preferences.value = it }
        }

        private fun TabSettings.toPreferences(): Preferences =
            preferencesOf(
                tabGroupsEnabledKey to tabGroupsEnabled,
                inactiveTabsEnabledKey to inactiveTabsEnabled,
            )
    }

    // endregion
}
