/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package mozilla.components.feature.pictureinpicture

import android.app.PictureInPictureParams
import android.os.Build
import android.util.Rational
import android.view.ViewGroup
import androidx.annotation.IdRes
import androidx.annotation.RequiresApi
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import mozilla.components.browser.state.selector.findTabOrCustomTabOrSelectedTab
import mozilla.components.browser.state.state.PictureInPictureSource
import mozilla.components.browser.state.state.SessionState
import mozilla.components.browser.state.store.BrowserStore
import mozilla.components.concept.engine.Engine
import mozilla.components.concept.engine.EngineView
import mozilla.components.concept.engine.mediasession.MediaSession
import mozilla.components.feature.pictureinpicture.ext.tryEnterPictureInPictureMode
import mozilla.components.feature.session.SessionUseCases
import mozilla.components.lib.state.ext.flowScoped
import mozilla.components.support.base.feature.ViewBoundFeatureWrapper

/**
 * Shows a fullscreen video moving into picture-in-picture in a window over the browser [activity], while the browser
 * itself is in picture-in-picture mode, since a backgrounded app can't start its own activity.
 *
 * @param activity The browser activity the window is shown over.
 * @param store The store the video is handed over through.
 * @param engine The engine rendering the video.
 * @param pictureInPictureUseCases Asks the engine for the video of a tab and closes the window.
 * @param sessionUseCases Takes the video out of fullscreen before it moves into the window.
 * @param tabId The ID of the tab the browser shows, or null for the selected tab.
 * @param containerViewId The ID of the view in [activity] the window is added to.
 * @param mainDispatcher Dispatcher the browser state is observed on.
 */
class FullScreenPictureInPictureFeature(
    private val activity: AppCompatActivity,
    private val store: BrowserStore,
    private val engine: Engine,
    private val pictureInPictureUseCases: PictureInPictureUseCases,
    private val sessionUseCases: SessionUseCases,
    private val tabId: String?,
    @param:IdRes private val containerViewId: Int = android.R.id.content,
    private val mainDispatcher: CoroutineDispatcher = Dispatchers.Main,
) : DefaultLifecycleObserver {
    private val pictureInPictureSessionFeature = ViewBoundFeatureWrapper<PictureInPictureSessionFeature>()
    private var engineView: EngineView? = null
    private var scope: CoroutineScope? = null

    override fun onCreate(owner: LifecycleOwner) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            return
        }
        scope =
            store.flowScoped(owner, mainDispatcher) { flow ->
                flow
                    .map { state ->
                        state.findTabOrCustomTabOrSelectedTab(tabId)?.hasFullScreenVideo() == true
                    }
                    .distinctUntilChanged()
                    .collect { hasFullScreenVideo -> setAutoEnterPictureInPicture(hasFullScreenVideo) }
            }
    }

    /**
     * Should be called when the user presses home to put the browser in picture-in-picture mode if a fullscreen video
     * plays.
     */
    fun onHomePressed(): Boolean {
        return store.state.findTabOrCustomTabOrSelectedTab(tabId)?.hasFullScreenVideo() == true &&
            activity.tryEnterPictureInPictureMode()
    }

    /**
     * Should be called when the activity goes into or out of picture-in-picture mode.
     *
     * @param isInPictureInPictureMode True if the activity is in picture-in-picture mode.
     */
    fun onPictureInPictureModeChanged(isInPictureInPictureMode: Boolean) {
        if (isInPictureInPictureMode) {
            moveFullScreenVideoToPiPWindow()
        }
        val currentFeature = pictureInPictureSessionFeature.get() ?: return
        currentFeature.onPictureInPictureModeChanged(isInPictureInPictureMode)
        if (!isInPictureInPictureMode) {
            close()
        }
    }

    private fun moveFullScreenVideoToPiPWindow() {
        val window = store.state.pictureInPictureWindow
        if (window.session != null || window.requestedTabId != null) {
            return
        }
        val tab = store.state.findTabOrCustomTabOrSelectedTab(tabId)?.takeIf { it.hasFullScreenVideo() } ?: return
        sessionUseCases.exitFullscreen(tab.id)
        open(tab.id)
    }

    /** Opens the window over the browser, asking the engine for the video of the tab with ID [tabId]. */
    private fun open(tabId: String) {
        val view = engine.createView(activity)
        // pictureInPictureSessionFeature needs to render the session cloning the video to a view, so we add a child
        // view to the container view, while the picture-in-picture window is up and remove it when closed.
        activity.findViewById<ViewGroup>(containerViewId).addView(view.asView())
        engineView = view
        pictureInPictureUseCases.request(tabId, PictureInPictureSource.FULLSCREEN)
        pictureInPictureSessionFeature.set(
            PictureInPictureSessionFeature(
                store = store,
                engineView = view,
                mainDispatcher = mainDispatcher,
                onVideoGone = ::onVideoGone,
                pictureInPictureUseCases = pictureInPictureUseCases,
            ),
            owner = activity,
            view = view.asView(),
        )
    }

    override fun onDestroy(owner: LifecycleOwner) {
        scope?.cancel()
        scope = null
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            setAutoEnterPictureInPicture(false)
        }
        close()
    }

    /** Takes the browser out of sight once the video it was showing in picture-in-picture is gone. */
    private fun onVideoGone() {
        close()
        if (activity.isInPictureInPictureMode) {
            activity.moveTaskToBack(false)
        }
    }

    private fun close() {
        val view = engineView ?: return
        engineView = null
        pictureInPictureSessionFeature.clear()
        (view.asView().parent as? ViewGroup)?.removeView(view.asView())
        view.release()
    }

    /** Lets the activity enter picture-in-picture mode by itself while a fullscreen video plays and user leaves app. */
    @RequiresApi(Build.VERSION_CODES.S)
    private fun setAutoEnterPictureInPicture(enabled: Boolean) {
        activity.setPictureInPictureParams(
            PictureInPictureParams.Builder()
                .setAutoEnterEnabled(enabled)
                .build()
        )
    }

    private fun SessionState.hasFullScreenVideo() =
        content.fullScreen && mediaSessionState?.playbackState == MediaSession.PlaybackState.PLAYING
}
