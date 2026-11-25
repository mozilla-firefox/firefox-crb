/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package mozilla.components.feature.tabdata.coordinator.data

/**
 * The outcome of a bulk close operation, which is needed to undo it.
 *
 * @property removedTabCount The number of tabs that were removed.
 * @property closedTabGroupIds The IDs of the groups that were open and have been closed.
 * @property previousSelectedTabId The ID of the tab that was selected before the operation.
 * @property addedTabId The ID of the tab added because the selected tab was hidden in a closed group and no other tab
 *   could be selected.
 */
data class BulkCloseResult(
    val removedTabCount: Int = 0,
    val closedTabGroupIds: List<String> = emptyList(),
    val previousSelectedTabId: String? = null,
    val addedTabId: String? = null,
)
