/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.fenix.settings.logins.ui

import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import mozilla.components.support.test.middleware.CaptureActionsMiddleware
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.mozilla.fenix.settings.biometric.ui.state.SecureScreenAction
import org.mozilla.fenix.settings.biometric.ui.state.SecureScreenAction.SuppressAction
import org.mozilla.fenix.settings.biometric.ui.state.SecureScreenState
import org.mozilla.fenix.settings.biometric.ui.state.SecureScreenStore

@RunWith(AndroidJUnit4::class)
class SuppressLockDuringImportTest {
    @get:Rule val composeTestRule = createComposeRule()

    private lateinit var captureMiddleware: CaptureActionsMiddleware<SecureScreenState, SecureScreenAction>

    @Before
    fun setup() {
        captureMiddleware = CaptureActionsMiddleware()
    }

    @Test
    fun `GIVEN idle state WHEN composable is invoked THEN no action is dispatched`() {
        setContent(LoginsImportState.Idle)

        captureMiddleware.assertNoActionDispatched()
    }

    @Test
    fun `GIVEN opening file picker state WHEN composable is invoked THEN suppress next lock action is dispatched`() {
        setContent(LoginsImportState.OpeningFilePicker)

        captureMiddleware.assertLastAction(SuppressAction.SuppressNextLock::class)
    }

    @Test
    fun `GIVEN import started state WHEN composable is invoked THEN clear suppress lock action is dispatched`() {
        setContent(LoginsImportState.ImportStarted)

        captureMiddleware.assertLastAction(SuppressAction.ClearNextSuppress::class)
    }

    @Test
    fun `GIVEN import cancelled state WHEN composable is invoked THEN clear suppress lock action is dispatched`() {
        setContent(LoginsImportState.ImportCancelled)

        captureMiddleware.assertLastAction(SuppressAction.ClearNextSuppress::class)
    }

    @Test
    fun `GIVEN import succeeded state WHEN composable is invoked THEN clear suppress lock action is dispatched`() {
        setContent(LoginsImportState.ImportSuccess)

        captureMiddleware.assertLastAction(SuppressAction.ClearNextSuppress::class)
    }

    @Test
    fun `GIVEN import failed state WHEN composable is invoked THEN clear suppress lock action is dispatched`() {
        setContent(LoginsImportState.ImportFailed)

        captureMiddleware.assertLastAction(SuppressAction.ClearNextSuppress::class)
    }

    private fun setContent(loginsImportState: LoginsImportState) {
        val loginsStore = LoginsStore(initialState = LoginsState.default.copy(loginsImportState = loginsImportState))
        val secureScreenStore = SecureScreenStore(middleware = listOf(captureMiddleware))

        composeTestRule.setContent {
            SuppressLockDuringImport(
                loginsStore = loginsStore,
                secureScreenStore = secureScreenStore,
            )
        }
        composeTestRule.waitForIdle()
    }
}
