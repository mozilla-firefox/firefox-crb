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
    private val overrideSuppressionAfter = 2.minutes
    private val testDispatcher = StandardTestDispatcher()
    private lateinit var captureMiddleware: CaptureActionsMiddleware<SecureScreenState, SecureScreenAction>

    @Before
    fun setup() {
        captureMiddleware = CaptureActionsMiddleware()
    }

    @Test
    fun `GIVEN next lock suppressed state WHEN app is paused for longer than suppress timeouts THEN re-authentication is required`() =
        runTest(testDispatcher) {
            val store = buildSecureScreenStore(BiometricAuthenticationState.NextLockSuppressed, scope = this)

            store.dispatch(LifecycleAction.OnPause)
            testScheduler.advanceTimeBy(overrideSuppressionAfter + 1.seconds)
            testScheduler.runCurrent()

            captureMiddleware.assertLastAction(SuppressAction.OverrideSuppressedLock::class)
            assertEquals(BiometricAuthenticationState.ReadyToLock, store.state.authenticationState)
        }

    @Test
    fun `GIVEN next lock suppressed state WHEN app is resumed before the suppress timeouts THEN we do not require re-authentication`() =
        runTest(testDispatcher) {
            val store = buildSecureScreenStore(BiometricAuthenticationState.NextLockSuppressed, scope = this)

            store.dispatch(LifecycleAction.OnPause)
            testScheduler.advanceTimeBy(overrideSuppressionAfter / 2)
            store.dispatch(LifecycleAction.OnResume)
            testScheduler.advanceTimeBy(overrideSuppressionAfter)
            testScheduler.runCurrent()

            captureMiddleware.assertNotDispatched(SuppressAction.OverrideSuppressedLock::class)
            assertEquals(BiometricAuthenticationState.Authorized, store.state.authenticationState)
        }

    @Test
    fun `GIVEN state is not next lock suppressed WHEN app is paused THEN middleware dispatches nothing`() =
        runTest(testDispatcher) {
            listOf(
                    BiometricAuthenticationState.Inert,
                    BiometricAuthenticationState.ReadyToLock,
                    BiometricAuthenticationState.Authorized,
                    BiometricAuthenticationState.Failed,
                    BiometricAuthenticationState.InProgress,
                )
                .forEach { initialState ->
                    val store = buildSecureScreenStore(authenticationState = initialState, scope = this)

                    store.dispatch(LifecycleAction.OnPause)
                    testScheduler.advanceTimeBy(overrideSuppressionAfter + 1.seconds)
                    testScheduler.runCurrent()

                    captureMiddleware.assertNotDispatched(SuppressAction.OverrideSuppressedLock::class)
                }
        }

    private fun buildSecureScreenStore(
        authenticationState: BiometricAuthenticationState,
        // TODO not sure we need this
        shouldSuppressNextLock: Boolean = false,
        scope: TestScope,
    ) =
        SecureScreenStore(
            initialState =
                SecureScreenState(
                    authenticationState = authenticationState,
                    shouldSuppressNextLock = shouldSuppressNextLock,
                ),
            middleware =
                listOf(
                    captureMiddleware,
                    SuppressOverrideMiddleware(
                        overrideAfter = overrideSuppressionAfter,
                        waitScope = scope,
                    ),
                ),
        )
}
