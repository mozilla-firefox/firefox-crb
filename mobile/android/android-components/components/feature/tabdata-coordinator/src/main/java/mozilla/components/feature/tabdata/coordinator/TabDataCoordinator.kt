/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package mozilla.components.feature.tabdata.coordinator

import kotlin.math.abs
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted.Companion.Eagerly
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import mozilla.components.feature.tabdata.coordinator.data.BulkCloseResult
import mozilla.components.feature.tabdata.coordinator.data.Tab
import mozilla.components.feature.tabdata.coordinator.data.TabGroup
import mozilla.components.feature.tabdata.coordinator.data.TabsSnapshot
import mozilla.components.feature.tabdata.coordinator.data.findTab
import mozilla.components.feature.tabdata.coordinator.data.findTabGroup
import mozilla.components.feature.tabdata.coordinator.data.firstTabIdInTabGroup
import mozilla.components.feature.tabdata.coordinator.data.groupedTabIds
import mozilla.components.feature.tabdata.coordinator.data.lastTabIdInTabGroup
import mozilla.components.feature.tabdata.coordinator.data.tabIdsInTabGroup
import mozilla.components.feature.tabdata.coordinator.repository.TabRepository
import mozilla.components.feature.tabgroups.storage.data.TabGroup as StoredTabGroup
import mozilla.components.feature.tabgroups.storage.data.TabGroupData
import mozilla.components.feature.tabgroups.storage.repository.TabGroupRepository
import mozilla.components.support.base.log.logger.Logger
import mozilla.components.support.utils.DateTimeProvider
import mozilla.components.support.utils.DefaultDateTimeProvider

/** Value class representing the combined data model of all tab data inputs before being transformed. */
@JvmInline
private value class CombinedTabData(private val combinedData: Pair<TabRepository.Data, TabGroupData>) {
    val tabs: List<Tab>
        get() = combinedData.first.tabs

    val selectedTabId: String?
        get() = combinedData.first.selectedTabId

    val tabGroups: List<StoredTabGroup>
        get() = combinedData.second.tabGroups

    val tabGroupAssignments: Map<String, String> // tab ID -> tab group ID
        get() = combinedData.second.tabGroupAssignments
}

/**
 * Abstraction for observing and updating tab data.
 *
 * Updates which span more than one tab data source, such as assigning a tab to a tab group, are performed here.
 */
interface TabDataCoordinator {

    /**
     * The [StateFlow] which emits the [TabsSnapshot] transformed from various tab data sources. Emits null when it's
     * not fully initialized.
     */
    val tabsSnapshot: StateFlow<TabsSnapshot?>

    /** Initializes the coordinator so it starts collecting from its aggregate of data sources. */
    fun initialize()

    /**
     * Selects or makes active the tab with [tabId].
     *
     * @param tabId The ID of the tab to select.
     */
    fun selectTab(tabId: String)

    /**
     * Creates a new tab group containing [tabIds] and returns its ID.
     *
     * The tabs are sequenced next to [anchorTabId] so the group's tabs are adjacent in the tab list.
     *
     * @param title The title of the new group.
     * @param theme The theme of the new group.
     * @param tabIds The IDs of the tabs to assign to the new group.
     * @param anchorTabId The ID of the tab the group's other tabs are sequenced after. Must be one of [tabIds]. When
     *   null, whichever of [tabIds] appears first in the tab list is used.
     */
    suspend fun createTabGroup(
        title: String,
        theme: String,
        tabIds: List<String>,
        anchorTabId: String? = null,
    ): String

    /**
     * Updates the title and theme of the tab group with [tabGroupId].
     *
     * @param tabGroupId The ID of the group to update.
     * @param title The new title of the group.
     * @param theme The new theme of the group.
     */
    suspend fun updateTabGroup(tabGroupId: String, title: String, theme: String)

    /**
     * Assigns [tabIds] to the group with [tabGroupId], moving them next to the group's existing tabs.
     *
     * @param tabGroupId The ID of the group the tabs are added to.
     * @param tabIds The IDs of the tabs to add to the group.
     */
    suspend fun addTabsToTabGroup(tabGroupId: String, tabIds: List<String>)

