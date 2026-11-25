/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.gecko.gfx;

import org.mozilla.gecko.gfx.GeckoSurface;
import org.mozilla.gecko.gfx.IImageReaderFrameCallback;

interface ISurfaceAllocator {
    GeckoSurface acquireSurface(in int width, in int height, in boolean singleBufferMode);
    GeckoSurface acquireImageReaderSurface(in IImageReaderFrameCallback callback);
    void releaseSurface(in long handle);
    oneway void beginImageReaderDormancyFlush(
        in long handle, in long request, in long frameId, in long deadlineMs);
    oneway void endImageReaderDormancyFlush(in long handle, in long request);
    void releaseImageReaderSurface(in long handle, in boolean graceful);
    void maybeRenderImageReaderFirstFrame(in long handle, in long frameId);
    oneway void notifyImageReaderFrameReleaseFailed(in long handle, in long frameId);
}
