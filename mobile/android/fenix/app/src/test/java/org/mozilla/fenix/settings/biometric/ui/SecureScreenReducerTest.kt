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
    fun `WHEN suppress next lock action is dispatched THEN the suppression flag is set`() {
        val result =
            secureScreenReducer(
                state = createState(authenticationState = BiometricAuthenticationState.Authorized),
                action = SuppressAction.SuppressNextLock,
            )

        assertTrue(result.shouldSuppressNextLock)
        assertEquals(BiometricAuthenticationState.Authorized, result.authenticationState)
    }

    @Test
    fun `GIVEN next lock should be suppressed WHEN clear suppression action is dispatched THEN suppression flag is reset`() {
        val result =
            secureScreenReducer(
                state =
                    createState(
                        authenticationState = BiometricAuthenticationState.Authorized,
                        shouldSuppressNextLock = true,
                    ),
                action = SuppressAction.ClearNextSuppress,
            )

        assertFalse(result.shouldSuppressNextLock)
    }

    @Test
    fun `GIVEN next lock should be suppressed WHEN override suppression action is dispatched THEN state is set to ready to lock and the suppression flag is reset`() {
        val result =
            secureScreenReducer(
                state =
                    createState(
                        authenticationState = BiometricAuthenticationState.NextLockSuppressed,
                        shouldSuppressNextLock = true,
                    ),
                action = SuppressAction.OverrideSuppressedLock,
            )

        assertEquals(BiometricAuthenticationState.ReadyToLock, result.authenticationState)
        assertFalse(result.shouldSuppressNextLock)
    }

    @Test
    fun `GIVEN next lock should be suppressed WHEN the lifecycle moves into paused THEN state reflects that next lock will be suppressed`() {
        val result =
            secureScreenReducer(
                state =
                    createState(
                        authenticationState = BiometricAuthenticationState.Authorized,
                        shouldSuppressNextLock = true,
                    ),
                action = LifecycleAction.OnPause,
            )

        assertEquals(BiometricAuthenticationState.NextLockSuppressed, result.authenticationState)
    }

    @Test
    fun `GIVEN suppress state WHEN the lifecycle moves into resumed THEN state changes to authorized`() {
        val result =
            secureScreenReducer(
                state = createState(authenticationState = BiometricAuthenticationState.NextLockSuppressed),
                action = LifecycleAction.OnResume,
            )

        assertEquals(BiometricAuthenticationState.Authorized, result.authenticationState)
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
