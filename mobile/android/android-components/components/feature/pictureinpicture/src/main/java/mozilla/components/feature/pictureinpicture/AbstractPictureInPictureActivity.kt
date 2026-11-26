/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package mozilla.components.feature.pictureinpicture

import android.app.PictureInPictureParams
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.os.Bundle
import android.util.Rational
import androidx.appcompat.app.AppCompatActivity
import mozilla.components.browser.state.selector.findCustomTab
import mozilla.components.browser.state.store.BrowserStore
import mozilla.components.concept.engine.Engine
import mozilla.components.support.base.feature.ViewBoundFeatureWrapper
import mozilla.components.support.base.log.logger.Logger
import mozilla.components.support.utils.SwitchTabIntent

/**
 * Shows the video in a native picture-in-picture window of its own, once its session has arrived. Started by
 * [PictureInPictureWindowFeature].
 */
abstract class AbstractPictureInPictureActivity : AppCompatActivity() {
    protected abstract val store: BrowserStore
    protected abstract val engine: Engine
    protected abstract val pictureInPictureUseCases: PictureInPictureUseCases

    private val logger = Logger("PictureInPictureActivity")

    private val pictureInPictureSessionFeature = ViewBoundFeatureWrapper<PictureInPictureSessionFeature>()

    /**
     * Invoked when the user expands the window, to bring the browser back on the tab the video came from. Unless the
     * video came from a custom tab, defaults to launching the app with a [SwitchTabIntent], which the app has to
     * handle.
     *
     * @param tabId The ID of the tab the video came from.
     */
    protected open fun onReturnToTab(tabId: String) {
        if (store.state.findCustomTab(tabId) != null) {
            return
        }
        val intent =
            packageManager.getLaunchIntentForPackage(packageName)?.apply {
                action = SwitchTabIntent.ACTION_SWITCH_TAB
                putExtra(SwitchTabIntent.EXTRA_TAB_ID, tabId)
            } ?: return
        startActivity(intent)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        if (store.state.pictureInPictureWindow.session == null) {
            logger.debug("No session to show, finishing")
            finish()
            return
        }
        val engineView = engine.createView(this)
        setContentView(engineView.asView())
        pictureInPictureSessionFeature.set(
            PictureInPictureSessionFeature(
                store = store,
                engineView = engineView,
                onVideoGone = ::finish,
                onReturnToTab = ::onReturnToTab,
                pictureInPictureUseCases = pictureInPictureUseCases,
            ),
            owner = this,
            view = engineView.asView(),
        )
    }

    override fun onResume() {
        super.onResume()
        if (isInPictureInPictureMode || isFinishing) {
            return
        }
        if (!tryEnterPictureInPictureMode()) {
            logger.debug("Refused picture-in-picture mode, finishing")
            finish()
        }
    }

    private fun tryEnterPictureInPictureMode(): Boolean =
        try {
            try {
                enterPictureInPictureMode(buildPipParams(withAspectRatio = true))
            } catch (e: IllegalArgumentException) {
                // https://cs.android.com/android/platform/superproject/main/+/main:frameworks/base/services/core/java/com/android/server/wm/ActivityClientController.java;drc=2567782fb32058a912e3cdf752d612ede280cc38;l=1076
                logger.warn("Aspect ratio refused, entering picture-in-picture mode without it", e)
                enterPictureInPictureMode(buildPipParams(withAspectRatio = false))
            }
        } catch (e: IllegalStateException) {
            logger.warn("Entering picture-in-picture mode failed", e)
            false
        }

    override fun onPictureInPictureModeChanged(isInPictureInPictureMode: Boolean, newConfig: Configuration) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)
        pictureInPictureSessionFeature.get()?.onPictureInPictureModeChanged(isInPictureInPictureMode)
        if (!isInPictureInPictureMode) {
            finish()
        }
    }

    private fun buildPipParams(withAspectRatio: Boolean): PictureInPictureParams {
        val session = store.state.pictureInPictureWindow.session
        val aspectRatio = session?.takeIf { withAspectRatio }?.let { aspectRatioFor(it.videoWidth, it.videoHeight) }
        return PictureInPictureParams.Builder().setAspectRatio(aspectRatio).build()
    }

    internal companion object {
        // https://developer.android.com/reference/android/app/PictureInPictureParams.Builder#setAspectRatio(android.util.Rational)
        private val MIN_ASPECT_RATIO = Rational(100, 239)
        private val MAX_ASPECT_RATIO = Rational(239, 100)

        /**
         * Returns the aspect ratio of a [width] by [height] video, clamped to the range Android accepts for a
         * picture-in-picture window, or null if the size is unknown.
         */
        fun aspectRatioFor(width: Int, height: Int): Rational? {
            if (width <= 0 || height <= 0) {
                return null
            }
            val ratio = Rational(width, height)
            return when {
                ratio < MIN_ASPECT_RATIO -> MIN_ASPECT_RATIO
                ratio > MAX_ASPECT_RATIO -> MAX_ASPECT_RATIO
                else -> ratio
            }
        }

        /** Creates the intent starting [activityClass]. */
        fun createIntent(context: Context, activityClass: Class<out AbstractPictureInPictureActivity>): Intent =
            Intent(context, activityClass).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }
}
