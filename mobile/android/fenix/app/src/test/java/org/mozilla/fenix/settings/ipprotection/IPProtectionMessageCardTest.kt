/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.fenix.settings.ipprotection

import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.DeviceConfigurationOverride
import androidx.compose.ui.test.Locales
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertHasClickAction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.text.intl.LocaleList
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.util.Locale
import kotlin.test.BeforeTest
import mozilla.components.compose.base.theme.Theme
import mozilla.components.service.nimbus.messaging.Message
import mozilla.components.service.nimbus.messaging.MessageData
import mozilla.components.service.nimbus.messaging.SettingsVpnMessageConfig
import mozilla.components.service.nimbus.messaging.StyleData
import mozilla.components.support.test.robolectric.testContext
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.mozilla.experiments.nimbus.NullVariables
import org.mozilla.experiments.nimbus.StringHolder
import org.mozilla.fenix.theme.FirefoxTheme

private const val MESSAGE_CARD_TAG = "vpn-message-card"

@RunWith(AndroidJUnit4::class)
class IPProtectionMessageCardTest {
    @get:Rule val composeTestRule = createComposeRule()

    @BeforeTest
    fun setUp() {
        NullVariables.instance.setContext(testContext)
    }

    @Test
    fun `GIVEN a message title expecting arguments WHEN component is rendered with matching args THEN the title shows the formatted limit`() {
        val message =
            createVpnMessage(
                title = StringHolder(null, "Boost your VPN data limit to %1\$s GB"),
                titleArgs = listOf("arg1"),
                text = null,
            )

        composeTestRule.setContent {
            FirefoxTheme(theme = Theme.Light) {
                DeviceConfigurationOverride(
                    DeviceConfigurationOverride.Locales(LocaleList(Locale.US.toLanguageTag()))
                ) {
                    IPProtectionMessageCard(
                        message = message,
                        titleReplacements = mapOf("arg1" to 105),
                    )
                }
            }
        }

        composeTestRule.onNodeWithText("Boost your VPN data limit to 105 GB").assertIsDisplayed()
    }

    @Test
    fun `GIVEN a message title expecting multiple arguments WHEN component is rendered with matching args THEN the title is rendered`() {
        val message =
            createVpnMessage(
                title = StringHolder(null, "Boost your VPN data limit to %1\$s GB. Your current limit is %2\$s"),
                titleArgs = listOf("arg1", "arg2"),
                text = null,
            )

        composeTestRule.setContent {
            FirefoxTheme(theme = Theme.Light) {
                DeviceConfigurationOverride(
                    DeviceConfigurationOverride.Locales(LocaleList(Locale.US.toLanguageTag()))
                ) {
                    IPProtectionMessageCard(
                        message = message,
                        titleReplacements =
                            mapOf(
                                "arg2" to 10,
                                "arg1" to 105,
                            ),
                    )
                }
            }
        }

        composeTestRule
            .onNodeWithText("Boost your VPN data limit to 105 GB. Your current limit is 10")
            .assertIsDisplayed()
    }

    @Test
    fun `GIVEN a message title with no arguments WHEN component is rendered even with args THEN the title in the message is rendered`() {
        val title = "Save 20% on VPN"
        val message =
            createVpnMessage(
                title = StringHolder(null, title),
                titleArgs = listOf(),
                text = null,
            )

        composeTestRule.setContent {
            FirefoxTheme(theme = Theme.Light) {
                DeviceConfigurationOverride(
                    DeviceConfigurationOverride.Locales(LocaleList(Locale.US.toLanguageTag()))
                ) {
                    IPProtectionMessageCard(
                        message = message,
                        titleReplacements = mapOf("arg1" to 105),
                    )
                }
            }
        }

        composeTestRule.onNodeWithText(title).assertIsDisplayed()
    }

    @Test
    fun `GIVEN a message title expecting arguments WHEN the component is rendered with unknown args THEN the card is not rendered`() {
        val message =
            createVpnMessage(
                title = StringHolder(null, "Hey there, you've got %1\$s GB to use"),
                titleArgs = listOf("arg1"),
                text = null,
            )

        composeTestRule.setContent {
            FirefoxTheme(theme = Theme.Light) {
                IPProtectionMessageCard(
                    modifier = Modifier.testTag(MESSAGE_CARD_TAG),
                    message = message,
                    titleReplacements = mapOf("unexpected-arg" to 10),
                )
            }
        }
        composeTestRule.onNodeWithTag(MESSAGE_CARD_TAG).assertDoesNotExist()
    }

