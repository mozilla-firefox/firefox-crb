/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.fenix.settings.biometric.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.mozilla.fenix.settings.biometric.ui.state.BiometricAuthenticationState
import org.mozilla.fenix.settings.biometric.ui.state.SecureScreenAction.AuthenticationFlowAction
import org.mozilla.fenix.settings.biometric.ui.state.SecureScreenAction.LifecycleAction
import org.mozilla.fenix.settings.biometric.ui.state.SecureScreenAction.SuppressAction
import org.mozilla.fenix.settings.biometric.ui.state.SecureScreenAction.UnlockScreenAction
import org.mozilla.fenix.settings.biometric.ui.state.SecureScreenState
import org.mozilla.fenix.settings.biometric.ui.state.secureScreenReducer

class SecureScreenReducerTest {

    @Test
    fun `WHEN authentication flow starts THEN authentication state is set to in progress`() {
        val result =
            secureScreenReducer(
                state = createState(BiometricAuthenticationState.Inert),
                action = AuthenticationFlowAction.Started,
            )

        assertEquals(
            BiometricAuthenticationState.InProgress,
            result.authenticationState,
        )
    }

    @Test
    fun `WHEN authentication flow succeeds THEN authentication state is set to authorized`() {
        val result =
            secureScreenReducer(
                state = createState(authenticationState = BiometricAuthenticationState.Inert),
                action = AuthenticationFlowAction.Succeeded,
            )

        assertEquals(
            BiometricAuthenticationState.Authorized,
            result.authenticationState,
        )
    }

    @Test
    fun `WHEN authentication flow fails THEN authentication state is set to failed`() {
        val result =
            secureScreenReducer(
                state = createState(authenticationState = BiometricAuthenticationState.Inert),
                action = AuthenticationFlowAction.Failed,
            )

        assertEquals(
            BiometricAuthenticationState.Failed,
            result.authenticationState,
        )
    }

    @Test
    fun `GIVEN previously ready to lock WHEN the lifecycle becomes resumed THEN authentication state is set to in progress`() {
        val result =
            secureScreenReducer(
                state = createState(authenticationState = BiometricAuthenticationState.ReadyToLock),
                action = LifecycleAction.OnResume,
            )

        assertEquals(
            BiometricAuthenticationState.InProgress,
            result.authenticationState,
        )
    }

    @Test
    fun `GIVEN previous state not ready to lock WHEN the lifecycle becomes resumed THEN authentication state is unchanged`() {
        val result =
            secureScreenReducer(
                state = createState(authenticationState = BiometricAuthenticationState.Authorized),
                action = LifecycleAction.OnResume,
            )

        assertEquals(
            BiometricAuthenticationState.Authorized,
            result.authenticationState,
        )
    }

    @Test
    fun `GIVEN previously authorized WHEN the lifecycle becomes paused THEN state is set to ready to lock`() {
        val result =
            secureScreenReducer(
                state = createState(authenticationState = BiometricAuthenticationState.Authorized),
                action = LifecycleAction.OnPause,
            )

        assertEquals(
            BiometricAuthenticationState.ReadyToLock,
            result.authenticationState,
        )
    }

    @Test
    fun `GIVEN a previous unauthorized state WHEN the lifecycle becomes paused THEN state remains unchanged`() {
        val result =
            secureScreenReducer(
                state = createState(authenticationState = BiometricAuthenticationState.Inert),
                action = LifecycleAction.OnPause,
            )

        assertEquals(
            BiometricAuthenticationState.Inert,
            result.authenticationState,
        )
    }

    @Test
    fun `GIVEN previous state WHEN the unlock action is received THEN authentication state is set to in progress`() {
        val result =
            secureScreenReducer(
                state = createState(authenticationState = BiometricAuthenticationState.ReadyToLock),
                action = UnlockScreenAction.UnlockTapped,
            )

        assertEquals(
            BiometricAuthenticationState.InProgress,
            result.authenticationState,
        )
    }

    @Test
    fun `WHEN the leave action is received THEN state is set to exit`() {
        val result =
            secureScreenReducer(
                state = createState(authenticationState = BiometricAuthenticationState.Inert),
                action = UnlockScreenAction.LeaveTapped,
            )

        assertTrue(result.shouldExit)
    }

