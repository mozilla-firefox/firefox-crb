/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package mozilla.components.feature.pictureinpicture

import android.util.Rational
import androidx.test.ext.junit.runners.AndroidJUnit4
import mozilla.components.feature.pictureinpicture.AbstractPictureInPictureActivity.Companion.aspectRatioFor
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class AbstractPictureInPictureActivityTest {
    @Test
    fun `GIVEN an unknown video size WHEN aspectRatioFor is called THEN it returns null`() {
        assertNull(aspectRatioFor(0, 0))
        assertNull(aspectRatioFor(0, 1080))
        assertNull(aspectRatioFor(1920, 0))
        assertNull(aspectRatioFor(-1920, 1080))
    }

    @Test
    fun `GIVEN a video size within the allowed range WHEN aspectRatioFor is called THEN it returns the video ratio`() {
        assertEquals(Rational(16, 9), aspectRatioFor(1920, 1080))
        assertEquals(Rational(9, 16), aspectRatioFor(1080, 1920))
        assertEquals(Rational(1, 1), aspectRatioFor(500, 500))
    }

    @Test
    fun `GIVEN a video size at the limits WHEN aspectRatioFor is called THEN it returns the limits`() {
        assertEquals(Rational(239, 100), aspectRatioFor(2390, 1000))
        assertEquals(Rational(100, 239), aspectRatioFor(1000, 2390))
    }

    @Test
    fun `GIVEN a video wider than allowed WHEN aspectRatioFor is called THEN it returns the maximum ratio`() {
        assertEquals(Rational(239, 100), aspectRatioFor(4000, 1000))
    }

    @Test
    fun `GIVEN a video taller than allowed WHEN aspectRatioFor is called THEN it returns the minimum ratio`() {
        assertEquals(Rational(100, 239), aspectRatioFor(1000, 4000))
    }
}
