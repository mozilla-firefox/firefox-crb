/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { GeckoViewActorParent } from "resource://gre/modules/GeckoViewActorParent.sys.mjs";

// Top-level documents that reported an eligible video in any frame.
const gDocumentsWithVideo = new WeakSet();

export class GeckoViewPictureInPictureSourceParent extends GeckoViewActorParent {
  receiveMessage(aMsg) {
    switch (aMsg.name) {
      case "PictureInPicture:UpdateEligiblePipVideoCount": {
        const { pipCount, pipDisabledCount } = aMsg.data;
        const topWindowGlobal = this.browsingContext.top.currentWindowGlobal;
        if (
          pipCount <= pipDisabledCount ||
          !this.manager.isCurrentGlobal ||
          !topWindowGlobal ||
          gDocumentsWithVideo.has(topWindowGlobal)
        ) {
          break;
        }
        gDocumentsWithVideo.add(topWindowGlobal);
        this.eventDispatcher?.sendRequest(
          "GeckoView:PictureInPicture:VideoAvailable"
        );
        break;
      }
      case "GeckoView:PictureInPicture:PageShow":
        if (gDocumentsWithVideo.has(this.manager)) {
          this.eventDispatcher?.sendRequest(
            "GeckoView:PictureInPicture:VideoAvailable"
          );
        }
        break;
    }
    return null;
  }
}
