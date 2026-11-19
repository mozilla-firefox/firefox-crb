/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.fenix.tabstray.ui.tabpage

import androidx.annotation.DrawableRes
import androidx.annotation.StringRes
import org.mozilla.fenix.R
import org.mozilla.fenix.compose.core.Action
import org.mozilla.fenix.tabstray.TabsTrayTestTag

/**
 * The different states that can be displayed by [SyncedTabsEmptyState] when there are no synced tabs to show.
 *
 * @property drawableId The illustration displayed at the top of the page.
 * @property titleId The title of the page.
 * @property descriptionId The optional description below the title.
 * @property testTag The test tag used to identify this state in UI tests.
 * @property action The optional button displayed below the description.
 */
sealed class SyncedTabsEmptyStateType(
    @param:DrawableRes val drawableId: Int,
    @param:StringRes val titleId: Int,
    @param:StringRes val descriptionId: Int? = null,
    val testTag: String,
    val action: Action? = null,
) {
    /**
     * The user is not signed in to a Mozilla account.
     *
     * @param action The button inviting the user to sign in.
     */
    class SignedOut(action: Action) :
        SyncedTabsEmptyStateType(
            drawableId = R.drawable.kit_tabs_devices,
            titleId = R.string.tab_manager_synced_tabs_page_signed_out_title,
            descriptionId = R.string.tab_manager_synced_tabs_page_signed_out_description,
            testTag = TabsTrayTestTag.UNAUTHENTICATED_SYNCED_TABS_PAGE,
            action = action,
        )

    /** The user is signed in and Sync is on, but there are no tabs from other devices. */
    data object NoSyncedTabs :
        SyncedTabsEmptyStateType(
            drawableId = R.drawable.kit_tabs_devices,
            titleId = R.string.tab_manager_synced_tabs_page_no_synced_tabs_title,
            descriptionId = R.string.tab_manager_synced_tabs_page_no_synced_tabs_description,
            testTag = TabsTrayTestTag.NO_SYNCED_TABS_PAGE,
        )

    /**
     * The user is signed in but Sync is turned off.
     *
     * @param action The button inviting the user to turn on Sync.
     */
    class SyncOff(action: Action) :
        SyncedTabsEmptyStateType(
            drawableId = R.drawable.kit_tabs_devices,
            titleId = R.string.tab_manager_synced_tabs_page_sync_off_title,
            testTag = TabsTrayTestTag.SYNC_OFF_SYNCED_TABS_PAGE,
            action = action,
        )

    /**
     * The user is signed in and Sync is on, but the tabs sync engine is disabled.
     *
     * @param action The button inviting the user to turn on tab syncing.
     */
    class TabsSyncDisabled(action: Action) :
        SyncedTabsEmptyStateType(
            drawableId = R.drawable.kit_tabs_devices,
            titleId = R.string.tab_manager_synced_tabs_page_tabs_sync_disabled_title,
            descriptionId = R.string.tab_manager_synced_tabs_page_tabs_sync_disabled_description,
            testTag = TabsTrayTestTag.TABS_SYNC_DISABLED_SYNCED_TABS_PAGE,
            action = action,
        )

    /**
     * The user's account needs to be re-authenticated while Sync is on.
     *
     * @param action The button inviting the user to sign in again.
     */
    class AccountIssueSyncOn(action: Action) :
        SyncedTabsEmptyStateType(
            drawableId = R.drawable.kit_tabs_devices,
            titleId = R.string.tab_manager_synced_tabs_page_account_issue_sync_on_title,
            descriptionId = R.string.tab_manager_synced_tabs_page_account_issue_sync_on_description,
            testTag = TabsTrayTestTag.ACCOUNT_ISSUE_SYNCED_TABS_PAGE,
            action = action,
        )

    /**
     * The user's account needs to be re-authenticated while Sync is off.
     *
     * @param action The button inviting the user to sign in again.
     */
    class AccountIssueSyncOff(action: Action) :
        SyncedTabsEmptyStateType(
            drawableId = R.drawable.kit_tabs_devices,
            titleId = R.string.tab_manager_synced_tabs_page_account_issue_sync_off_title,
            descriptionId = R.string.tab_manager_synced_tabs_page_account_issue_sync_off_description,
            testTag = TabsTrayTestTag.ACCOUNT_ISSUE_SYNCED_TABS_PAGE,
            action = action,
        )
}
