/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { GeckoViewActorChild } from "resource://gre/modules/GeckoViewActorChild.sys.mjs";
import { GeckoViewUtils } from "resource://gre/modules/GeckoViewUtils.sys.mjs";

const { debug } = GeckoViewUtils.initLogging(
  "GeckoViewPictureInPictureSource[C]"
);

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  ContentDOMReference: "resource://gre/modules/ContentDOMReference.sys.mjs",
});

export class GeckoViewPictureInPictureSourceChild extends GeckoViewActorChild {
  receiveMessage(msg) {
    switch (msg.name) {
      case "GeckoView:PictureInPicture:FindVideo":
        return this.findVideo();
    }
    return null;
  }

  /**
   * The first video this frame is playing, in document order, or otherwise the
   * first paused one that has played, or otherwise the first paused one with a
   * frame to show. Null if there is none.
   *
   * @returns {?{videoRef: object, paused: boolean, played: boolean}}
   */
  findVideo() {
    const doc = this.document;
    if (!doc) {
      return null;
    }

    // A video with no dimensions has no frames to clone yet.
    const videos = [...doc.querySelectorAll("video")].filter(
      v => v.videoWidth > 0 && v.videoHeight > 0
    );
    // Prefer a playing video, then one that has played, then any with a frame to show.
    const video =
      videos.find(v => !v.paused) ??
      videos.find(v => !!v.played.length) ??
      videos.find(v => v.readyState >= v.HAVE_CURRENT_DATA);
    if (!video) {
      return null;
    }

    debug`findVideo: bcId=${this.browsingContext.id} paused=${video.paused} played=${video.played.length} readyState=${video.readyState} ${video.videoWidth}x${video.videoHeight}`;

    return {
      videoRef: lazy.ContentDOMReference.get(video),
      paused: video.paused,
      played: video.played.length > 0,
    };
  }
}
