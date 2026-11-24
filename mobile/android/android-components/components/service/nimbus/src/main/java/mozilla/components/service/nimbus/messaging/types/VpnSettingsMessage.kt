/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package mozilla.components.service.nimbus.messaging.types

import java.util.IllegalFormatException
import java.util.Locale
import mozilla.components.service.nimbus.messaging.Message

/**
 * Wrapper type around a [Message].
 *
 * @property original Original message.
 */
data class VpnSettingsMessage(internal val original: Message) {
    /** The text of the message. */
    val text: String
        get() = original.text

    private val titleArgs: List<String>
        get() = original.data.settingsVpnConfig?.titleArgs ?: emptyList()

    /** The action text for the message */
    val actionText: String?
        get() = original.data.buttonLabel

    /** Returns the title of the message formatted with the right [locale] and [arguments] */
    fun title(locale: Locale = Locale.getDefault(), arguments: Map<String, Any> = emptyMap()): String? {
        val title = original.title ?: return null
        val keys = titleArgs
        if (keys.isEmpty()) return title

        val args = keys.map { key -> arguments[key] ?: return null }
        return try {
            @Suppress("SpreadOperator") // required since we are passing an array to vararg
            String.format(locale, title, *args.toTypedArray())
        } catch (_: IllegalFormatException) {
            null
        }
    }
}

/** Creates a [VpnSettingsMessage] from the given [Message]. */
val Message.vpnSettingsMessage: VpnSettingsMessage
    get() = VpnSettingsMessage(original = this)
