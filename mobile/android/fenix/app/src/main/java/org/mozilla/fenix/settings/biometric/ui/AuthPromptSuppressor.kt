/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.fenix.settings.biometric.ui

import android.os.SystemClock

private const val MAX_SUPPRESSION_DURATION_MS = 180_000L

/**
 * Picking a file to import from moves the app to the background, which would otherwise make a [SecureScreen] ask for
 * authentication again when the user comes back. Lets the [SecureScreen] skip that prompt once.
 */
interface AuthPromptSuppressor {
    /** Makes the suppression available to the next [consumeSuppression] call. */
    fun suppressNextPrompt()

    /**
     * Checks whether the authentication prompt should be suppressed. Any pending suppression is used up by this call,
     * even when it returns false because it was requested too long ago, so a second call always returns false.
     *
     * @return true if [suppressNextPrompt] was called recently enough.
     */
    fun consumeSuppression(): Boolean
}

/**
 * Default implementation of [AuthPromptSuppressor].
 *
 * @param maxSuppressionDurationMs How long after [suppressNextPrompt] the suppression can still be used.
 * @param now Returns the current time in milliseconds.
 */
class DefaultAuthPromptSuppressor(
    private val maxSuppressionDurationMs: Long = MAX_SUPPRESSION_DURATION_MS,
    private val now: () -> Long = SystemClock::elapsedRealtime,
) : AuthPromptSuppressor {
    private var suppressionStartedAt: Long? = null

    override fun suppressNextPrompt() {
        suppressionStartedAt = now()
    }

    override fun consumeSuppression(): Boolean {
        val startedAt = suppressionStartedAt ?: return false
        suppressionStartedAt = null
        return now() - startedAt <= maxSuppressionDurationMs
    }
}