    /**
     * Opens a new tab, assigns it to the group with [tabGroupId], and focuses the tab.
     *
     * @param tabGroupId The ID of the group the new tab is added to.
     */
    suspend fun addNewTabToTabGroup(tabGroupId: String)

    /**
     * Assigns [tabId] to the group with [tabGroupId], moving the group's existing tabs next to [tabId] instead of
     * moving [tabId] to the group.
     *
     * @param tabGroupId The ID of the group the tab is added to.
     * @param tabId The ID of the tab to add to the group.
     */
    suspend fun mergeTabGroupIntoTab(tabGroupId: String, tabId: String)

    /**
     * Moves the tabs of the group with [sourceTabGroupId] into the group with [destinationTabGroupId] and deletes the
     * source group.
     *
     * @param sourceTabGroupId The ID of the group being merged away.
     * @param destinationTabGroupId The ID of the group the tabs are merged into.
     */
    suspend fun mergeTabGroups(sourceTabGroupId: String, destinationTabGroupId: String)

    /**
     * Closes the tabs of the group with [tabGroupId] and deletes the group.
     *
     * @param tabGroupId The ID of the group to delete.
     */
    suspend fun deleteTabGroupAndTabs(tabGroupId: String)

    /**
     * Deletes the groups with [tabGroupIds], leaving the tabs which belonged to them open and ungrouped.
     *
     * @param tabGroupIds The IDs of the groups to delete.
     */
    suspend fun deleteTabGroupsById(tabGroupIds: List<String>)

    /**
     * Deletes the group with [tabGroupId], leaving the tabs which belonged to it open and ungrouped.
     *
     * @param tabGroupId The ID of the group to ungroup.
     */
    suspend fun ungroupTabGroup(tabGroupId: String)

    /**
     * Marks the group with [tabGroupId] as open.
     *
     * @param tabGroupId The ID of the group to open.
     */
    suspend fun openTabGroup(tabGroupId: String)

    /**
     * Marks the group with [tabGroupId] as closed, leaving its tabs open.
     *
     * @param tabGroupId The ID of the group to close.
     */
    suspend fun closeTabGroup(tabGroupId: String)

    /**
     * Marks the groups with [tabGroupIds] as open.
     *
     * @param tabGroupIds The IDs of the groups to open.
     */
    suspend fun openTabGroups(tabGroupIds: List<String>)

    /**
     * Marks the groups with [tabGroupIds] as closed, leaving their tabs open.
     *
     * @param tabGroupIds The IDs of the groups to close.
     */
    suspend fun closeTabGroups(tabGroupIds: List<String>)

    /**
     * Removes the normal tabs that are not assigned to a tab group, and closes all of the open tab groups, leaving
     * their tabs open. Grouped and inactive tabs are excluded from being selected after the removal.
     *
     * If the selected tab belongs to a group, a new tab is added and selected, if possible.
     *
     * @param includeInactiveTabs Whether ungrouped inactive tabs are also removed.
     * @return The [BulkCloseResult] needed to undo the operation with [undoBulkClose].
     */
    fun closeAllNormalTabs(includeInactiveTabs: Boolean): BulkCloseResult

    /**
     * Removes the normal tabs with [tabIds], and closes the open groups among [tabGroupIds], leaving their tabs open.
     * Grouped and inactive tabs are excluded from being selected after the removal.
     *
     * If the selected tab belongs to a closed group, the nearest normal tab that is neither grouped, inactive, nor
     * removed is selected instead. When there is no such tab, a new tab is added and selected, if possible.
     *
     * @param tabIds The IDs of the normal tabs to remove.
     * @param tabGroupIds The IDs of the groups to close.
     * @return The [BulkCloseResult] needed to undo the operation with [undoBulkClose].
     */
    fun closeTabsAndTabGroups(tabIds: List<String>, tabGroupIds: List<String>): BulkCloseResult