    @Test
    fun `WHEN suppress next lock action is dispatched THEN suppress flag is recorded and state does not immediately change from Authorized`() {
        val result =
            secureScreenReducer(
                state = createState(authenticationState = BiometricAuthenticationState.Authorized),
                action = SuppressAction.SuppressNextLock,
            )

        assertTrue(result.shouldSuppressNextLock)
        assertEquals(BiometricAuthenticationState.Authorized, result.authenticationState)
    }

    @Test
    fun `GIVEN suppress next lock flag is set WHEN lifecycle moves into paused THEN state moves into next lock suppressed state and flag is reset`() {
        val shouldSuppressNextLock = true

        val result =
            secureScreenReducer(
                state =
                    createState(
                        authenticationState = BiometricAuthenticationState.Authorized,
                        shouldSuppressNextLock = shouldSuppressNextLock,
                    ),
                action = LifecycleAction.OnPause,
            )

        assertEquals(BiometricAuthenticationState.NextLockSuppressed, result.authenticationState)
        assertEquals(!shouldSuppressNextLock, result.shouldSuppressNextLock)
    }

    @Test
    fun `GIVEN next lock suppressed state WHEN lifecycle moves into resumed THEN user skips re-authentication once`() {
        val result =
            secureScreenReducer(
                state = createState(authenticationState = BiometricAuthenticationState.NextLockSuppressed),
                action = LifecycleAction.OnResume,
            )

        assertEquals(BiometricAuthenticationState.Authorized, result.authenticationState)
        assertFalse(result.shouldSuppressNextLock)
    }

    @Test
    fun `GIVEN suppress next lock flag is set WHEN clear suppression action is dispatched THEN flag is reset`() {
        val shouldSuppressNextLock = true

        val result =
            secureScreenReducer(
                state =
                    createState(
                        authenticationState = BiometricAuthenticationState.Authorized,
                        shouldSuppressNextLock = shouldSuppressNextLock,
                    ),
                action = SuppressAction.ClearNextSuppress,
            )

        assertEquals(!shouldSuppressNextLock, result.shouldSuppressNextLock)
    }

    @Test
    fun `GIVEN next lock suppressed state WHEN override suppression action is dispatched THEN state is set to ready to lock`() {
        val result =
            secureScreenReducer(
                state = createState(authenticationState = BiometricAuthenticationState.NextLockSuppressed),
                action = SuppressAction.OverrideSuppressedLock,
            )

        assertEquals(BiometricAuthenticationState.ReadyToLock, result.authenticationState)
    }

    @Test
    fun `GIVEN next lock suppressed state and suppress next lock flag is still set WHEN override suppression action is dispatched THEN state is set to ready to lock and lock is reset`() {
        val shouldSuppressNextLock = true

        val result =
            secureScreenReducer(
                state =
                    createState(
                        authenticationState = BiometricAuthenticationState.NextLockSuppressed,
                        shouldSuppressNextLock = shouldSuppressNextLock,
                    ),
                action = SuppressAction.OverrideSuppressedLock,
            )

        assertEquals(BiometricAuthenticationState.ReadyToLock, result.authenticationState)
        assertEquals(!shouldSuppressNextLock, result.shouldSuppressNextLock)
    }

    @Test
    fun `GIVEN the suppression was overridden WHEN the lifecycle becomes resumed THEN authentication state is set to in progress`() {
        val overridden =
            secureScreenReducer(
                state =
                    createState(
                        authenticationState = BiometricAuthenticationState.NextLockSuppressed,
                        shouldSuppressNextLock = true,
                    ),
                action = SuppressAction.OverrideSuppressedLock,
            )

        val result = secureScreenReducer(state = overridden, action = LifecycleAction.OnResume)

        assertEquals(BiometricAuthenticationState.InProgress, result.authenticationState)
    }

    private fun createState(
        authenticationState: BiometricAuthenticationState,
        shouldSuppressNextLock: Boolean = false,
    ): SecureScreenState {
        return SecureScreenState(
            authenticationState = authenticationState,
            shouldSuppressNextLock = shouldSuppressNextLock,
        )
    }
}
