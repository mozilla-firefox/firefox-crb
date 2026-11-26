/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.fenix.messaging

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import mozilla.components.compose.base.text.Text
import mozilla.components.compose.menu.data.BannerMenuItem
import mozilla.components.compose.menu.data.MenuItem
import mozilla.components.compose.menu.data.MenuItemSummary
import mozilla.components.compose.menu.data.MenuItemTitle
import mozilla.components.compose.menu.store.MenuEvent
import mozilla.components.compose.menu.ui.MenuItemIconRes
import mozilla.components.service.nimbus.messaging.Message
import mozilla.components.ui.icons.R as iconsR
import org.mozilla.fenix.components.AppStore
import org.mozilla.fenix.components.appstate.AppState
import org.mozilla.fenix.components.menu.MenuHost
import org.mozilla.fenix.components.menu.MenuItemProvider
import org.mozilla.fenix.components.menu.store.MenuAction.DefaultBrowserMenuBannerClicked
import org.mozilla.fenix.components.menu.store.MenuAction.DefaultBrowserMenuBannerDismissed
import org.mozilla.fenix.utils.Settings

/**
 * [MenuItemProvider] for the banner showing the message to show on the [FenixMessageSurfaceId.MENU_BANNER] surface.
 *
 * Messages without a title are not shown. The `%1$s` placeholder in the title and text of the message is replaced with
 * [appName].
 *
 * @param appStore [AppStore] from which to read the message to show.
 * @param settings [Settings] application settings to update when the banner is dismissed.
 * @param appName The name of this application, shown in the banner in place of the `%1$s` placeholder.
 * @param messageController [MessageController] to which the message is reported as pressed when the banner is clicked.
 * @param scope [CoroutineScope] used to keep the banner up to date for as long as it can be shown.
 */
class BannerMenuItemProvider(
    private val appStore: AppStore,
    private val settings: Settings,
    private val appName: String,
    private val messageController: MessageController,
    scope: CoroutineScope,
) : MenuItemProvider {
    private val isDismissed = MutableStateFlow(false)

    override val itemsFlow: StateFlow<List<MenuItem>> =
        combine(appStore.stateFlow.map { it.menuBannerMessage() }.distinctUntilChanged(), isDismissed) {
                message,
                isDismissed ->
                buildItems(message, isDismissed)
            }
            .stateIn(
                scope = scope,
                started = SharingStarted.Eagerly,
                initialValue = buildItems(appStore.state.menuBannerMessage(), isDismissed.value),
            )

    override fun handles(event: MenuEvent) =
        event == DefaultBrowserMenuBannerClicked || event == DefaultBrowserMenuBannerDismissed

    override fun onEvent(event: MenuEvent, menu: MenuHost) {
        if (event == DefaultBrowserMenuBannerClicked) {
            appStore.state.menuBannerMessage()?.let { messageController.onMessagePressed(it) }
        } else {
            settings.shouldShowMenuBanner = false
            isDismissed.value = true
        }
    }

    private fun AppState.menuBannerMessage() = messaging.messageToShow[FenixMessageSurfaceId.MENU_BANNER]

    private fun buildItems(message: Message?, isDismissed: Boolean): List<MenuItem> =
        when (isDismissed) {
            true -> emptyList()
            false -> listOfNotNull(message?.toBannerMenuItem())
        }

    private fun Message.toBannerMenuItem(): BannerMenuItem? {
        val title = title ?: return null

        return BannerMenuItem(
            title = MenuItemTitle(Text.String(title.withAppName())),
            summary = MenuItemSummary(text = Text.String(text.withAppName()), maxLines = 3),
            icon = MenuItemIconRes(menuBannerConfig?.icon?.resourceId ?: iconsR.drawable.mozac_ic_lightbulb_24),
            onClickEvent = DefaultBrowserMenuBannerClicked,
            onDismissEvent = DefaultBrowserMenuBannerDismissed,
        )
    }

    /** Not [String.format], as message strings come from remote and can contain other `%` characters. */
    private fun String.withAppName() = replace(APP_NAME_PLACEHOLDER, appName)

    private companion object {
        const val APP_NAME_PLACEHOLDER = "%1\$s"
    }
}
