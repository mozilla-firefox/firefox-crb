/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package mozilla.components.browser.state.reducer

import mozilla.components.browser.state.action.PictureInPictureAction
import mozilla.components.browser.state.state.BrowserState
import mozilla.components.browser.state.state.PictureInPictureSession
import mozilla.components.browser.state.state.PictureInPictureWindowState

internal object PictureInPictureStateReducer {
    fun reduce(state: BrowserState, action: PictureInPictureAction): BrowserState =
        when (action) {
            is PictureInPictureAction.RequestAction ->
                state.copyWithPictureInPictureWindow { window ->
                    window.copy(requestedTabId = action.tabId, requestedSource = action.source)
                }
            is PictureInPictureAction.ConsumeRequestAction ->
                state.copyWithPictureInPictureWindow { window ->
                    if (window.requestedTabId == action.tabId) {
                        window.copy(requestedTabId = null, requestedSource = null)
                    } else {
                        window
                    }
                }
            is PictureInPictureAction.EnterAction ->
                state.copyWithPictureInPictureWindow { window ->
                    val source = window.requestedSource.takeIf { window.requestedTabId == action.tabId }
                    window.copy(session = PictureInPictureSession(action.tabId, action.engineSession, source))
                }
            is PictureInPictureAction.ExitAction ->
                state.copyWithPictureInPictureWindow { window ->
                    window.copy(session = window.session?.takeUnless { it.tabId == action.tabId })
                }
            is PictureInPictureAction.CloseWindowAction ->
                state.copyWithPictureInPictureWindow { PictureInPictureWindowState() }
        }

    private inline fun BrowserState.copyWithPictureInPictureWindow(
        crossinline update: (PictureInPictureWindowState) -> PictureInPictureWindowState
    ): BrowserState = copy(pictureInPictureWindow = update(pictureInPictureWindow))
}
