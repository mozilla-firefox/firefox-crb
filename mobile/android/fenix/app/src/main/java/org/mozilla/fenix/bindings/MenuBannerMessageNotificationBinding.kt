/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.fenix.bindings

import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import mozilla.components.lib.state.helpers.AbstractBinding
import org.mozilla.fenix.components.AppStore
import org.mozilla.fenix.components.appstate.AppAction
import org.mozilla.fenix.components.appstate.AppState
import org.mozilla.fenix.components.appstate.SupportedMenuNotifications
import org.mozilla.fenix.messaging.FenixMessageSurfaceId

/**
 * Shows the menu button dot ([SupportedMenuNotifications.BannerMenuItem]) while the message to show in the menu banner
 * asks for it with `menu-notification`.
 *
 * The notification is added again only when a different message asks for it, so that a notification removed when the
 * user opens the menu does not come back each time the same message is evaluated.
 *
 * @param appStore The application store to observe and to dispatch actions to.
 * @param mainDispatcher The [CoroutineDispatcher] on which the state observation and updates will occur.
 */
class MenuBannerMessageNotificationBinding(
    private val appStore: AppStore,
    mainDispatcher: CoroutineDispatcher = Dispatchers.Main,
) : AbstractBinding<AppState>(appStore, mainDispatcher) {

    override suspend fun onState(flow: Flow<AppState>) {
        flow
            .map { state ->
                state.messaging.messageToShow[FenixMessageSurfaceId.MENU_BANNER]
                    ?.takeIf { it.menuBannerConfig?.menuNotification == true }
                    ?.id
            }
            .distinctUntilChanged()
            .collect { notifyingMessageId ->
                val action =
                    if (notifyingMessageId != null) {
                        AppAction.MenuNotification.AddMenuNotification(SupportedMenuNotifications.BannerMenuItem)
                    } else {
                        AppAction.MenuNotification.RemoveMenuNotification(SupportedMenuNotifications.BannerMenuItem)
                    }
                appStore.dispatch(action)
            }
    }
}
