/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.fenix.tabstray.ui.tabpage

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import mozilla.components.compose.base.annotation.FlexibleWindowLightDarkPreview
import mozilla.components.compose.base.button.FilledButton
import org.mozilla.fenix.R
import org.mozilla.fenix.compose.core.Action
import org.mozilla.fenix.theme.FirefoxTheme

/**
 * UI for the Synced Tabs Page when there are no synced tabs to display, explaining why and optionally offering an
 * action to resolve it.
 *
 * @param modifier The [Modifier] to be applied to the layout.
 * @param state The [SyncedTabsEmptyStateType] describing what to display.
 */
@Composable
internal fun SyncedTabsEmptyState(
    modifier: Modifier = Modifier,
    state: SyncedTabsEmptyStateType,
) {
    EmptyTabPage(modifier = modifier.testTag(state.testTag)) {
        Column(
            modifier =
                Modifier.widthIn(max = FirefoxTheme.layout.size.containerMaxWidth)
                    .padding(FirefoxTheme.layout.space.static200),
            verticalArrangement = Arrangement.spacedBy(FirefoxTheme.layout.space.static200),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Image(
                painter = painterResource(state.drawableId),
                contentDescription = null,
                modifier = Modifier.width(200.dp),
            )
            Column(
                verticalArrangement = Arrangement.spacedBy(FirefoxTheme.layout.space.static300),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Column(
                    verticalArrangement = Arrangement.spacedBy(FirefoxTheme.layout.space.static100),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Text(
                        text = stringResource(state.titleId),
                        color = MaterialTheme.colorScheme.onSurface,
                        style = FirefoxTheme.typography.headline6,
                        textAlign = TextAlign.Center,
                    )
                    state.descriptionId?.let {
                        Text(
                            text = stringResource(it, stringResource(R.string.app_name)),
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            style = FirefoxTheme.typography.body2,
                            textAlign = TextAlign.Center,
                        )
                    }
                }
                state.action?.let {
                    FilledButton(
                        text = it.label,
                        onClick = it.onClick,
                        containerColor = MaterialTheme.colorScheme.tertiary,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }
        }
    }
}

@Composable
@FlexibleWindowLightDarkPreview
private fun SyncedTabsEmptyStateSignedOutPreview() {
    FirefoxTheme {
        SyncedTabsEmptyState(
            modifier = Modifier.background(color = MaterialTheme.colorScheme.surface),
            state =
                SyncedTabsEmptyStateType.SignedOut(
                    Action(label = stringResource(R.string.tab_manager_synced_tabs_page_sign_in_button), onClick = {})
                ),
        )
    }
}

@Composable
@FlexibleWindowLightDarkPreview
private fun SyncedTabsEmptyStateNoSyncedTabsPreview() {
    FirefoxTheme {
        SyncedTabsEmptyState(
            modifier = Modifier.background(color = MaterialTheme.colorScheme.surface),
            state = SyncedTabsEmptyStateType.NoSyncedTabs,
        )
    }
}

@Composable
@FlexibleWindowLightDarkPreview
private fun SyncedTabsEmptyStateSyncOffPreview() {
    FirefoxTheme {
        SyncedTabsEmptyState(
            modifier = Modifier.background(color = MaterialTheme.colorScheme.surface),
            state =
                SyncedTabsEmptyStateType.SyncOff(
                    Action(
                        label = stringResource(R.string.tab_manager_synced_tabs_page_turn_on_sync_button),
                        onClick = {},
                    )
                ),
        )
    }
}

@Composable
@FlexibleWindowLightDarkPreview
private fun SyncedTabsEmptyStateTabsSyncDisabledPreview() {
    FirefoxTheme {
        SyncedTabsEmptyState(
            modifier = Modifier.background(color = MaterialTheme.colorScheme.surface),
            state =
                SyncedTabsEmptyStateType.TabsSyncDisabled(
                    Action(
                        label = stringResource(R.string.tab_manager_synced_tabs_page_turn_on_tab_syncing_button),
                        onClick = {},
                    )
                ),
        )
    }
}

@Composable
@FlexibleWindowLightDarkPreview
private fun SyncedTabsEmptyStateAccountIssueSyncOnPreview() {
    FirefoxTheme {
        SyncedTabsEmptyState(
            modifier = Modifier.background(color = MaterialTheme.colorScheme.surface),
            state =
                SyncedTabsEmptyStateType.AccountIssueSyncOn(
                    Action(label = stringResource(R.string.tab_manager_synced_tabs_page_sign_in_button), onClick = {})
                ),
        )
    }
}

@Composable
@FlexibleWindowLightDarkPreview
private fun SyncedTabsEmptyStateAccountIssueSyncOffPreview() {
    FirefoxTheme {
        SyncedTabsEmptyState(
            modifier = Modifier.background(color = MaterialTheme.colorScheme.surface),
            state =
                SyncedTabsEmptyStateType.AccountIssueSyncOff(
                    Action(label = stringResource(R.string.tab_manager_synced_tabs_page_sign_in_button), onClick = {})
                ),
        )
    }
}
