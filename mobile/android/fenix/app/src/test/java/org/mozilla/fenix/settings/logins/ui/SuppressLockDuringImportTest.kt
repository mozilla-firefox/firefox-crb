/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.fenix.settings.logins.ui

import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import mozilla.components.concept.fileimporter.FileImporterError
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.mozilla.fenix.settings.biometric.ui.state.BiometricAuthenticationState
import org.mozilla.fenix.settings.biometric.ui.state.SecureScreenState
import org.mozilla.fenix.settings.biometric.ui.state.SecureScreenStore

@RunWith(AndroidJUnit4::class)
class SuppressLockDuringImportTest {
    @get:Rule val composeTestRule = createComposeRule()

    private lateinit var loginsStore: LoginsStore
    private lateinit var secureScreenStore: SecureScreenStore

    @Before
    fun setup() {
        loginsStore = LoginsStore()
        secureScreenStore =
            SecureScreenStore(
                initialState = SecureScreenState(authenticationState = BiometricAuthenticationState.Authorized)
            )

        composeTestRule.setContent {
            SuppressLockDuringImport(
                loginsStore = loginsStore,
                secureScreenStore = secureScreenStore,
            )
        }
    }

    @Test
    fun `WHEN the file picker is opening THEN the next lock is suppressed`() {
        loginsStore.dispatch(ImportAction.ImportFileClicked)
        composeTestRule.waitForIdle()

        assertTrue(secureScreenStore.state.shouldSuppressNextLock)
    }

    @Test
    fun `WHEN the import is cancelled THEN the suppression is cleared`() {
        loginsStore.dispatch(ImportAction.ImportFileClicked)
        composeTestRule.waitForIdle()
        assertTrue(secureScreenStore.state.shouldSuppressNextLock)

        loginsStore.dispatch(ImportAction.ImportCancelled)
        composeTestRule.waitForIdle()

        assertFalse(secureScreenStore.state.shouldSuppressNextLock)
    }

    @Test
    fun `GIVEN the file picker was opened WHEN the import starts THEN the suppression is cleared`() {
        loginsStore.dispatch(ImportAction.ImportFileClicked)
        composeTestRule.waitForIdle()
        assertTrue(secureScreenStore.state.shouldSuppressNextLock)

        loginsStore.dispatch(ImportAction.ImportStarted)
        composeTestRule.waitForIdle()

        assertFalse(secureScreenStore.state.shouldSuppressNextLock)
    }

    @Test
    fun `GIVEN the file picker is opening WHEN the import succeeds THEN the suppression is cleared`() {
        loginsStore.dispatch(ImportAction.ImportFileClicked)
        composeTestRule.waitForIdle()
        assertTrue(secureScreenStore.state.shouldSuppressNextLock)

        loginsStore.dispatch(ImportAction.ImportSucceeded(count = 1))
        composeTestRule.waitForIdle()

        assertFalse(secureScreenStore.state.shouldSuppressNextLock)
    }

    @Test
    fun `GIVEN the file picker is opening WHEN the import fails THEN the suppression is cleared`() {
        loginsStore.dispatch(ImportAction.ImportFileClicked)
        composeTestRule.waitForIdle()
        assertTrue(secureScreenStore.state.shouldSuppressNextLock)

        loginsStore.dispatch(ImportAction.ImportFailed(FileImporterError.ReadError))
        composeTestRule.waitForIdle()

        assertFalse(secureScreenStore.state.shouldSuppressNextLock)
    }

    @Test
    fun `WHEN no import is happening THEN the next lock is not suppressed`() {
        composeTestRule.waitForIdle()

        assertFalse(secureScreenStore.state.shouldSuppressNextLock)
    }
}
