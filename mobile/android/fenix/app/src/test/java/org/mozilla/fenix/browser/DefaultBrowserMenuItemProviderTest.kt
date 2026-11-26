/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.fenix.browser

import io.mockk.every
import io.mockk.mockk
import io.mockk.verify
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertTrue
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import mozilla.components.compose.base.text.Text
import mozilla.components.compose.menu.data.BannerMenuItem
import mozilla.components.compose.menu.data.MenuItemSummary
import mozilla.components.compose.menu.data.MenuItemTitle
import mozilla.components.compose.menu.ui.MenuItemIconRes
import org.junit.Test
import org.mozilla.fenix.R
import org.mozilla.fenix.components.AppStore
import org.mozilla.fenix.components.appstate.AppAction
import org.mozilla.fenix.components.appstate.AppState
import org.mozilla.fenix.components.menu.MenuTarget
import org.mozilla.fenix.components.menu.fake.FakeMenuHost
import org.mozilla.fenix.components.menu.fake.reachableEvents
import org.mozilla.fenix.components.menu.store.MenuAction
import org.mozilla.fenix.utils.Settings

@OptIn(ExperimentalCoroutinesApi::class)
class DefaultBrowserMenuItemProviderTest {
    private val settings: Settings = mockk(relaxed = true)
    private val appStore = AppStore(AppState())
    private val menu = FakeMenuHost()
    private var setAsDefaultBrowserCount = 0

    @Test
    fun `GIVEN the banner wasn't dismissed and this isn't the default browser WHEN providing the item THEN offer it`() =
        runTest {
            val provider = createProvider(shouldShowMenuBanner = true, isDefaultBrowser = false)

            assertEquals(
                BannerMenuItem(
                    title = MenuItemTitle(Text.Resource(R.string.browser_menu_default_banner_title, listOf(APP_NAME))),
                    summary =
                        MenuItemSummary(
                            text = Text.Resource(R.string.browser_menu_default_banner_subtitle_2),
                            maxLines = 3,
                        ),
                    icon = MenuItemIconRes(R.drawable.kit_default_browser_menu_banner),
                    actionButtonText = Text.Resource(R.string.browser_menu_default_banner_button),
                    onClickEvent = MenuAction.DefaultBrowserMenuBannerClicked,
                    onDismissEvent = MenuAction.DefaultBrowserMenuBannerDismissed,
                ),
                provider.itemsFlow.value.single(),
            )
        }

    @Test
    fun `GIVEN the banner was dismissed before WHEN providing the item THEN don't show it`() = runTest {
        val provider = createProvider(shouldShowMenuBanner = false, isDefaultBrowser = false)

        assertTrue(provider.itemsFlow.value.isEmpty())
    }

    @Test
    fun `GIVEN this is already the default browser WHEN providing the item THEN don't show it`() = runTest {
        val provider = createProvider(shouldShowMenuBanner = true, isDefaultBrowser = true)

        assertTrue(provider.itemsFlow.value.isEmpty())
    }

    @Test
    fun `WHEN clicking the item THEN ask to set this as the default browser and keep the menu open`() = runTest {
        val provider = createProvider(shouldShowMenuBanner = true, isDefaultBrowser = false)

        provider.onEvent(MenuAction.DefaultBrowserMenuBannerClicked, menu)

        assertEquals(1, setAsDefaultBrowserCount)
        assertFalse(menu.isUsed)
        assertIs<BannerMenuItem>(provider.itemsFlow.value.single())
    }

    @Test
    fun `WHEN this becomes the default browser while the menu is shown THEN hide the item`() = runTest {
        val provider = createProvider(shouldShowMenuBanner = true, isDefaultBrowser = false)
        assertIs<BannerMenuItem>(provider.itemsFlow.value.single())

        appStore.dispatch(AppAction.UpdateDefaultBrowserStatus(true))
        runCurrent()

        assertTrue(provider.itemsFlow.value.isEmpty())
    }

    @Test
    fun `WHEN dismissing the item THEN hide it for good and keep the menu open`() = runTest {
        val provider = createProvider(shouldShowMenuBanner = true, isDefaultBrowser = false)

        provider.onEvent(MenuAction.DefaultBrowserMenuBannerDismissed, menu)
        runCurrent()

        verify { settings.shouldShowMenuBanner = false }
        assertTrue(provider.itemsFlow.value.isEmpty())
        assertEquals(0, setAsDefaultBrowserCount)
        assertFalse(menu.isUsed)
    }

    @Test
    fun `WHEN building the item THEN handle all events it can dispatch and no others`() = runTest {
        val provider = createProvider(shouldShowMenuBanner = true, isDefaultBrowser = false)

        val events = provider.itemsFlow.value.single().reachableEvents()

        assertTrue(events.all { provider.handles(it) }, "Not all of $events are handled")
        assertFalse(provider.handles(MenuAction.Navigate.Settings))
    }

    @Test
    fun `GIVEN the menu preview WHEN interacting with the item THEN don't handle its events`() = runTest {
        val provider =
            createProvider(shouldShowMenuBanner = true, isDefaultBrowser = false, target = MenuTarget.Preview)

        assertIs<BannerMenuItem>(provider.itemsFlow.value.single())
        assertFalse(provider.handles(MenuAction.DefaultBrowserMenuBannerClicked))
        assertFalse(provider.handles(MenuAction.DefaultBrowserMenuBannerDismissed))
    }

    private fun TestScope.createProvider(
        shouldShowMenuBanner: Boolean,
        isDefaultBrowser: Boolean,
        target: MenuTarget = MenuTarget.BrowserTab,
    ): DefaultBrowserMenuItemProvider {
        every { settings.shouldShowMenuBanner } returns shouldShowMenuBanner
        every { settings.isDefaultBrowser } returns isDefaultBrowser

        return DefaultBrowserMenuItemProvider(
            settings = settings,
            appStore = appStore,
            appName = APP_NAME,
            target = target,
            scope = backgroundScope,
            setAsDefaultBrowser = { setAsDefaultBrowserCount++ },
        )
    }

    private companion object {
        const val APP_NAME = "Firefox"
    }
}