    /**
     * Undoes a bulk close operation by restoring the removed tabs, reopening the closed groups, removing the added tab,
     * and restoring the selected tab.
     *
     * @param result The [BulkCloseResult] returned by [closeAllNormalTabs] or [closeTabsAndTabGroups].
     */
    fun undoBulkClose(result: BulkCloseResult)

    /**
     * Closes [tabId] if the group with [tabGroupId] has other tabs. A group is never left without tabs, so closing the
     * last tab of a group is a no-op; delete the group instead.
     *
     * @param tabGroupId The ID of the group the tab belongs to.
     * @param tabId The ID of the tab to close.
     */
    suspend fun removeTabFromTabGroup(tabGroupId: String, tabId: String)

    /**
     * Moves the tab or tab group with [sourceId] next to the tab or tab group with [destinationId].
     *
     * Groups are moved and anchored as a unit, so that the tabs of a group remain adjacent in the tab list.
     *
     * @param sourceId The ID of the tab or tab group being moved.
     * @param destinationId The ID of the tab or tab group being moved next to. No-op when null or when it matches
     *   [sourceId].
     * @param placeAfter Whether the moved item is placed after, rather than before, the destination.
     */
    suspend fun reorderItem(sourceId: String, destinationId: String?, placeAfter: Boolean)
}

/**
 * The default implementation of [TabDataCoordinator].
 *
 * @param tabRepository Repository used to observe, and perform updates to, tab data.
 * @param tabGroupRepository Repository used to observe, and perform updates to, tab group data.
 * @param isInactiveTabsEnabled Fetch whether the inactive tabs feature is enabled.
 * @param isTabGroupsEnabled Fetch whether the tab groups feature is enabled.
 * @param scope [CoroutineScope] used to transform the data sources inputs into an outputted [StateFlow].
 * @param dispatcher [CoroutineDispatcher] the tab data transformation is performed on.
 * @param dateTimeProvider [DateTimeProvider] used to stamp tab group updates.
 */
