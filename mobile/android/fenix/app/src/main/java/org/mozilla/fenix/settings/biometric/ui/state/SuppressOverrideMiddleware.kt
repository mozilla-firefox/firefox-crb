/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.fenix.settings.biometric.ui.state

import kotlin.time.Duration
import kotlin.time.Duration.Companion.minutes
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import mozilla.components.lib.state.Middleware
import mozilla.components.lib.state.Store
import mozilla.components.support.base.coroutines.Dispatchers as MozillaDispatchers
import org.mozilla.fenix.settings.biometric.ui.state.SecureScreenAction.LifecycleAction

/**
 * A middleware adding an override to the suppression mechanism for the [SecureScreenStore]. If the user has left the
 * app for more than [overrideAfter], we override the suppressed-for-convenience lock, and ask the user to
 * re-authenticate when they get back to the password screen.
 */
class SuppressOverrideMiddleware(
    private val overrideAfter: Duration = 2.minutes,
    private val waitScope: CoroutineScope = CoroutineScope(MozillaDispatchers.Cached),
) : Middleware<SecureScreenState, SecureScreenAction> {
    private var clearJob: Job? = null

    override fun invoke(
        store: Store<SecureScreenState, SecureScreenAction>,
        next: (SecureScreenAction) -> Unit,
        action: SecureScreenAction,
    ) {
        next(action)

        when (action) {
            is LifecycleAction.OnPause -> {
                if (store.state.authenticationState == BiometricAuthenticationState.NextLockSuppressed) {
                    clearJob?.cancel()
                    clearJob = waitScope.launch {
                        delay(overrideAfter)
                        store.dispatch(SecureScreenAction.SuppressAction.OverrideSuppressedLock)
                    }
                }
            }
            is LifecycleAction.OnResume -> {
                clearJob?.cancel()
            }

            else -> {
                // no-op
            }
        }
    }
}
