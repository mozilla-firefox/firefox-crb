/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.fenix.settings.biometric.ui.state

import mozilla.components.lib.state.Action

/**
 * This sealed interface represents all possible user actions or events that can occur on the secure screen. These
 * actions are dispatched to the store to trigger state changes.
 */
sealed interface SecureScreenAction : Action {

    /** Represents actions related to the Android component lifecycle. */
    sealed interface LifecycleAction : SecureScreenAction {
        /** Dispatched when the component is paused. */
        data object OnPause : LifecycleAction

        /** Dispatched when the component is resumed. */
        data object OnResume : LifecycleAction

        /** Dispatched when the component is disposed or destroyed. */
        data object OnDispose : LifecycleAction
    }

    /** Represents actions related to the biometric/authentication flow. */
    sealed interface AuthenticationFlowAction : SecureScreenAction {
        /** Dispatched when the authentication process has started. */
        data object Started : AuthenticationFlowAction

        /** Dispatched when the authentication was successful. */
        data object Succeeded : AuthenticationFlowAction

        /** Dispatched when the authentication has failed. */
        data object Failed : AuthenticationFlowAction
    }

    /** Represents actions initiated by the user on the unlock screen UI. */
    sealed interface UnlockScreenAction : SecureScreenAction {
        /** Dispatched when the user taps the "Unlock" button. */
        data object UnlockTapped : UnlockScreenAction

        /** Dispatched when the user taps the "Leave" or exit button. */
        data object LeaveTapped : UnlockScreenAction
    }

    /** Actions related to the lock suppression functionality */
    sealed interface SuppressAction : SecureScreenAction {
        /**
         * Suppresses the next lock invocation: when users are importing passwords, asking them to re-authenticate right
         * after they left the app to select a file for import makes for poor UX, as the ongoing importing flow will be
         * blocked by the authentication prompt. We want to make an exception for that use case.
         */
        data object SuppressNextLock : SuppressAction

        /**
         * Overrides the suppressed lock invocation: if the user has left the app for more than they reasonably need for
         * selecting a file for import, we want to lock the logins screen as a security measure.
         */
        data object OverrideSuppressedLock : SuppressAction

        /**
         * Explicitly clears the suppression flag: ideally, we would have relied on the lifecycle methods for this, but
         * there is a small delay before they are being invoked, so it is possible to briefly leave the app for the file
         * picker and get back (a really quick person could select a file in that time frame) without triggering any
         * lifecycle events. So we should be resetting the flag manually, observing the file picker state.
         */
        data object ClearNextSuppress : SuppressAction
    }
}
