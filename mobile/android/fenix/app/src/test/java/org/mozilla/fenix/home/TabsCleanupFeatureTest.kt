/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.fenix.home

import androidx.compose.material3.SnackbarHostState
import androidx.navigation.NavController
import androidx.navigation.NavDirections
import io.mockk.MockKAnnotations
import io.mockk.Runs
import io.mockk.every
import io.mockk.impl.annotations.RelaxedMockK
import io.mockk.just
import io.mockk.mockk
import io.mockk.slot
import io.mockk.spyk
import io.mockk.verify
import io.mockk.verifyOrder
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.test.StandardTestDispatcher
import mozilla.components.browser.state.state.BrowserState
import mozilla.components.browser.state.state.TabSessionState
import mozilla.components.browser.state.state.createTab
import mozilla.components.browser.state.store.BrowserStore
import mozilla.components.concept.engine.utils.ABOUT_HOME_URL
import mozilla.components.feature.tabdata.coordinator.DefaultTabDataCoordinator
import mozilla.components.feature.tabgroups.storage.data.TabGroup as StoredTabGroup
import mozilla.components.feature.tabgroups.storage.data.TabGroupData
import mozilla.components.feature.tabgroups.storage.fakes.FakeTabGroupRepository
import mozilla.components.feature.tabs.TabsUseCases
import mozilla.components.support.test.robolectric.testContext
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.mozilla.fenix.R
import org.mozilla.fenix.browser.browsingmode.BrowsingModeManager
import org.mozilla.fenix.components.AppStore
import org.mozilla.fenix.components.appstate.AppState
import org.mozilla.fenix.components.tabs.DefaultTabRepository
import org.mozilla.fenix.components.usecases.FenixBrowserUseCases
import org.mozilla.fenix.ext.bulkCloseUndoMessage
import org.mozilla.fenix.ext.tabsClosedUndoMessage
import org.mozilla.fenix.home.HomeScreenViewModel.Companion.ALL_ACTIVE_NORMAL_TABS
import org.mozilla.fenix.home.HomeScreenViewModel.Companion.ALL_NORMAL_TABS
import org.mozilla.fenix.home.HomeScreenViewModel.Companion.ALL_PRIVATE_TABS
import org.mozilla.fenix.utils.Settings
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class TabsCleanupFeatureTest {

    private val testDispatcher = StandardTestDispatcher()
    private val testCoroutineScope = CoroutineScope(testDispatcher)

    @RelaxedMockK private lateinit var viewModel: HomeScreenViewModel

    private var browserStore = BrowserStore()

    @RelaxedMockK private lateinit var browsingModeManager: BrowsingModeManager

    @RelaxedMockK private lateinit var navController: NavController

    @RelaxedMockK private lateinit var tabsUseCases: TabsUseCases

    @RelaxedMockK private lateinit var fenixBrowserUseCases: FenixBrowserUseCases

    private var tabGroupData = TabGroupData()

    private val fallbackTabsUseCases: TabsUseCases = mockk(relaxed = true)

    private val tabDataCoordinator by lazy {
        DefaultTabDataCoordinator(
                tabRepository =
                    DefaultTabRepository(
                        browserStore = browserStore,
                        tabsUseCases = TabsUseCases(browserStore),
                        fenixBrowserUseCases =
                            FenixBrowserUseCases(
                                appStore = AppStore(AppState()),
                                tabsUseCases = fallbackTabsUseCases,
                                loadUrlUseCase = mockk(relaxed = true),
                                searchUseCases = mockk(relaxed = true),
                                homepageTitle = "",
                                profiler = null,
                            ),
                        isHomepageAsNewTabEnabled = { settings.enableHomepageAsNewTab },
                    ),
                tabGroupRepository = FakeTabGroupRepository(initialTabGroupData = tabGroupData),
                isInactiveTabsEnabled = { settings.inactiveTabsAreEnabled },
                isTabGroupsEnabled = { true },
                scope = testCoroutineScope,
                dispatcher = testDispatcher,
            )
            .also {
                it.initialize()
                testDispatcher.scheduler.runCurrent()
            }
    }

    @RelaxedMockK private lateinit var settings: Settings

    private val snackbarHostState = SnackbarHostState()

    private val feature by lazy {
        spyk(
                TabsCleanupFeature(
                    context = testContext,
                    viewModel = viewModel,
                    browserStore = browserStore,
                    browsingModeManager = browsingModeManager,
                    navController = navController,
                    settings = settings,
                    tabsUseCases = tabsUseCases,
                    tabDataCoordinator = tabDataCoordinator,
                    fenixBrowserUseCases = fenixBrowserUseCases,
                    snackbarHostState = snackbarHostState,
                    viewLifecycleScope = testCoroutineScope,
                )
            )
            .also { every { it.showUndoSnackbar(any(), any()) } just Runs }
    }

    @Before
    fun setup() {
        MockKAnnotations.init(this)
    }

    private fun createTabGroupData(tabIds: List<String>, groupId: String = "group1") =
        TabGroupData(
            tabGroups =
                listOf(
                    StoredTabGroup(
                        id = groupId,
                        title = groupId,
                        theme = "",
                        closed = false,
                        lastModified = 0L,
                        tabIds = tabIds,
                    )
                ),
            tabGroupAssignments = tabIds.associateWith { groupId },
        )

    @Test
    fun `GIVEN all active normal tabs to delete WHEN feature is started THEN remove all active normal tabs and show undo snackbar`() {
        val tabs =
            listOf(
                createTab(id = "1", url = "https://mozilla.org/1"),
                createTab(id = "2", url = "https://mozilla.org/2"),
                createTab(id = "3", url = "https://mozilla.org/3"),
                createTab(id = "inactive_tab", url = "https://mozilla.org/4", lastAccess = 0L, createdAt = 0L),
            )

        every { settings.inactiveTabsAreEnabled } returns true
        browserStore = BrowserStore(BrowserState(tabs = tabs))
        every { viewModel.sessionToDelete } returns ALL_ACTIVE_NORMAL_TABS

        feature.start()

        assertEquals(listOf("inactive_tab"), browserStore.state.tabs.map { it.id })
        verify {
            feature.showUndoSnackbar(
                testContext.tabsClosedUndoMessage(3),
                any(),
            )

            viewModel.sessionToDelete = null
        }

        verify(exactly = 0) { tabsUseCases.removeNormalTabs() }
    }

    @Test
    fun `GIVEN all normal tabs to delete WHEN feature is started THEN remove all normal tabs and show undo snackbar`() {
        val tabsCount = 3
        val mockTabs =
            List(tabsCount) {
                createTab(url = "https://mozilla.org", private = false)
            }

        browserStore = BrowserStore(BrowserState(tabs = mockTabs))
        every { viewModel.sessionToDelete } returns ALL_NORMAL_TABS

        feature.start()

        assertTrue(browserStore.state.tabs.isEmpty())
        verify {
            feature.showUndoSnackbar(
                testContext.tabsClosedUndoMessage(tabsCount),
                any(),
            )

            viewModel.sessionToDelete = null
        }
    }

    @Test
    fun `GIVEN an open tab group and all normal tabs to delete WHEN feature is started THEN the ungrouped tabs are removed, the group is closed, and an undo snackbar is shown`() {
        tabGroupData = createTabGroupData(tabIds = listOf("2"))
        browserStore =
            BrowserStore(
                BrowserState(
                    tabs =
                        listOf(
                            createTab(id = "1", url = "https://mozilla.org"),
                            createTab(id = "2", url = "https://mozilla.org"),
                        )
                )
            )
        every { viewModel.sessionToDelete } returns ALL_NORMAL_TABS

        feature.start()
        testDispatcher.scheduler.runCurrent()

        assertEquals(listOf("2"), browserStore.state.tabs.map { it.id })
        assertTrue(tabDataCoordinator.tabsSnapshot.value!!.openTabGroups.isEmpty())
        verify {
            feature.showUndoSnackbar(
                testContext.bulkCloseUndoMessage(tabCount = 1, tabGroupCount = 1),
                any(),
            )
        }
    }

    @Test
    fun `GIVEN all normal tabs were closed with an open tab group WHEN the removal is undone THEN the group is reopened`() {
        tabGroupData = createTabGroupData(tabIds = listOf("2"))
        browserStore =
            BrowserStore(
                BrowserState(
                    tabs =
                        listOf(
                            createTab(id = "1", url = "https://mozilla.org"),
                            createTab(id = "2", url = "https://mozilla.org"),
                        )
                )
            )
        every { viewModel.sessionToDelete } returns ALL_NORMAL_TABS
        val onCancel = slot<() -> Unit>()
        every { feature.showUndoSnackbar(any(), capture(onCancel)) } just Runs

        feature.start()
        testDispatcher.scheduler.runCurrent()
        onCancel.captured.invoke()
        testDispatcher.scheduler.runCurrent()

        assertEquals(listOf("group1"), tabDataCoordinator.tabsSnapshot.value!!.openTabGroups.map { it.id })
        verify(exactly = 0) { tabsUseCases.undo.invoke() }
        verify { navController.navigate(HomeFragmentDirections.actionGlobalBrowser(null)) }
    }

    @Test
    fun `GIVEN homepage as a new tab is enabled and the selected tab is grouped WHEN all normal tabs are deleted THEN a second homepage tab is not added`() {
        every { settings.enableHomepageAsNewTab } returns true
        tabGroupData = createTabGroupData(tabIds = listOf("2"))
        browserStore =
            BrowserStore(
                BrowserState(
                    tabs =
                        listOf(
                            createTab(id = "1", url = "https://mozilla.org"),
                            createTab(id = "2", url = "https://mozilla.org"),
                        ),
                    selectedTabId = "2",
                )
            )
        every { viewModel.sessionToDelete } returns ALL_NORMAL_TABS

        feature.start()

        verify(exactly = 1) {
            fallbackTabsUseCases.addTab.invoke(
                url = ABOUT_HOME_URL,
                title = "",
                selectTab = false,
                startLoading = true,
                private = false,
            )
        }
        verify(exactly = 0) { fenixBrowserUseCases.addNewHomepageTab(private = any()) }
    }

    @Test
    fun `GIVEN a grouped tab WHEN a single tab is deleted THEN the grouped tab is not selected`() {
        tabGroupData = createTabGroupData(tabIds = listOf("2"))
        browserStore =
            BrowserStore(
                BrowserState(
                    tabs =
                        listOf(
                            createTab(id = "1", url = "https://mozilla.org"),
                            createTab(id = "2", url = "https://mozilla.org"),
                            createTab(id = "3", url = "https://mozilla.org"),
                        ),
                    selectedTabId = "1",
                )
            )
        every { viewModel.sessionToDelete } returns "1"

        feature.start()

        verify { tabsUseCases.removeTab(tabId = "1", excludedFallbackTabIds = setOf("2")) }
    }

    @Test
    fun `GIVEN all private tabs to delete WHEN feature is started THEN remove all private tabs and show undo snackbar`() {
        val tabsCount = 4
        val mockTabs =
            List(tabsCount) {
                createTab(url = "https://mozilla.org", private = true)
            }

        every { viewModel.sessionToDelete } returns ALL_PRIVATE_TABS
        browserStore = BrowserStore(BrowserState(tabs = mockTabs))

        feature.start()

        verify {
            tabsUseCases.removePrivateTabs()

            feature.showUndoSnackbar(
                testContext.tabsClosedUndoMessage(tabsCount),
                any(),
            )

            viewModel.sessionToDelete = null
        }
    }

    @Test
    fun `GIVEN homepage as a new tab is enabled and all normal tabs to delete WHEN feature is started THEN remove all normal tabs and show undo snackbar`() {
        every { settings.enableHomepageAsNewTab } returns true
        every { viewModel.sessionToDelete } returns ALL_NORMAL_TABS

        val tab1 = createTab(url = "https://mozilla.org", private = false)
        val tab2 = createTab(url = "https://mozilla.org", private = false)
        val mockTabs = listOf(tab1, tab2)

        browserStore = BrowserStore(BrowserState(tabs = mockTabs, selectedTabId = null))

        feature.start()

        assertTrue(browserStore.state.tabs.isEmpty())
        verifyOrder {
            fenixBrowserUseCases.addNewHomepageTab(private = browsingModeManager.mode.isPrivate)

            feature.showUndoSnackbar(
                testContext.tabsClosedUndoMessage(2),
                any(),
            )

            viewModel.sessionToDelete = null
        }
    }

    @Test
    fun `GIVEN homepage as a new tab is enabled and all private tabs to delete WHEN feature is started THEN remove all normal tabs, show undo snackbar and ensure 1 new tab remains`() {
        every { settings.enableHomepageAsNewTab } returns true
        every { viewModel.sessionToDelete } returns ALL_PRIVATE_TABS

        val tabsCount = 3
        val mockTabs =
            List(tabsCount) {
                createTab(url = "https://mozilla.org", private = true)
            }

        browserStore = BrowserStore(BrowserState(tabs = mockTabs))
        every { browsingModeManager.mode.isPrivate } returns true

        feature.start()

        verifyOrder {
            tabsUseCases.removePrivateTabs()

            fenixBrowserUseCases.addNewHomepageTab(private = true)

            feature.showUndoSnackbar(
                testContext.tabsClosedUndoMessage(tabsCount),
                any(),
            )

            viewModel.sessionToDelete = null
        }
    }

    @Test
    fun `GIVEN all private tabs to delete WHEN remove tabs is called THEN remove all normal tabs and show undo snackbar`() {
        val tabsCount = 5
        val mockTabs =
            List(tabsCount) {
                createTab(url = "https://mozilla.org", private = true)
            }

        every { viewModel.sessionToDelete } returns ALL_PRIVATE_TABS
        browserStore = BrowserStore(BrowserState(tabs = mockTabs))

        feature.start()

        verify {
            tabsUseCases.removePrivateTabs()

            feature.showUndoSnackbar(
                testContext.tabsClosedUndoMessage(tabsCount),
                any(),
            )

            viewModel.sessionToDelete = null
        }
    }

    @Test
    fun `GIVEN a session ID to delete WHEN feature is started THEN remove tab and show undo snackbar`() {
        val private = true
        val sessionId = "1"

        val tab: TabSessionState = createTab(id = sessionId, url = "https://www.mozilla.org", private = private)

        browserStore = BrowserStore(BrowserState(tabs = listOf(tab)))
        every { viewModel.sessionToDelete } returns sessionId

        feature.start()

        verify {
            tabsUseCases.removeTab(sessionId)

            feature.showUndoSnackbar(
                testContext.getString(R.string.snackbar_private_tab_closed),
                any(),
            )

            viewModel.sessionToDelete = null
        }
    }

    @Test
    fun `GIVEN homepage as a new tab is enabled and the last tab is to be removed WHEN feature is started THEN remove tab, show undo snackbar and ensure a new tab remains`() {
        val private = true
        val sessionId = "1"
        val tab: TabSessionState = createTab(id = sessionId, url = "https://www.mozilla.org", private = private)

        every { settings.enableHomepageAsNewTab } returns true
        every { browsingModeManager.mode.isPrivate } returns private
        every { viewModel.sessionToDelete } returns sessionId

        browserStore = BrowserStore(BrowserState(tabs = listOf(tab)))

        feature.start()

        verifyOrder {
            tabsUseCases.removeTab(sessionId)

            fenixBrowserUseCases.addNewHomepageTab(private = private)

            feature.showUndoSnackbar(
                testContext.getString(R.string.snackbar_private_tab_closed),
                any(),
            )

            viewModel.sessionToDelete = null
        }
    }

    @Test
    fun `GIVEN homepage as a new tab is enabled and a session ID to delete WHEN feature is started THEN remove tab and show undo snackbar`() {
        val private = true
        val sessionId = "1"

        val tab: TabSessionState = createTab(id = sessionId, url = "https://www.mozilla.org", private = private)

        val secondTab: TabSessionState = createTab(id = "2", url = "https://www.mozilla.org", private = private)

        every { settings.enableHomepageAsNewTab } returns true
        every { browsingModeManager.mode.isPrivate } returns private
        every { viewModel.sessionToDelete } returns sessionId

        browserStore = BrowserStore(BrowserState(tabs = listOf(tab, secondTab)))

        feature.start()

        verify {
            tabsUseCases.removeTab(sessionId)

            feature.showUndoSnackbar(
                testContext.getString(R.string.snackbar_private_tab_closed),
                any(),
            )

            viewModel.sessionToDelete = null
        }

        verify(exactly = 0) {
            fenixBrowserUseCases.addNewHomepageTab(private = private)
        }
    }

    @Test
    fun `WHEN undo tabs removed is called THEN undo tab removal and navigate to browser`() {
        feature.onUndoTabsRemoved(tabId = "")

        verify {
            tabsUseCases.undo.invoke()

            navController.navigate(HomeFragmentDirections.actionGlobalBrowser(null))
        }
    }

    @Test
    fun `GIVEN a tab ID WHEN undo tabs removed is called THEN undo tab removal, remove the tab and navigate to browser`() {
        val tabId = "1"

        feature.onUndoTabsRemoved(tabId = tabId)

        verifyOrder {
            tabsUseCases.undo.invoke()
            tabsUseCases.removeTab.invoke(tabId)
            navController.navigate(HomeFragmentDirections.actionGlobalBrowser(null))
        }
    }

    @Test
    fun `GIVEN the restored tab is a homepage tab WHEN undo tabs removed is called THEN do not navigate away from the homepage`() {
        feature.onUndoTabsRemoved(tabId = "", isRestoringHomepageTab = true)

        verify {
            tabsUseCases.undo.invoke()
        }
        verify(exactly = 0) {
            navController.navigate(any<NavDirections>())
        }
    }

    @Test
    fun `GIVEN a session ID to delete and inactive tabs exist WHEN feature is started THEN remove tab excluding inactive tabs`() {
        val activeTab =
            createTab(
                id = "1",
                url = "https://mozilla.org",
                private = false,
                lastAccess = System.currentTimeMillis(),
                createdAt = System.currentTimeMillis(),
            )

        val inactiveTab =
            createTab(
                id = "99",
                url = "https://mozilla.org",
                private = false,
                lastAccess = 0L,
                createdAt = 0L,
            )

        browserStore = BrowserStore(BrowserState(tabs = listOf(activeTab, inactiveTab)))
        every { viewModel.sessionToDelete } returns "1"

        every { settings.inactiveTabsAreEnabled } returns true

        feature.start()

        verify {
            tabsUseCases.removeTab(tabId = "1", excludedFallbackTabIds = setOf("99"))

            feature.showUndoSnackbar(testContext.getString(R.string.snackbar_tab_closed), any())

            viewModel.sessionToDelete = null
        }
    }

    @Test
    fun `GIVEN a session ID to delete and no inactive tabs exist WHEN feature is started THEN remove tab excluding empty set`() {
        val activeTab =
            createTab(
                id = "1",
                url = "https://mozilla.org",
                private = false,
                lastAccess = System.currentTimeMillis(),
                createdAt = System.currentTimeMillis(),
            )

        browserStore = BrowserStore(BrowserState(tabs = listOf(activeTab)))

        every { viewModel.sessionToDelete } returns "1"

        feature.start()

        verify {
            tabsUseCases.removeTab(tabId = "1", excludedFallbackTabIds = emptySet())

            feature.showUndoSnackbar(testContext.getString(R.string.snackbar_tab_closed), any())

            viewModel.sessionToDelete = null
        }
    }
}
