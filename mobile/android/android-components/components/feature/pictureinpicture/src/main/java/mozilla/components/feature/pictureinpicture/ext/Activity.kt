/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package mozilla.components.feature.pictureinpicture.ext

import android.app.Activity
import android.app.PictureInPictureParams
import mozilla.components.support.base.log.logger.Logger

private val logger = Logger("PictureInPicture")

/**
 * Puts the activity in picture-in-picture mode, returning whether it went into it. Some devices refuse with an
 * [IllegalStateException] even when picture-in-picture is supported, which is logged instead of thrown.
 *
 * @param params The parameters of the picture-in-picture window.
 */
fun Activity.tryEnterPictureInPictureMode(
    params: PictureInPictureParams = PictureInPictureParams.Builder().build()
): Boolean =
    try {
        enterPictureInPictureMode(params)
    } catch (e: IllegalStateException) {
        logger.warn("Entering picture-in-picture mode failed", e)
        false
    }
