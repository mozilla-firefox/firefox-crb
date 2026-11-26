/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.fenix.messaging

import android.content.Intent
import io.mockk.every
import io.mockk.mockk
import io.mockk.verify
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import mozilla.components.compose.base.text.Text
import mozilla.components.compose.menu.data.BannerMenuItem
import mozilla.components.compose.menu.data.MenuItem
import mozilla.components.compose.menu.data.MenuItemSummary
import mozilla.components.compose.menu.data.MenuItemTitle
import mozilla.components.compose.menu.ui.MenuItemIconRes
import mozilla.components.service.nimbus.messaging.MenuBannerMessageConfig
import mozilla.components.service.nimbus.messaging.Message
import mozilla.components.service.nimbus.messaging.MessageData
import mozilla.components.service.nimbus.messaging.NimbusMessagingControllerInterface
import mozilla.components.service.nimbus.messaging.StyleData
import mozilla.components.support.test.middleware.CaptureActionsMiddleware
import mozilla.components.support.test.robolectric.testContext
import mozilla.components.ui.icons.R as iconsR
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.mozilla.experiments.nimbus.NullVariables
import org.mozilla.experiments.nimbus.StringHolder
import org.mozilla.fenix.R
import org.mozilla.fenix.components.AppStore
import org.mozilla.fenix.components.appstate.AppAction
import org.mozilla.fenix.components.appstate.AppAction.MessagingAction.ConsumeMessageToShow
import org.mozilla.fenix.components.appstate.AppAction.MessagingAction.MessageClicked
import org.mozilla.fenix.components.appstate.AppAction.MessagingAction.UpdateMessageToShow
import org.mozilla.fenix.components.appstate.AppState
import org.mozilla.fenix.components.menu.fake.FakeMenuHost
import org.mozilla.fenix.components.menu.fake.reachableEvents
import org.mozilla.fenix.components.menu.store.MenuAction
import org.mozilla.fenix.utils.Settings
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class BannerMenuItemProviderTest {
    private val settings: Settings = mockk(relaxed = true)
    private val menu = FakeMenuHost()
    private val pressedMessages = mutableListOf<Message>()
    private val messageController =
        object : MessageController {
            override fun onMessagePressed(message: Message) {
                pressedMessages.add(message)
            }

            override fun onMessageDismissed(message: Message) = Unit
        }

    @Before
    fun setup() {
        NullVariables.instance.setContext(testContext)
    }

    @Test
    fun `GIVEN a menu banner message WHEN providing the item THEN offer it with the app name in its text`() = runTest {
        val provider = createProvider(message = createMessage())

        assertEquals(
            listOf<MenuItem>(
                BannerMenuItem(
                    title = MenuItemTitle(Text.String("Make Firefox your default")),
                    summary = MenuItemSummary(text = Text.String("Firefox opens links for you."), maxLines = 3),
                    icon = MenuItemIconRes(R.drawable.firefox_as_default_banner_illustration),
                    onClickEvent = MenuAction.DefaultBrowserMenuBannerClicked,
                    onDismissEvent = MenuAction.DefaultBrowserMenuBannerDismissed,
                )
            ),
            provider.itemsFlow.value,
        )
    }

    @Test
    fun `GIVEN a menu banner message without an icon WHEN providing the item THEN offer it with the default icon`() =
        runTest {
            val provider = createProvider(message = createMessage(menuBannerConfig = null))

            assertEquals(
                listOf<MenuItem>(
                    BannerMenuItem(
                        title = MenuItemTitle(Text.String("Make Firefox your default")),
                        summary = MenuItemSummary(text = Text.String("Firefox opens links for you."), maxLines = 3),
                        icon = MenuItemIconRes(iconsR.drawable.mozac_ic_lightbulb_24),
                        onClickEvent = MenuAction.DefaultBrowserMenuBannerClicked,
                        onDismissEvent = MenuAction.DefaultBrowserMenuBannerDismissed,
                    )
                ),
                provider.itemsFlow.value,
            )
        }

    @Test
    fun `GIVEN a menu banner message without a title WHEN providing the item THEN don't show it`() = runTest {
        val provider = createProvider(message = createMessage(title = null))

        assertEquals(emptyList(), provider.itemsFlow.value)
    }

    @Test
    fun `GIVEN no menu banner message WHEN providing the item THEN don't show it`() = runTest {
        val provider = createProvider(message = null)

        assertEquals(emptyList(), provider.itemsFlow.value)
    }

    @Test
    fun `GIVEN a message for another surface WHEN providing the item THEN don't show it`() = runTest {
        val provider = createProvider(message = createMessage(surface = FenixMessageSurfaceId.HOMESCREEN))

        assertEquals(emptyList(), provider.itemsFlow.value)
    }

    @OptIn(ExperimentalCoroutinesApi::class)
    @Test
    fun `WHEN the menu banner message is shown and then consumed THEN offer and then hide the item`() = runTest {
        val appStore = AppStore()
        val provider = createProvider(appStore = appStore)
        assertEquals(emptyList(), provider.itemsFlow.value)

        appStore.dispatch(UpdateMessageToShow(createMessage()))
        runCurrent()
        assertEquals(listOf(MESSAGE_TITLE), provider.itemsFlow.value.map { it.title.text })

        appStore.dispatch(ConsumeMessageToShow(FenixMessageSurfaceId.MENU_BANNER))
        runCurrent()
        assertEquals(emptyList(), provider.itemsFlow.value)
    }

    @Test
    fun `WHEN clicking the item THEN report the message as pressed and keep the menu open`() = runTest {
        val message = createMessage()
        val provider = createProvider(message = message)

        provider.onEvent(MenuAction.DefaultBrowserMenuBannerClicked, menu)

        assertEquals(listOf(message), pressedMessages)
        assertFalse(menu.isUsed)
        assertEquals(listOf(MESSAGE_TITLE), provider.itemsFlow.value.map { it.title.text })
    }

    @Test
    fun `WHEN clicking the item with the default message controller THEN process the message intent and dispatch the message as clicked`() =
        runTest {
            val message = createMessage()
            val intent = Intent("action")
            val processedIntents = mutableListOf<Intent?>()
            val messagingController: NimbusMessagingControllerInterface = mockk {
                every { getIntentForMessage(message) } returns intent
            }
            val captureMiddleware = CaptureActionsMiddleware<AppState, AppAction>()
            val appStore =
                AppStore(
                    initialState =
                        AppState(
                            messaging =
                                MessagingState(messageToShow = mapOf(FenixMessageSurfaceId.MENU_BANNER to message))
                        ),
                    middlewares = listOf(captureMiddleware),
                )
            val provider =
                BannerMenuItemProvider(
                    appStore = appStore,
                    settings = settings,
                    appName = APP_NAME,
                    messageController =
                        DefaultMessageController(
                            appStore = appStore,
                            messagingController = messagingController,
                            processIntent = { processedIntents.add(it) },
                        ),
                    scope = backgroundScope,
                )

            provider.onEvent(MenuAction.DefaultBrowserMenuBannerClicked, menu)

            assertEquals(listOf<Intent?>(intent), processedIntents)
            captureMiddleware.assertLastAction(MessageClicked::class) { assertEquals(MessageClicked(message), it) }
            assertFalse(menu.isUsed)
        }

    @OptIn(ExperimentalCoroutinesApi::class)
    @Test
    fun `WHEN dismissing the item THEN hide it and keep the menu open`() = runTest {
        val provider = createProvider(message = createMessage())

        provider.onEvent(MenuAction.DefaultBrowserMenuBannerDismissed, menu)
        runCurrent()

        verify { settings.shouldShowMenuBanner = false }
        assertEquals(emptyList(), provider.itemsFlow.value)
        assertEquals(emptyList(), pressedMessages)
        assertFalse(menu.isUsed)
    }

    @Test
    fun `WHEN building the item THEN handle all events it can dispatch and no others`() = runTest {
        val provider = createProvider(message = createMessage())

        val events = provider.itemsFlow.value.single().reachableEvents()

        assertTrue(events.all { provider.handles(it) }, "Not all of $events are handled")
        assertFalse(provider.handles(MenuAction.Navigate.Settings))
    }

    private fun TestScope.createProvider(
        message: Message? = null,
        appStore: AppStore =
            AppStore(
                AppState(messaging = MessagingState(messageToShow = listOfNotNull(message).associateBy { it.surface }))
            ),
    ) =
        BannerMenuItemProvider(
            appStore = appStore,
            settings = settings,
            appName = APP_NAME,
            messageController = messageController,
            scope = backgroundScope,
        )

    private fun createMessage(
        surface: String = FenixMessageSurfaceId.MENU_BANNER,
        title: String? = "Make %1\$s your default",
        menuBannerConfig: MenuBannerMessageConfig? =
            MenuBannerMessageConfig(icon = R.drawable.firefox_as_default_banner_illustration),
    ) =
        Message(
            id = "message",
            data =
                MessageData(
                    surface = surface,
                    title = title?.let { StringHolder(null, it) },
                    text = StringHolder(null, "%1\$s opens links for you."),
                    menuBannerConfig = menuBannerConfig,
                ),
            action = "action",
            style = StyleData(),
            triggerIfAll = listOf(),
            metadata = Message.Metadata(id = "message"),
        )

    private companion object {
        const val APP_NAME = "Firefox"
        val MESSAGE_TITLE = Text.String("Make Firefox your default")
    }
}
