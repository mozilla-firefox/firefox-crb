/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package mozilla.components.feature.tabdata.coordinator.fakes

import kotlinx.coroutines.flow.MutableStateFlow
import mozilla.components.feature.tabdata.coordinator.TabDataCoordinator
import mozilla.components.feature.tabdata.coordinator.data.BulkCloseResult
import mozilla.components.feature.tabdata.coordinator.data.TabsSnapshot

/**
 * A simple fake [TabDataCoordinator] for unit tests. Its [tabsSnapshot] can be set directly. Opening and closing tab
 * groups updates [tabsSnapshot], and every other function is stubbed to do nothing.
 *
 * @param initialTabsSnapshot The [TabsSnapshot] emitted by [tabsSnapshot]. Null by default, mirroring a coordinator
 *   which is not yet fully initialized.
 * @property selectedTabIds The IDs passed to [selectTab], in call order.
 * @property addNewTabToGroupIds The group IDs passed to [addNewTabToTabGroup], in call order.
 * @property openedTabGroupIds The group IDs passed to [openTabGroup] and [openTabGroups], in call order.
 * @property closedTabGroupIds The group IDs passed to [closeTabGroup] and [closeTabGroups], in call order.
 * @property closeAllNormalTabsCalls The `includeInactiveTabs` values passed to [closeAllNormalTabs], in call order.
 * @property closeTabsAndTabGroupsCalls The tab IDs and group IDs passed to [closeTabsAndTabGroups], in call order.
 * @property undoneBulkCloseResults The results passed to [undoBulkClose], in call order.
 */
class FakeTabDataCoordinator(initialTabsSnapshot: TabsSnapshot? = null) : TabDataCoordinator {

    override val tabsSnapshot: MutableStateFlow<TabsSnapshot?> = MutableStateFlow(initialTabsSnapshot)

    val selectedTabIds = mutableListOf<String>()

    val addNewTabToGroupIds = mutableListOf<String>()

    val openedTabGroupIds = mutableListOf<String>()

    val closedTabGroupIds = mutableListOf<String>()

    val closeAllNormalTabsCalls = mutableListOf<Boolean>()

    val closeTabsAndTabGroupsCalls = mutableListOf<Pair<List<String>, List<String>>>()

    val undoneBulkCloseResults = mutableListOf<BulkCloseResult>()

    override fun initialize() = Unit

    override fun selectTab(tabId: String) {
        selectedTabIds.add(tabId)
    }

    override suspend fun createTabGroup(
        title: String,
        theme: String,
        tabIds: List<String>,
        anchorTabId: String?,
    ): String = ""

    override suspend fun updateTabGroup(tabGroupId: String, title: String, theme: String) = Unit

    override suspend fun addTabsToTabGroup(tabGroupId: String, tabIds: List<String>) = Unit

    override suspend fun addNewTabToTabGroup(tabGroupId: String) {
        addNewTabToGroupIds.add(tabGroupId)
    }

    override suspend fun mergeTabGroupIntoTab(tabGroupId: String, tabId: String) = Unit

    override suspend fun mergeTabGroups(sourceTabGroupId: String, destinationTabGroupId: String) = Unit

    override suspend fun deleteTabGroupAndTabs(tabGroupId: String) = Unit

    override suspend fun deleteTabGroupsById(tabGroupIds: List<String>) = Unit

    override suspend fun ungroupTabGroup(tabGroupId: String) = Unit

    override suspend fun openTabGroup(tabGroupId: String) {
        openedTabGroupIds.add(tabGroupId)
        updateTabGroupClosedState(tabGroupIds = setOf(tabGroupId), closed = false)
    }

    override suspend fun closeTabGroup(tabGroupId: String) {
        closedTabGroupIds.add(tabGroupId)
        updateTabGroupClosedState(tabGroupIds = setOf(tabGroupId), closed = true)
    }

    override suspend fun openTabGroups(tabGroupIds: List<String>) {
        openedTabGroupIds.addAll(tabGroupIds)
        updateTabGroupClosedState(tabGroupIds = tabGroupIds.toSet(), closed = false)
    }

    override suspend fun closeTabGroups(tabGroupIds: List<String>) {
        closedTabGroupIds.addAll(tabGroupIds)
        updateTabGroupClosedState(tabGroupIds = tabGroupIds.toSet(), closed = true)
    }

    override fun closeAllNormalTabs(includeInactiveTabs: Boolean): BulkCloseResult {
        closeAllNormalTabsCalls.add(includeInactiveTabs)
        return BulkCloseResult()
    }

    override fun closeTabsAndTabGroups(tabIds: List<String>, tabGroupIds: List<String>): BulkCloseResult {
        closeTabsAndTabGroupsCalls.add(tabIds to tabGroupIds)
        return BulkCloseResult()
    }

    override fun undoBulkClose(result: BulkCloseResult) {
        undoneBulkCloseResults.add(result)
    }

    override suspend fun removeTabFromTabGroup(tabGroupId: String, tabId: String) = Unit

    override suspend fun reorderItem(sourceId: String, destinationId: String?, placeAfter: Boolean) = Unit

    private fun updateTabGroupClosedState(tabGroupIds: Set<String>, closed: Boolean) {
        val snapshot = tabsSnapshot.value ?: return
        val tabGroups =
            snapshot.tabGroups.map { group ->
                if (group.id in tabGroupIds) group.copy(closed = closed) else group
            }
        val closedTabGroupIds = tabGroups.filter { it.closed }.mapTo(mutableSetOf()) { it.id }

        tabsSnapshot.value =
            snapshot.copy(
                tabGroups = tabGroups,
                openTabGroups = tabGroups.filterNot { it.closed },
                browsableNormalTabs =
                    snapshot.normalTabs.filterNot { tab ->
                        (snapshot.inactiveTabsEnabled && tab.inactive) || tab.tabGroupId in closedTabGroupIds
                    },
            )
    }
}
