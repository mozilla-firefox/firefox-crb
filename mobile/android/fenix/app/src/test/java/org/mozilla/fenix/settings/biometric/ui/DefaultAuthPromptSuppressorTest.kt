/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.fenix.settings.biometric.ui

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DefaultAuthPromptSuppressorTest {

    private var now = 0L
    private val suppressor = DefaultAuthPromptSuppressor(maxSuppressionDurationMs = 1_000L, now = { now })

    @Test
    fun `GIVEN no suppression WHEN consumed THEN the prompt is not suppressed`() {
        assertFalse(suppressor.consumeSuppression())
    }

    @Test
    fun `GIVEN a suppression WHEN consumed within the time limit THEN the prompt is suppressed`() {
        suppressor.suppressNextPrompt()
        now = 1_000L

        assertTrue(suppressor.consumeSuppression())
    }

    @Test
    fun `GIVEN a suppression WHEN consumed after the time limit THEN the prompt is not suppressed`() {
        suppressor.suppressNextPrompt()
        now = 1_001L

        assertFalse(suppressor.consumeSuppression())
    }

    @Test
    fun `GIVEN a consumed suppression WHEN consumed again THEN the prompt is not suppressed`() {
        suppressor.suppressNextPrompt()
        suppressor.consumeSuppression()

        assertFalse(suppressor.consumeSuppression())
    }

    @Test
    fun `GIVEN an expired suppression WHEN consumed twice THEN the prompt is not suppressed either time`() {
        suppressor.suppressNextPrompt()
        now = 1_001L

        assertFalse(suppressor.consumeSuppression())
        now = 1_002L
        assertFalse(suppressor.consumeSuppression())
    }
}
