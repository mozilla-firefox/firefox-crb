/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.fenix.settings.biometric.ui.state

import kotlin.time.Duration.Companion.minutes
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import mozilla.components.support.test.middleware.CaptureActionsMiddleware
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import org.mozilla.fenix.settings.biometric.ui.state.SecureScreenAction.LifecycleAction
import org.mozilla.fenix.settings.biometric.ui.state.SecureScreenAction.SuppressAction

class SuppressOverrideMiddlewareTest {
    private val overrideAfter = 2.minutes
    private lateinit var captureMiddleware: CaptureActionsMiddleware<SecureScreenState, SecureScreenAction>
    private val testDispatcher = StandardTestDispatcher()

    @Before
    fun setup() {
        captureMiddleware = CaptureActionsMiddleware()
    }

    @Test
    fun `GIVEN the lock is suppressed WHEN the user is away for longer than the override timeout THEN we require re-authentication`() =
        runTest(testDispatcher) {
            val store = buildSecureScreenStore(shouldSuppressNextLock = true, scope = this)

            store.dispatch(LifecycleAction.OnPause)
            testScheduler.advanceTimeBy(overrideAfter + 1.seconds)
            testScheduler.runCurrent()

            captureMiddleware.assertLastAction(SuppressAction.OverrideSuppressedLock::class)
            assertEquals(BiometricAuthenticationState.ReadyToLock, store.state.authenticationState)
        }

    @Test
    fun `GIVEN the lock is suppressed WHEN the user comes back before the override timeout THEN we do not require re-authentication`() =
        runTest(testDispatcher) {
            val store = buildSecureScreenStore(shouldSuppressNextLock = true, scope = this)

            store.dispatch(LifecycleAction.OnPause)
            testScheduler.advanceTimeBy(overrideAfter / 2)
            store.dispatch(LifecycleAction.OnResume)
            testScheduler.advanceTimeBy(overrideAfter)
            testScheduler.runCurrent()

            captureMiddleware.assertNotDispatched(SuppressAction.OverrideSuppressedLock::class)
            assertEquals(BiometricAuthenticationState.Authorized, store.state.authenticationState)
        }

    @Test
    fun `GIVEN the lock is not suppressed WHEN the user is away for longer than the override timeout THEN nothing is dispatched`() =
        runTest(testDispatcher) {
            val store = buildSecureScreenStore(shouldSuppressNextLock = false, scope = this)

            store.dispatch(LifecycleAction.OnPause)
            testScheduler.advanceTimeBy(overrideAfter + 1.seconds)
            testScheduler.runCurrent()

            captureMiddleware.assertNotDispatched(SuppressAction.OverrideSuppressedLock::class)
            assertEquals(BiometricAuthenticationState.ReadyToLock, store.state.authenticationState)
        }

    private fun buildSecureScreenStore(
        shouldSuppressNextLock: Boolean,
        scope: TestScope,
    ) =
        SecureScreenStore(
            initialState =
                SecureScreenState(
                    authenticationState = BiometricAuthenticationState.Authorized,
                    shouldSuppressNextLock = shouldSuppressNextLock,
                ),
            middleware =
                listOf(
                    captureMiddleware,
                    SuppressOverrideMiddleware(
                        overrideAfter = overrideAfter,
                        waitScope = scope,
                    ),
                ),
        )
}
