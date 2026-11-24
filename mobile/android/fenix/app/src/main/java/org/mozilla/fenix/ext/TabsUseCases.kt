/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.fenix.ext

import mozilla.components.browser.state.state.BrowserState
import mozilla.components.feature.tabs.TabsUseCases

/**
 * Removes all the active normal tabs, leaving any inactive tabs open. Inactive tabs are also excluded when selecting a
 * fallback tab.
 *
 * @param state The [BrowserState] holding the currently open tabs.
 * @param inactiveTabsEnabled Whether the user has the inactive tabs feature enabled.
 * @return The number of tabs that were removed.
 */
fun TabsUseCases.removeAllActiveNormalTabs(state: BrowserState, inactiveTabsEnabled: Boolean): Int {
    val (activeTabs, inactiveTabs) = state.partitionNormalTabsByActiveTime(inactiveTabsEnabled = inactiveTabsEnabled)
    val tabIdsToRemove = activeTabs.map { it.id }

    removeTabs(ids = tabIdsToRemove, excludedFallbackTabIds = inactiveTabs.mapTo(mutableSetOf()) { it.id })

    return tabIdsToRemove.size
}
