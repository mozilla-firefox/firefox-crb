/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package mozilla.components.feature.tab.settings.fakes

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import mozilla.components.feature.tab.settings.data.TabSettings
import mozilla.components.feature.tab.settings.repository.TabSettingsRepository

/**
 * A fake implementation of [TabSettingsRepository] designed exclusively for unit tests.
 *
 * Updates are applied to [settingsSnapshot] synchronously.
 *
 * @param defaultSettings The [TabSettings] that updates are applied to while [settingsSnapshot] is null.
 * @param initialSettingsSnapshot The initial value of [settingsSnapshot].
 */
class FakeTabSettingsRepository(
    private val defaultSettings: TabSettings =
        TabSettings(
            tabGroupsEnabled = true,
            inactiveTabsEnabled = true,
        ),
    initialSettingsSnapshot: TabSettings? = defaultSettings,
) : TabSettingsRepository {

    override val settingsSnapshot: StateFlow<TabSettings?>
        field: MutableStateFlow<TabSettings?> = MutableStateFlow(initialSettingsSnapshot)

    /** Whether [initialize] has been called. */
    var isInitialized: Boolean = false
        private set

    override fun initialize() {
        isInitialized = true
    }

    override fun setTabGroupsEnabled(enabled: Boolean) {
        settingsSnapshot.update { snapshot -> (snapshot ?: defaultSettings).copy(tabGroupsEnabled = enabled) }
    }

    override fun setInactiveTabsEnabled(enabled: Boolean) {
        settingsSnapshot.update { snapshot -> (snapshot ?: defaultSettings).copy(inactiveTabsEnabled = enabled) }
    }
}