    @Test
    fun `GIVEN a message title expecting arguments WHEN the component is rendered with no title args THEN the card is not rendered `() {
        val message =
            createVpnMessage(
                title = StringHolder(null, "Hey there, you've got %1\$s GB to use"),
                titleArgs = listOf("arg1"),
                text = null,
            )

        composeTestRule.setContent {
            FirefoxTheme(theme = Theme.Light) {
                IPProtectionMessageCard(
                    modifier = Modifier.testTag(MESSAGE_CARD_TAG),
                    message = message,
                    titleReplacements = emptyMap(),
                )
            }
        }
        composeTestRule.onNodeWithTag(MESSAGE_CARD_TAG).assertDoesNotExist()
    }

    @Test
    fun `GIVEN a message title expecting arguments WHEN the component is rendered with fewer arguments THEN the card is not rendered `() {
        val message =
            createVpnMessage(
                title = StringHolder(null, "Hey there, you've got %1\$s GB to use by %2\$s"),
                titleArgs = listOf("arg1", "arg2"),
                text = null,
            )

        composeTestRule.setContent {
            FirefoxTheme(theme = Theme.Light) {
                IPProtectionMessageCard(
                    modifier = Modifier.testTag(MESSAGE_CARD_TAG),
                    message = message,
                    titleReplacements = mapOf("arg2" to 10),
                )
            }
        }
        composeTestRule.onNodeWithTag(MESSAGE_CARD_TAG).assertDoesNotExist()
    }

    @Test
    fun `GIVEN a message body WHEN rendering the card THEN the body is displayed`() {
        val body = "Your VPN data resets every month."
        val message =
            createVpnMessage(
                title = StringHolder(null, "Boost your VPN data limit to %1\$s GB"),
                titleArgs = listOf("arg1"),
                text = StringHolder(null, body),
            )

        composeTestRule.setContent {
            FirefoxTheme(theme = Theme.Light) {
                IPProtectionMessageCard(
                    message = message,
                    titleReplacements = mapOf("arg1" to 10),
                )
            }
        }

        composeTestRule.onNodeWithText(body).assertIsDisplayed()
    }

    @Test
    fun `GIVEN no message body WHEN rendering the card THEN the empty body marker is hidden`() {
        val message = createVpnMessage(title = StringHolder(null, "More data for you"), text = null)

        composeTestRule.setContent {
            FirefoxTheme(theme = Theme.Light) {
                IPProtectionMessageCard(message, modifier = Modifier.testTag(MESSAGE_CARD_TAG))
            }
        }

        composeTestRule.onNodeWithTag(MESSAGE_CARD_TAG).assertIsDisplayed()
        composeTestRule.onNodeWithText(EMPTY_VPN_MESSAGE_BODY).assertDoesNotExist()
    }

    @Test
    fun `GIVEN a message action WHEN rendering the card THEN the action is displayed and clickable`() {
        val message =
            createVpnMessage(
                title = StringHolder(null, "More data -> %1\$s GB"),
                titleArgs = listOf("arg1"),
                text = StringHolder(null, "Your message body"),
                actionLabel = StringHolder(null, "Hey click me!"),
            )

        composeTestRule.setContent {
            FirefoxTheme(theme = Theme.Light) {
                IPProtectionMessageCard(
                    message = message,
                    titleReplacements = mapOf("arg1" to 10),
                )
            }
        }

        composeTestRule
            .onNodeWithContentDescription("Hey click me!", substring = true)
            .assertIsDisplayed()
            .assertHasClickAction()
    }

    @Test
    fun `GIVEN no action label WHEN rendering the card THEN there is no clickable action`() {
        val message =
            createVpnMessage(
                title = StringHolder(null, "More data for you"),
                text = StringHolder(null, "Your message body"),
                actionLabel = null,
            )

        composeTestRule.setContent {
            FirefoxTheme(theme = Theme.Light) {
                IPProtectionMessageCard(
                    message = message,
                    modifier = Modifier.testTag(MESSAGE_CARD_TAG),
                )
            }
        }

        composeTestRule.onNodeWithTag(MESSAGE_CARD_TAG).assertIsDisplayed()
        composeTestRule.onAllNodes(hasClickAction(), useUnmergedTree = true).assertCountEquals(0)
    }

    private fun createVpnMessage(
        id: String = "message-id",
        title: StringHolder,
        titleArgs: List<String> = emptyList(),
        text: StringHolder?,
        actionLabel: StringHolder? = null,
    ): Message {
        val data =
            MessageData(
                title = title,
                text = text ?: StringHolder(null, EMPTY_VPN_MESSAGE_BODY),
                buttonLabel = actionLabel,
                settingsVpnConfig = SettingsVpnMessageConfig(titleArgs = titleArgs),
            )
        return Message(
            id = id,
            data = data,
            action = "",
            style = StyleData(),
            triggerIfAll = emptyList(),
            metadata = Message.Metadata(id = id),
        )
    }
}
