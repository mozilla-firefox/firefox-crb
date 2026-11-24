/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package mozilla.components.feature.tab.settings.repository

import kotlinx.coroutines.flow.StateFlow
import mozilla.components.feature.tab.settings.data.TabSettings

/** Abstraction for observing and updating tab-related user settings. */
interface TabSettingsRepository {

    /**
     * [StateFlow] for observing the current [TabSettings], or null until it has been read from disk or a setting has
     * been updated
     */
    val settingsSnapshot: StateFlow<TabSettings?>

    /** Starts observing the persisted settings and populating [settingsSnapshot]. Subsequent calls are no-ops. */
    fun initialize()

    /** Sets whether the tab groups feature is enabled. */
    fun setTabGroupsEnabled(enabled: Boolean)

    /** Sets whether the inactive tabs feature is enabled. */
    fun setInactiveTabsEnabled(enabled: Boolean)
}
