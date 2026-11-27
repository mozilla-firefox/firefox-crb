/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package mozilla.components.feature.pictureinpicture

import android.app.PictureInPictureParams
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import androidx.appcompat.app.AppCompatActivity
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import mozilla.components.browser.state.action.BrowserAction
import mozilla.components.browser.state.action.ContentAction
import mozilla.components.browser.state.action.EngineAction
import mozilla.components.browser.state.action.MediaSessionAction
import mozilla.components.browser.state.action.PictureInPictureAction
import mozilla.components.browser.state.engine.EngineMiddleware
import mozilla.components.browser.state.state.BrowserState
import mozilla.components.browser.state.state.MediaSessionState
import mozilla.components.browser.state.state.PictureInPictureSource
import mozilla.components.browser.state.state.createTab
import mozilla.components.browser.state.store.BrowserStore
import mozilla.components.concept.engine.Engine
import mozilla.components.concept.engine.EngineView
import mozilla.components.concept.engine.mediasession.MediaSession
import mozilla.components.feature.session.SessionUseCases
import mozilla.components.support.test.any
import mozilla.components.support.test.middleware.CaptureActionsMiddleware
import mozilla.components.support.test.mock
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.mockito.Mockito.doReturn
import org.mockito.Mockito.never
import org.mockito.Mockito.verify
import org.robolectric.Robolectric

@RunWith(AndroidJUnit4::class)
class FullScreenPictureInPictureFeatureTest {
    private val testDispatcher = StandardTestDispatcher()
    private val captureActionsMiddleware = CaptureActionsMiddleware<BrowserState, BrowserAction>()
    private val engineView: EngineView = mock()
    private val engine: Engine = mock()
    private val store =
        BrowserStore(
            initialState =
                BrowserState(
                    tabs =
                        listOf(
                            createTab(
                                "https://www.mozilla.org",
                                id = "tab",
                                mediaSessionState = MediaSessionState(mock()),
                            )
                        ),
                    selectedTabId = "tab",
                ),
            middleware =
                listOf(captureActionsMiddleware) +
                    EngineMiddleware.create(engine = engine, scope = TestScope(testDispatcher)),
        )
    private lateinit var activity: TestActivity
    private lateinit var feature: FullScreenPictureInPictureFeature

    @Before
    fun setUp() {
        activity = Robolectric.buildActivity(TestActivity::class.java).setup().get()
        doReturn(View(activity)).`when`(engineView).asView()
        doReturn(engineView).`when`(engine).createView(any(), any())
        feature =
            FullScreenPictureInPictureFeature(
                activity = activity,
                store = store,
                engine = engine,
                pictureInPictureUseCases = PictureInPictureUseCases(store, TestScope(testDispatcher)),
                sessionUseCases = SessionUseCases(store),
                tabId = null,
                mainDispatcher = testDispatcher,
            )
        activity.lifecycle.addObserver(feature)
        advance()
    }

    @Test
    fun `GIVEN no fullscreen video WHEN the feature is created THEN auto-enter picture-in-picture is disabled`() {
        assertFalse(activity.lastPictureInPictureParams!!.isAutoEnterEnabled)
    }

    @Test
    fun `WHEN a video plays in fullscreen THEN auto-enter picture-in-picture is enabled`() {
        playFullScreenVideo()

        assertTrue(activity.lastPictureInPictureParams!!.isAutoEnterEnabled)
    }

    @Test
    fun `GIVEN a video plays in fullscreen WHEN it is paused THEN auto-enter picture-in-picture is disabled`() {
        playFullScreenVideo()

        setPlaybackState(MediaSession.PlaybackState.PAUSED)

        assertFalse(activity.lastPictureInPictureParams!!.isAutoEnterEnabled)
    }

    @Test
    fun `GIVEN a video plays in fullscreen WHEN fullscreen is exited THEN auto-enter picture-in-picture is disabled`() {
        playFullScreenVideo()

        store.dispatch(ContentAction.FullScreenChangedAction("tab", false))
        advance()

        assertFalse(activity.lastPictureInPictureParams!!.isAutoEnterEnabled)
    }

    @Test
    fun `GIVEN a video plays in fullscreen WHEN home is pressed THEN the activity enters picture-in-picture`() {
        playFullScreenVideo()

        assertTrue(feature.onHomePressed())
        assertEquals(1, activity.enterPictureInPictureCount)
    }

    @Test
    fun `GIVEN the activity refuses picture-in-picture WHEN home is pressed THEN it returns false`() {
        playFullScreenVideo()
        activity.enterPictureInPictureResult = false

        assertFalse(feature.onHomePressed())
    }