@Suppress("TooManyFunctions")
class DefaultTabDataCoordinator(
    private val tabRepository: TabRepository,
    private val tabGroupRepository: TabGroupRepository,
    private val isInactiveTabsEnabled: () -> Boolean,
    private val isTabGroupsEnabled: () -> Boolean,
    private val scope: CoroutineScope,
    private val dispatcher: CoroutineDispatcher = Dispatchers.Default,
    private val dateTimeProvider: DateTimeProvider = DefaultDateTimeProvider(),
) : TabDataCoordinator {

    private val combinedDataFlow: StateFlow<CombinedTabData?> by lazy {
        combine(
                flow = tabRepository.tabFlow.distinctUntilChanged(),
                flow2 = tabGroupRepository.tabGroupDataFlow.distinctUntilChanged(),
            ) { tabData, tabGroupData ->
                CombinedTabData(combinedData = Pair(tabData, tabGroupData))
            }
            .flowOn(dispatcher)
            .stateIn(
                scope = scope,
                started = Eagerly,
                initialValue = null,
            )
    }

    private val logger = Logger(tag = "TabDataCoordinator")

    override val tabsSnapshot: StateFlow<TabsSnapshot?>
        field = MutableStateFlow<TabsSnapshot?>(null)

    override fun initialize() {
        scope.launch {
            combinedDataFlow.filterNotNull().collect { data ->
                withContext(dispatcher) {
                    val transformedTabData = transformTabData(tabData = data)
                    tabsSnapshot.emit(transformedTabData)
                }
            }
        }
    }

    override fun selectTab(tabId: String) {
        tabRepository.selectTab(tabId)
    }

    override suspend fun createTabGroup(
        title: String,
        theme: String,
        tabIds: List<String>,
        anchorTabId: String?,
    ): String {
        val tabGroup =
            StoredTabGroup(
                title = title,
                theme = theme,
                lastModified = dateTimeProvider.currentTimeMillis(),
                tabIds = tabIds,
            )

        if (tabIds.isEmpty()) {
            tabGroupRepository.addNewTabGroup(tabGroup = tabGroup)
            return tabGroup.id
        }

        val anchorId = anchorTabId ?: tabIds.sequentiallyFirstTabId()
        sequenceTabsTogether(tabIds = tabIds - anchorId, targetTabId = anchorId)
        tabGroupRepository.createTabGroupWithTabs(tabGroup = tabGroup)

        return tabGroup.id
    }

    override suspend fun updateTabGroup(tabGroupId: String, title: String, theme: String) {
        tabGroupRepository.updateTabGroup(
            tabGroup =
                StoredTabGroup(
                    id = tabGroupId,
                    title = title,
                    theme = theme,
                    closed = tabsSnapshot.value?.findTabGroup(id = tabGroupId)?.closed ?: false,
                    lastModified = dateTimeProvider.currentTimeMillis(),
                )
        )
    }

    override suspend fun addTabsToTabGroup(tabGroupId: String, tabIds: List<String>) {
        // Sequence the tabs after the group's other tabs, if it has any.
        tabsSnapshot.value?.lastTabIdInTabGroup(tabGroupId = tabGroupId)?.let { lastTabIdInGroup ->
            sequenceTabsTogether(tabIds = tabIds, targetTabId = lastTabIdInGroup)
        }

        tabGroupRepository.addTabsToTabGroup(tabGroupId = tabGroupId, tabIds = tabIds)
    }

    override suspend fun addNewTabToTabGroup(tabGroupId: String) {
        val tabId = tabRepository.addNewTab()
        addTabsToTabGroup(tabGroupId = tabGroupId, tabIds = listOf(tabId))
        tabRepository.selectTab(tabId)
    }

    override suspend fun mergeTabGroupIntoTab(tabGroupId: String, tabId: String) {
        val groupedTabIds = tabsSnapshot.value?.tabIdsInTabGroup(tabGroupId = tabGroupId) ?: emptyList()

        // Sequence the group's tabs in front of the target tab.
        if (groupedTabIds.isNotEmpty()) {
            tabRepository.moveTabs(tabIds = groupedTabIds, targetTabId = tabId, placeAfter = false)
        }

        tabGroupRepository.addTabGroupAssignment(tabId = tabId, tabGroupId = tabGroupId)
    }

    override suspend fun mergeTabGroups(sourceTabGroupId: String, destinationTabGroupId: String) {
        val sourceTabIds = tabsSnapshot.value?.tabIdsInTabGroup(tabGroupId = sourceTabGroupId) ?: emptyList()

        if (sourceTabIds.isNotEmpty()) {
            addTabsToTabGroup(tabGroupId = destinationTabGroupId, tabIds = sourceTabIds)
        }

        tabGroupRepository.deleteTabGroupById(tabGroupId = sourceTabGroupId)
    }

    override suspend fun deleteTabGroupAndTabs(tabGroupId: String) {
        val snapshot = tabsSnapshot.value
        val inactiveTabIds =
            if (isInactiveTabsEnabled()) {
                snapshot?.inactiveTabs?.mapTo(mutableSetOf()) { it.id } ?: emptySet()
            } else {
                emptySet()
            }

        tabRepository.removeTabs(
            tabIds = snapshot?.tabIdsInTabGroup(tabGroupId = tabGroupId) ?: emptyList(),
            excludedFallbackTabIds = inactiveTabIds,
        )

        tabGroupRepository.deleteTabGroupById(tabGroupId = tabGroupId)
    }

    override suspend fun deleteTabGroupsById(tabGroupIds: List<String>) {
        tabGroupRepository.deleteTabGroupsById(ids = tabGroupIds)
    }

    override suspend fun ungroupTabGroup(tabGroupId: String) {
        tabGroupRepository.ungroupTabGroup(tabGroupId = tabGroupId)
    }

    override suspend fun openTabGroup(tabGroupId: String) {
        tabGroupRepository.openTabGroup(tabGroupId = tabGroupId)
    }

    override suspend fun closeTabGroup(tabGroupId: String) {
        tabGroupRepository.closeTabGroup(tabGroupId = tabGroupId)
    }

    override suspend fun openTabGroups(tabGroupIds: List<String>) {
        tabGroupIds.forEach { tabGroupRepository.openTabGroup(tabGroupId = it) }
    }

    override suspend fun closeTabGroups(tabGroupIds: List<String>) {
        tabGroupIds.forEach { tabGroupRepository.closeTabGroup(tabGroupId = it) }
    }

    override fun closeAllNormalTabs(includeInactiveTabs: Boolean): BulkCloseResult {
        val snapshot =
            tabsSnapshot.value ?: return BulkCloseResult().also { logger.warn("closeAllNormalTabs: No tab data.") }
        val groupedTabIds = snapshot.groupedTabIds()
        val keptTabIds = if (includeInactiveTabs) groupedTabIds else groupedTabIds + snapshot.inactiveTabIds()

        return bulkClose(
            snapshot = snapshot,
            tabIdsToRemove = snapshot.normalTabs.map { it.id }.filterNot { it in keptTabIds },
            tabGroupIdsToClose = snapshot.openTabGroups.mapTo(mutableSetOf()) { it.id },
        )
    }

    override fun closeTabsAndTabGroups(tabIds: List<String>, tabGroupIds: List<String>): BulkCloseResult {
        val snapshot =
            tabsSnapshot.value ?: return BulkCloseResult().also { logger.warn("closeTabsAndTabGroups: No tab data.") }

        return bulkClose(snapshot = snapshot, tabIdsToRemove = tabIds, tabGroupIdsToClose = tabGroupIds.toSet())
    }

    override fun undoBulkClose(result: BulkCloseResult) {
        if (result.removedTabCount > 0) {
            tabRepository.undoRemovedTabs()
        }

        if (result.closedTabGroupIds.isNotEmpty()) {
            scope.launch { openTabGroups(tabGroupIds = result.closedTabGroupIds) }
        }

        result.addedTabId?.let { tabRepository.removeTabs(tabIds = listOf(it)) }

        // A removed tab is reselected when it's restored, so only reselect a tab which is still open.
        result.previousSelectedTabId
            ?.takeIf { tabsSnapshot.value?.findTab(id = it) != null }
            ?.let { tabRepository.selectTab(tabId = it) }
    }

    override suspend fun removeTabFromTabGroup(tabGroupId: String, tabId: String) {
        val groupedTabIds = tabsSnapshot.value?.tabIdsInTabGroup(tabGroupId = tabGroupId) ?: emptyList()

        if (groupedTabIds.size > 1) {
            tabRepository.removeTabs(tabIds = listOf(tabId))
        }
    }

    @Suppress("ReturnCount")
    override suspend fun reorderItem(sourceId: String, destinationId: String?, placeAfter: Boolean) {
        if (destinationId == null || destinationId == sourceId) return

        val snapshot = tabsSnapshot.value
        val sourceTabGroup = snapshot?.findTabGroup(id = sourceId)
        val destinationTabGroup = snapshot?.findTabGroup(id = destinationId)

        // A group destination is anchored to its first or last tab, depending on which side the source is placed on.
        val targetTabId =
            when {
                destinationTabGroup == null -> destinationId
                placeAfter -> snapshot.lastTabIdInTabGroup(tabGroupId = destinationId)
                else -> snapshot.firstTabIdInTabGroup(tabGroupId = destinationId)
            }

        if (targetTabId == null) {
            logger.warn("reorderItem: Empty destination group. No action taken.")
            return
        }

        if (sourceTabGroup == null) {
            tabRepository.moveTab(sourceTabId = sourceId, targetTabId = targetTabId, placeAfter = placeAfter)
            return
        }

        val sourceTabIds = snapshot.tabIdsInTabGroup(tabGroupId = sourceId)
        if (sourceTabIds.isEmpty()) {
            logger.warn("reorderItem: Empty source group. No action taken.")
            return
        }

        tabRepository.moveTabs(tabIds = sourceTabIds, targetTabId = targetTabId, placeAfter = placeAfter)
    }

    /**
     * Removes [tabIdsToRemove] and closes the open groups among [tabGroupIdsToClose]. If the selected tab is hidden in
     * a closed group, the nearest normal tab that is neither grouped, inactive, nor removed is selected, otherwise a
     * new tab is added and selected, if possible.
     */
    private fun bulkClose(
        snapshot: TabsSnapshot,
        tabIdsToRemove: List<String>,
        tabGroupIdsToClose: Set<String>,
    ): BulkCloseResult {
        val previousSelectedTabId = snapshot.selectedTab?.id
        val unselectableTabIds = snapshot.groupedTabIds() + snapshot.inactiveTabIds()

        if (tabIdsToRemove.isNotEmpty()) {
            tabRepository.removeTabs(tabIds = tabIdsToRemove, excludedFallbackTabIds = unselectableTabIds)
        }

        val closingTabGroups = snapshot.openTabGroups.filter { it.id in tabGroupIdsToClose }
        val closingTabGroupIds = closingTabGroups.map { it.id }
        if (closingTabGroupIds.isNotEmpty()) {
            scope.launch { closeTabGroups(tabGroupIds = closingTabGroupIds) }
        }

        val hiddenTabIds = closingTabGroups.flatMapTo(mutableSetOf()) { it.tabIds }
        var addedTabId: String? = null

        if (previousSelectedTabId != null && previousSelectedTabId in hiddenTabIds) {
            val excludedTabIds = unselectableTabIds + tabIdsToRemove
            val fallbackTabId =
                snapshot.findNearbyNormalTabId(tabId = previousSelectedTabId, excludedTabIds = excludedTabIds)
                    ?: tabRepository.addFallbackTab().also { addedTabId = it }

            fallbackTabId?.let { tabRepository.selectTab(tabId = it) }
        }

        return BulkCloseResult(
            removedTabCount = tabIdsToRemove.size,
            closedTabGroupIds = closingTabGroupIds,
            previousSelectedTabId = previousSelectedTabId,
            addedTabId = addedTabId,
        )
    }

    /**
     * Because the sort order of the tabs is owned by the tab data source, the tabs of a group have to be arranged next
     * to each other there for the group to be indexed at the correct spot when displayed.
     */
    private fun sequenceTabsTogether(tabIds: List<String>, targetTabId: String) {
        if (tabIds.isEmpty()) return

        tabRepository.moveTabs(tabIds = tabIds, targetTabId = targetTabId, placeAfter = true)
    }

    /**
     * Returns the ID of the list's tab IDs that appears sequentially-first within the aggregate list of normal tabs. As
     * a fallback, the list's first tab ID will be used instead.
     */
    private fun List<String>.sequentiallyFirstTabId(): String =
        tabsSnapshot.value?.normalTabs?.firstOrNull { it.id in this }?.id ?: first()

    /** Transforms the inputted data into the final [TabsSnapshot] model. */
    private fun transformTabData(tabData: CombinedTabData): TabsSnapshot {
        val isInactiveTabsEnabled = isInactiveTabsEnabled()
        val isTabGroupsEnabled = isTabGroupsEnabled()
        val privateTabs = tabData.tabs.filter { tab -> tab.private }
        val (normalTabsWithGroupAssignments, closedTabGroupIds, transformedTabGroups) =
            processTabGroups(tabData = tabData)
        val inactiveTabs =
            if (isInactiveTabsEnabled) {
                normalTabsWithGroupAssignments.filter { it.inactive }
            } else {
                emptyList()
            }
        val browsableNormalTabs =
            filterBrowsableTabsFromNormalTabs(
                normalTabs = normalTabsWithGroupAssignments,
                closedTabGroupIds = closedTabGroupIds,
            )
        val selectedTab =
            normalTabsWithGroupAssignments.find { it.id == tabData.selectedTabId }
                ?: privateTabs.find { it.id == tabData.selectedTabId }

        return TabsSnapshot(
            selectedTab = selectedTab,
            normalTabs = normalTabsWithGroupAssignments,
            browsableNormalTabs = browsableNormalTabs,
            privateTabs = privateTabs,
            inactiveTabs = inactiveTabs,
            tabGroups = transformedTabGroups,
            openTabGroups = transformedTabGroups.filter { !it.closed },
            inactiveTabsEnabled = isInactiveTabsEnabled,
            tabGroupsEnabled = isTabGroupsEnabled,
        )
    }

    /**
     * Returns the processed tab group data.
     * - List of normal tabs with their tab group assignment.
     * - Set of IDs of closed tab groups.
     * - List of tab groups with their list of tab IDs.
     *
     * If the tab groups feature is disabled, empty tab group lists will be returned and the normal tabs will not be
     * assigned to their groups, if assigned.
     */
    private fun processTabGroups(tabData: CombinedTabData): Triple<List<Tab>, Set<String>, List<TabGroup>> {
        val normalTabsWithoutAssignments = tabData.tabs.filter { tab -> !tab.private }
        val normalTabsWithGroupAssignments: List<Tab>
        val closedTabGroupIds: Set<String>
        val transformedTabGroups: List<TabGroup>

        if (isTabGroupsEnabled()) {
            closedTabGroupIds = tabData.tabGroups.filter { it.closed }.mapTo(mutableSetOf()) { it.id }
            transformedTabGroups =
                tabData.tabGroups.map { group ->
                    TabGroup(
                        id = group.id,
                        title = group.title,
                        theme = group.theme,
                        closed = group.closed,
                        lastModified = group.lastModified,
                        tabIds = group.confirmedTabGroupAssignments(tabList = tabData.tabs),
                    )
                }
            normalTabsWithGroupAssignments = normalTabsWithoutAssignments.map { tab ->
                val tabGroupId: String? = tabData.tabGroupAssignments[tab.id]
                if (tabGroupId == tab.tabGroupId) {
                    tab
                } else {
                    tab.copy(tabGroupId = tabGroupId)
                }
            }
        } else {
            closedTabGroupIds = emptySet()
            transformedTabGroups = emptyList()
            normalTabsWithGroupAssignments = normalTabsWithoutAssignments
        }

        return Triple(normalTabsWithGroupAssignments, closedTabGroupIds, transformedTabGroups)
    }

    /**
     * Filters the normal tabs that should not be considered in features that rely on filtered-out tabs.
     *
     * @return The list of normal tabs that are NOT inactive OR assigned to a closed tab group
     */
    private fun filterBrowsableTabsFromNormalTabs(
        normalTabs: List<Tab>,
        closedTabGroupIds: Set<String>,
    ): List<Tab> {
        return normalTabs.filterNot { tab ->
            (isInactiveTabsEnabled() && tab.inactive) || tab.tabGroupId in closedTabGroupIds
        }
    }
}

/**
 * Only return the IDs of the group's tabs that exist from the tab data source.
 *
 * There's a chance that the tab data source has updated before the tab group data source has been updated, so filter
 * out the tabs that may no longer exist.
 */
private fun StoredTabGroup.confirmedTabGroupAssignments(tabList: List<Tab>): List<String> {
    val groupDatabaseAssignments = tabIds.toHashSet()
    return tabList.filter { it.id in groupDatabaseAssignments }.map { it.id }
}

private fun TabsSnapshot.inactiveTabIds(): Set<String> = inactiveTabs.mapTo(mutableSetOf()) { it.id }

/** Finds the ID of the normal tab nearest to [tabId] which isn't in [excludedTabIds]. */
private fun TabsSnapshot.findNearbyNormalTabId(tabId: String, excludedTabIds: Set<String>): String? {
    val index = normalTabs.indexOfFirst { it.id == tabId }

    return normalTabs
        .withIndex()
        .filter { (_, tab) -> tab.id !in excludedTabIds }
        .minByOrNull { (candidateIndex, _) -> abs(candidateIndex - index) }
        ?.value
        ?.id
}
