/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.fenix.tabstray.ui

import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import mozilla.components.feature.syncedtabs.view.SyncedTabsView
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.mozilla.fenix.R
import org.mozilla.fenix.tabstray.TabsTrayTestTag
import org.mozilla.fenix.tabstray.redux.state.TabsTrayState
import org.mozilla.fenix.tabstray.syncedtabs.SyncedTabsListItem
import org.mozilla.fenix.tabstray.ui.tabpage.SyncedTabsPage

@RunWith(AndroidJUnit4::class)
class SyncedTabsPageTest {
    @get:Rule val composeTestRule = createComposeRule()

    @Test
    fun givenSignedOutThenSignedOutStateIsShown() {
        setContent(state = TabsTrayState.SyncState(isSignedIn = false), showNewSyncPageState = true)

        composeTestRule.onNodeWithTag(TabsTrayTestTag.UNAUTHENTICATED_SYNCED_TABS_PAGE).assertExists()
    }

    @Test
    fun givenSignedOutWhenSignInIsClickedThenCallbackIsInvoked() {
        var signInClicked = false
        setContent(
            state = TabsTrayState.SyncState(isSignedIn = false),
            showNewSyncPageState = true,
            onSignInClick = { signInClicked = true },
        )

        composeTestRule.onNodeWithText(getString(R.string.tab_manager_synced_tabs_page_sign_in_button)).performClick()

        assertTrue(signInClicked)
    }

    @Test
    fun givenNoTabsErrorThenNoSyncedTabsStateIsShown() {
        setContent(
            state =
                TabsTrayState.SyncState(
                    isSignedIn = true,
                    syncedTabs = listOf(SyncedTabsListItem.Error(errorText = "No tabs")),
                    expandedSyncedTabs = listOf(true),
                    syncError = SyncedTabsView.ErrorType.NO_TABS_AVAILABLE,
                ),
            showNewSyncPageState = true,
        )

        composeTestRule.onNodeWithTag(TabsTrayTestTag.NO_SYNCED_TABS_PAGE).assertExists()
        composeTestRule.onNodeWithTag(TabsTrayTestTag.SYNCED_TABS_LIST).assertDoesNotExist()
    }

    @Test
    fun givenNewSyncPageDisabledAndSignedOutThenOldSignedOutPageIsShown() {
        setContent(state = TabsTrayState.SyncState(isSignedIn = false), showNewSyncPageState = false)

        composeTestRule.onNodeWithTag(TabsTrayTestTag.UNAUTHENTICATED_SYNCED_TABS_PAGE).assertExists()
        composeTestRule
            .onNodeWithText(getString(R.string.tab_manager_empty_synced_tabs_page_sign_in_cta))
            .assertExists()
    }

    private fun setContent(
        state: TabsTrayState.SyncState,
        showNewSyncPageState: Boolean,
        onSignInClick: () -> Unit = {},
    ) {
        composeTestRule.setContent {
            SyncedTabsPage(
                state = state,
                config = TabsTrayState.TabsTrayConfig(showNewSyncPageState = showNewSyncPageState),
                onTabClick = {},
                onTabClose = { _, _ -> },
                onSignInClick = onSignInClick,
                onSectionExpansionToggled = {},
            )
        }
    }

    private fun getString(id: Int) = InstrumentationRegistry.getInstrumentation().targetContext.getString(id)
}
