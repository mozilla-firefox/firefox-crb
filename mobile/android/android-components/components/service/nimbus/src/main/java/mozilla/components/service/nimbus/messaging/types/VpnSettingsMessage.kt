/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package mozilla.components.service.nimbus.messaging.types

import java.util.Collections.emptyList
import java.util.IllegalFormatException
import java.util.Locale
import mozilla.components.service.nimbus.messaging.Message

/**
 * Wrapper type around a [Message] specific for VPN Settings.
 *
 * @property title Title of the message.
 * @property text The optional body of the message.
 * @property actionText The optional action text of the message.
 * @property original Original nimbus message.
 */
@ConsistentCopyVisibility
data class VpnSettingsMessage
private constructor(
    val title: String,
    val text: String?,
    val actionText: String?,
    val original: Message,
) {

    companion object {

        /**
         * Creates a VpnSettings message from a nimbus message, and a map of replacements for the title.
         *
         * Returns `null` if the title is missing or blank after formatting, or if formatting fails.
         *
         * @param message Original nimbus message.
         * @param locale The locale for formatting the message.
         * @param titleArgsReplacements A map of replacement values for the title arguments specified in the original
         *   message definition. E.g `fxa_data_limit_gb` to a value provided by the app (e.g 50) - ends up getting
         *   substituted in the original title text.
         */
        fun createFrom(
            message: Message,
            locale: Locale = Locale.getDefault(),
            titleArgsReplacements: Map<String, Any> = emptyMap(),
        ): VpnSettingsMessage? {
            val originalTitle = message.title
            val originalTitleArguments = message.data.settingsVpnConfig?.titleArgs ?: emptyList()

            val title = formatTitle(originalTitle, originalTitleArguments, titleArgsReplacements, locale) ?: return null
            if (title.isBlank()) return null

            val text = message.text.takeUnless { it == EMPTY_VPN_MESSAGE_BODY || it.isBlank() }
            val actionText = message.data.buttonLabel?.takeUnless { it.isBlank() }

            return VpnSettingsMessage(
                title = title,
                text = text,
                actionText = actionText,
                original = message,
            )
        }

        /** Returns the title of the message formatted with the right [locale] and [titleArgsReplacements] */
        private fun formatTitle(
            originalTitle: String?,
            titleArgs: List<String>,
            titleArgsReplacements: Map<String, Any>,
            locale: Locale,
        ): String? {
            val title = originalTitle ?: return null
            if (titleArgs.isEmpty()) return title

            val args = titleArgs.map { key -> titleArgsReplacements[key] ?: return null }

            return try {
                @Suppress("SpreadOperator") // required since we are passing an array to vararg
                String.format(locale, title, *args.toTypedArray())
            } catch (_: IllegalFormatException) {
                null
            }
        }
    }
}

internal const val EMPTY_VPN_MESSAGE_BODY = "VPN_MESSAGE_EMPTY_BODY"
