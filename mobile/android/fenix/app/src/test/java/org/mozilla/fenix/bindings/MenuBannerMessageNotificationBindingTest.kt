/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.fenix.bindings

import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import mozilla.components.service.nimbus.messaging.MenuBannerMessageConfig
import mozilla.components.service.nimbus.messaging.Message
import mozilla.components.service.nimbus.messaging.MessageData
import mozilla.components.service.nimbus.messaging.MessageSurfaceId
import mozilla.components.service.nimbus.messaging.StyleData
import org.junit.Assert.assertEquals
import org.junit.Test
import org.mozilla.fenix.components.AppStore
import org.mozilla.fenix.components.appstate.AppAction.MenuNotification.AddMenuNotification
import org.mozilla.fenix.components.appstate.AppAction.MenuNotification.RemoveMenuNotification
import org.mozilla.fenix.components.appstate.AppAction.MessagingAction.ConsumeMessageToShow
import org.mozilla.fenix.components.appstate.AppAction.MessagingAction.UpdateMessageToShow
import org.mozilla.fenix.components.appstate.SupportedMenuNotifications
import org.mozilla.fenix.messaging.FenixMessageSurfaceId

private const val MENU_BANNER = FenixMessageSurfaceId.MENU_BANNER

class MenuBannerMessageNotificationBindingTest {
    private val appStore = AppStore()

    @Test
    fun `WHEN a menu banner message asking for the menu notification is shown and consumed THEN the menu notification is added and removed`() =
        runTest {
            startBinding()
            assertEquals(emptySet<SupportedMenuNotifications>(), appStore.state.supportedMenuNotifications)

            appStore.dispatch(UpdateMessageToShow(createMessage(id = "message", menuNotification = true)))
            testScheduler.advanceUntilIdle()
            assertEquals(
                setOf(SupportedMenuNotifications.BannerMenuItem),
                appStore.state.supportedMenuNotifications,
            )

            appStore.dispatch(ConsumeMessageToShow(MENU_BANNER))
            testScheduler.advanceUntilIdle()
            assertEquals(emptySet<SupportedMenuNotifications>(), appStore.state.supportedMenuNotifications)
        }

    @Test
    fun `WHEN a menu banner message not asking for the menu notification is shown THEN no menu notification is added`() =
        runTest {
            startBinding()

            appStore.dispatch(UpdateMessageToShow(createMessage(id = "message", menuNotification = false)))
            testScheduler.advanceUntilIdle()

            assertEquals(emptySet<SupportedMenuNotifications>(), appStore.state.supportedMenuNotifications)
        }

    @Test
    fun `WHEN a menu banner message without menu banner configuration is shown THEN no menu notification is added`() =
        runTest {
            startBinding()

            appStore.dispatch(UpdateMessageToShow(createMessage(id = "message", menuBannerConfig = null)))
            testScheduler.advanceUntilIdle()

            assertEquals(emptySet<SupportedMenuNotifications>(), appStore.state.supportedMenuNotifications)
        }

    @Test
    fun `WHEN a message for another surface asks for the menu notification THEN no menu notification is added`() =
        runTest {
            startBinding()

            appStore.dispatch(
                UpdateMessageToShow(
                    createMessage(id = "message", surface = FenixMessageSurfaceId.HOMESCREEN, menuNotification = true)
                )
            )
            testScheduler.advanceUntilIdle()

            assertEquals(emptySet<SupportedMenuNotifications>(), appStore.state.supportedMenuNotifications)
        }

    @Test
    fun `WHEN the menu notification was removed and the same message is shown again THEN the menu notification is not added again`() =
        runTest {
            startBinding()
            appStore.dispatch(UpdateMessageToShow(createMessage(id = "message", menuNotification = true)))
            testScheduler.advanceUntilIdle()

            appStore.dispatch(RemoveMenuNotification(SupportedMenuNotifications.BannerMenuItem))
            appStore.dispatch(
                UpdateMessageToShow(createMessage(id = "message", menuNotification = true, displayCount = 1))
            )
            testScheduler.advanceUntilIdle()

            assertEquals(emptySet<SupportedMenuNotifications>(), appStore.state.supportedMenuNotifications)
        }

    @Test
    fun `WHEN the menu notification was removed and a different message asks for it THEN the menu notification is added again`() =
        runTest {
            startBinding()
            appStore.dispatch(UpdateMessageToShow(createMessage(id = "first-message", menuNotification = true)))
            testScheduler.advanceUntilIdle()

            appStore.dispatch(RemoveMenuNotification(SupportedMenuNotifications.BannerMenuItem))
            appStore.dispatch(UpdateMessageToShow(createMessage(id = "second-message", menuNotification = true)))
            testScheduler.advanceUntilIdle()

            assertEquals(
                setOf(SupportedMenuNotifications.BannerMenuItem),
                appStore.state.supportedMenuNotifications,
            )
        }

    @Test
    fun `WHEN another menu notification is present and the menu banner message is consumed THEN only the menu banner notification is removed`() =
        runTest {
            appStore.dispatch(AddMenuNotification(SupportedMenuNotifications.Downloads))
            startBinding()
            appStore.dispatch(UpdateMessageToShow(createMessage(id = "message", menuNotification = true)))
            testScheduler.advanceUntilIdle()

            appStore.dispatch(ConsumeMessageToShow(MENU_BANNER))
            testScheduler.advanceUntilIdle()

            assertEquals(setOf(SupportedMenuNotifications.Downloads), appStore.state.supportedMenuNotifications)
        }

    private fun TestScope.startBinding() {
        MenuBannerMessageNotificationBinding(appStore, StandardTestDispatcher(testScheduler)).start()
        testScheduler.advanceUntilIdle()
    }

    private fun createMessage(
        id: String,
        surface: MessageSurfaceId = MENU_BANNER,
        menuNotification: Boolean = false,
        menuBannerConfig: MenuBannerMessageConfig? = MenuBannerMessageConfig(menuNotification = menuNotification),
        displayCount: Int = 0,
    ): Message =
        Message(
            id = id,
            data = MessageData(surface = surface, menuBannerConfig = menuBannerConfig),
            action = "action",
            style = StyleData(),
            triggerIfAll = listOf(),
            metadata = Message.Metadata(id = id, displayCount = displayCount),
        )
}