    @Test
    fun `GIVEN no fullscreen video WHEN home is pressed THEN the activity does not enter picture-in-picture`() {
        store.dispatch(ContentAction.FullScreenChangedAction("tab", true))
        advance()

        assertFalse(feature.onHomePressed())
        assertEquals(0, activity.enterPictureInPictureCount)
    }

    @Test
    fun `GIVEN a video plays in fullscreen WHEN the activity enters picture-in-picture THEN the video is moved into the window`() {
        playFullScreenVideo()

        enterPictureInPicture()

        captureActionsMiddleware.assertFirstAction(EngineAction.ExitFullScreenModeAction::class) {
            assertEquals("tab", it.tabId)
        }
        captureActionsMiddleware.assertFirstAction(PictureInPictureAction.RequestAction::class) {
            assertEquals("tab", it.tabId)
            assertEquals(PictureInPictureSource.FULLSCREEN, it.source)
        }
        assertEquals(activity.content, engineView.asView().parent)
    }

    @Test
    fun `GIVEN no fullscreen video WHEN the activity enters picture-in-picture THEN no video is requested`() {
        enterPictureInPicture()

        captureActionsMiddleware.assertNotDispatched(EngineAction.ExitFullScreenModeAction::class)
        captureActionsMiddleware.assertNotDispatched(PictureInPictureAction.RequestAction::class)
        verify(engine, never()).createView(any(), any())
    }

    @Test
    fun `GIVEN a video is already requested WHEN the activity enters picture-in-picture THEN no other video is requested`() {
        playFullScreenVideo()
        store.dispatch(PictureInPictureAction.RequestAction("tab", PictureInPictureSource.ADDRESS_BAR))
        captureActionsMiddleware.reset()

        enterPictureInPicture()

        captureActionsMiddleware.assertNotDispatched(PictureInPictureAction.RequestAction::class)
        verify(engine, never()).createView(any(), any())
    }

    @Test
    fun `GIVEN the video is in the window WHEN the activity leaves picture-in-picture THEN the window is closed`() {
        playFullScreenVideo()
        enterPictureInPicture()

        activity.inPictureInPicture = false
        feature.onPictureInPictureModeChanged(false)
        advance()

        assertNull(engineView.asView().parent)
        verify(engineView).release()
    }

    @Test
    fun `GIVEN the video is requested WHEN no video arrives THEN the window is closed and the browser moved back`() {
        playFullScreenVideo()
        enterPictureInPicture()

        store.dispatch(PictureInPictureAction.ConsumeRequestAction("tab"))
        advance()

        assertNull(engineView.asView().parent)
        verify(engineView).release()
        assertTrue(activity.movedTaskToBack)
    }

    @Test
    fun `GIVEN the video is in the window WHEN the activity is destroyed THEN the window is closed`() {
        playFullScreenVideo()
        enterPictureInPicture()

        feature.onDestroy(activity)

        assertNull(engineView.asView().parent)
        verify(engineView).release()
        assertFalse(activity.lastPictureInPictureParams!!.isAutoEnterEnabled)
    }

    private fun playFullScreenVideo() {
        store.dispatch(ContentAction.FullScreenChangedAction("tab", true))
        setPlaybackState(MediaSession.PlaybackState.PLAYING)
    }

    private fun setPlaybackState(playbackState: MediaSession.PlaybackState) {
        store.dispatch(MediaSessionAction.UpdateMediaPlaybackStateAction("tab", playbackState))
        advance()
    }

    private fun enterPictureInPicture() {
        activity.inPictureInPicture = true
        feature.onPictureInPictureModeChanged(true)
        advance()
    }

    private fun advance() {
        testDispatcher.scheduler.advanceUntilIdle()
    }

    private class TestActivity : AppCompatActivity() {
        lateinit var content: ViewGroup
        var lastPictureInPictureParams: PictureInPictureParams? = null
        var enterPictureInPictureResult = true
        var enterPictureInPictureCount = 0
        var inPictureInPicture = false
        var movedTaskToBack = false

        override fun onCreate(savedInstanceState: Bundle?) {
            setTheme(androidx.appcompat.R.style.Theme_AppCompat)
            super.onCreate(savedInstanceState)
            content = findViewById(android.R.id.content)
        }

        override fun setPictureInPictureParams(params: PictureInPictureParams) {
            lastPictureInPictureParams = params
        }

        override fun enterPictureInPictureMode(params: PictureInPictureParams): Boolean {
            enterPictureInPictureCount++
            return enterPictureInPictureResult
        }

        override fun isInPictureInPictureMode(): Boolean = inPictureInPicture

        override fun moveTaskToBack(nonRoot: Boolean): Boolean {
            movedTaskToBack = true
            return true
        }
    }
}
