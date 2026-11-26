/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.fenix.settings.biometric.ui

import android.os.SystemClock

private const val MAX_SUPPRESSION_DURATION_MS = 180_000L

/**
 * Lets a [SecureScreen] skip the authentication prompt once, when the user comes back from a flow the app started
 * itself, like picking a file to import from.
 *
 * @param maxSuppressionDurationMs How long after [suppressNextPrompt] the suppression can still be used.
 * @param now Returns the current time in milliseconds.
 */
class AuthPromptSuppressor(
    private val maxSuppressionDurationMs: Long = MAX_SUPPRESSION_DURATION_MS,
    private val now: () -> Long = SystemClock::elapsedRealtime,
) {
    private var suppressionStartedAt: Long? = null

    /** Suppresses the next authentication prompt, if it happens within [maxSuppressionDurationMs]. */
    fun suppressNextPrompt() {
        suppressionStartedAt = now()
    }

    /**
     * Uses up the pending suppression, even when it has expired, so a second call always returns false.
     *
     * @return true if [suppressNextPrompt] was called no longer than [maxSuppressionDurationMs] ago.
     */
    fun consume(): Boolean {
        val startedAt = suppressionStartedAt ?: return false
        suppressionStartedAt = null
        return now() - startedAt <= maxSuppressionDurationMs
    }
}
