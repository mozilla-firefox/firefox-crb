/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package mozilla.components.feature.tab.settings.repository

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.core.IOException
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.emptyPreferences
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.launchIn
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import mozilla.components.feature.tab.settings.data.TabSettings
import mozilla.components.feature.tab.settings.datastore.inactiveTabsEnabledKey
import mozilla.components.feature.tab.settings.datastore.tabGroupsEnabledKey
import mozilla.components.feature.tab.settings.datastore.tabSettingsDataStore
import mozilla.components.support.base.log.logger.Logger

/**
 * The default implementation of [TabSettingsRepository].
 *
 * Updates are applied to [settingsSnapshot] immediately and persisted to the [DataStore] asynchronously. If persisting
 * fails, the affected setting is reverted.
 *
 * @param dataStore The [DataStore] used to read/write the tab settings.
 * @param scope The [CoroutineScope] used to observe the [DataStore] once [initialize] is called and to perform writes.
 * @param defaultSettings The [TabSettings] used for any setting that has not been persisted yet.
 */
class DefaultTabSettingsRepository
internal constructor(
    private val dataStore: DataStore<Preferences>,
    private val scope: CoroutineScope,
    private val defaultSettings: TabSettings,
) : TabSettingsRepository {

    private val logger = Logger(tag = "DefaultTabSettingsRepository")

    constructor(
        context: Context,
        scope: CoroutineScope,
        defaultSettings: TabSettings,
    ) : this(
        dataStore = context.tabSettingsDataStore,
        scope = scope,
        defaultSettings = defaultSettings,
    )

    private val _settingsSnapshot = MutableStateFlow<TabSettings?>(null)

    override val settingsSnapshot: StateFlow<TabSettings?> = _settingsSnapshot.asStateFlow()

    private val initialized = AtomicBoolean(false)

    /** The most recent [TabSettings] read from the [DataStore], used to recover from failed writes. */
    @Volatile private var persistedSnapshot: TabSettings? = null

    override fun initialize() {
        if (!initialized.compareAndSet(false, true)) return

        dataStore.data
            .catch { exception ->
                if (exception is IOException) {
                    logger.error("Error reading preferences.", exception)
                    emit(emptyPreferences())
                } else {
                    throw exception
                }
            }
            .map { preferences ->
                TabSettings(
                    tabGroupsEnabled = preferences[tabGroupsEnabledKey] ?: defaultSettings.tabGroupsEnabled,
                    inactiveTabsEnabled = preferences[inactiveTabsEnabledKey] ?: defaultSettings.inactiveTabsEnabled,
                )
            }
            .onEach { snapshot ->
                persistedSnapshot = snapshot
                _settingsSnapshot.value = snapshot
            }
            .launchIn(scope)
    }

    override fun setTabGroupsEnabled(enabled: Boolean) =
        updateSetting(
            key = tabGroupsEnabledKey,
            value = enabled,
            read = TabSettings::tabGroupsEnabled,
            write = { snapshot, value -> snapshot.copy(tabGroupsEnabled = value) },
        )

    override fun setInactiveTabsEnabled(enabled: Boolean) =
        updateSetting(
            key = inactiveTabsEnabledKey,
            value = enabled,
            read = TabSettings::inactiveTabsEnabled,
            write = { snapshot, value -> snapshot.copy(inactiveTabsEnabled = value) },
        )

    /**
     * Applies [value] to [settingsSnapshot] and persists it under [key]. If the write fails and the setting has not
     * been changed since, it is reverted to its last persisted value.
     *
     * @param key The [Preferences.Key] the setting is persisted under.
     * @param value The new value of the setting.
     * @param read Reads the setting from a [TabSettings].
     * @param write Returns a copy of a [TabSettings] with the setting replaced.
     */
    private fun updateSetting(
        key: Preferences.Key<Boolean>,
        value: Boolean,
        read: (TabSettings) -> Boolean,
        write: (TabSettings, Boolean) -> TabSettings,
    ) {
        _settingsSnapshot.update { snapshot -> write(snapshot ?: defaultSettings, value) }

        scope.launch {
            try {
                dataStore.edit { preferences -> preferences[key] = value }
            } catch (exception: IOException) {
                logger.error("Error writing preferences.", exception)
                val persistedValue = read(persistedSnapshot ?: defaultSettings)
                _settingsSnapshot.update { snapshot ->
                    if (snapshot != null && read(snapshot) == value) write(snapshot, persistedValue) else snapshot
                }
            }
        }
    }
}
