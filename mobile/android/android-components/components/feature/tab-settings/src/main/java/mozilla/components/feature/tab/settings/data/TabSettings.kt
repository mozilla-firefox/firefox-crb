/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package mozilla.components.feature.tab.settings.data

/**
 * Data class containing the current snapshot of tab-related user settings.
 *
 * @property tabGroupsEnabled Whether the tab groups feature is enabled.
 * @property inactiveTabsEnabled Whether the inactive tabs feature is enabled.
 */
data class TabSettings(
    val tabGroupsEnabled: Boolean,
    val inactiveTabsEnabled: Boolean,
)
