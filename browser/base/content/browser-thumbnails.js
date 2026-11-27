/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Keeps thumbnails of open web pages up-to-date.
 */
class BrowserThumbnails {
  #captureDelayMS = 1000;

  /**
   * Map of capture() timeouts assigned to their browsers.
   */
  #timeouts = null;

  /**
   * Top site URLs refresh timer.
   */
  #topSiteURLsRefreshTimer = null;

  /**
   * List of tab events we want to listen for.
   */
  #tabEvents = ["TabClose", "TabSelect"];

  #window;

  /**
   * @param {Window} window The browser window whose tabs this keeps
   *   thumbnails of.
   */
  constructor(window) {
    this.#window = window;
    ChromeUtils.defineLazyGetter(this, "_topSiteURLs", () =>
      this.#getTopSiteURLs()
    );
  }

  init() {
    let { gBrowser } = this.#window;
    gBrowser.addTabsProgressListener(this);

    this.#tabEvents.forEach(function (aEvent) {
      gBrowser.tabContainer.addEventListener(aEvent, this);
    }, this);

    this.#timeouts = new WeakMap();
  }

  uninit() {
    let { gBrowser } = this.#window;
    gBrowser.removeTabsProgressListener(this);

    if (this.#topSiteURLsRefreshTimer) {
      this.#topSiteURLsRefreshTimer.cancel();
      this.#topSiteURLsRefreshTimer = null;
    }

    this.#tabEvents.forEach(function (aEvent) {
      gBrowser.tabContainer.removeEventListener(aEvent, this);
    }, this);
  }

  handleEvent(aEvent) {
    switch (aEvent.type) {
      case "scroll": {
        let browser = aEvent.currentTarget;
        if (this.#timeouts.has(browser)) {
          this.#delayedCapture(browser);
        }
        break;
      }
      case "TabSelect":
        this.#delayedCapture(aEvent.target.linkedBrowser);
        break;
      case "TabClose": {
        this.#cancelDelayedCapture(aEvent.target.linkedBrowser);
        break;
      }
    }
  }

  clearTopSiteURLCache() {
    if (this.#topSiteURLsRefreshTimer) {
      this.#topSiteURLsRefreshTimer.cancel();
      this.#topSiteURLsRefreshTimer = null;
    }
    // Delete the defined property
    delete this._topSiteURLs;
    ChromeUtils.defineLazyGetter(this, "_topSiteURLs", () =>
      this.#getTopSiteURLs()
    );
  }

  notify() {
    this.#topSiteURLsRefreshTimer = null;
    this.clearTopSiteURLCache();
  }

  /**
   * State change progress listener for all tabs.
   */
  onStateChange(aBrowser, aWebProgress, aRequest, aStateFlags, _aStatus) {
    if (
      aStateFlags & Ci.nsIWebProgressListener.STATE_STOP &&
      aStateFlags & Ci.nsIWebProgressListener.STATE_IS_NETWORK
    ) {
      this.#delayedCapture(aBrowser);
    }
  }

  async #capture(aBrowser) {
    // Only capture about:newtab top sites.
    const topSites = await this._topSiteURLs;
    if (!aBrowser.currentURI || !topSites.includes(aBrowser.currentURI.spec)) {
      return;
    }
    if (await this.#shouldCapture(aBrowser)) {
      await PageThumbs.captureAndStoreIfStale(aBrowser);
    }
  }

  #delayedCapture(aBrowser) {
    if (this.#timeouts.has(aBrowser)) {
      this.#cancelDelayedCallbacks(aBrowser);
    } else {
      aBrowser.addEventListener("scroll", this, true);
    }

    let idleCallback = () => {
      this.#cancelDelayedCapture(aBrowser);
      this.#capture(aBrowser);
    };

    // setTimeout to set a guarantee lower bound for the requestIdleCallback
    // (and therefore the delayed capture)
    let timeoutId = this.#window.setTimeout(() => {
      let idleCallbackId = this.#window.requestIdleCallback(idleCallback, {
        timeout: this.#captureDelayMS * 30,
      });
      this.#timeouts.set(aBrowser, { isTimeout: false, id: idleCallbackId });
    }, this.#captureDelayMS);

    this.#timeouts.set(aBrowser, { isTimeout: true, id: timeoutId });
  }

  async #shouldCapture(aBrowser) {
    let { gBrowser } = this.#window;
    // Capture only if it's the currently selected tab and not an about: page.
    if (
      aBrowser != gBrowser.selectedBrowser ||
      gBrowser.currentURI.schemeIs("about")
    ) {
      return false;
    }
    return PageThumbs.shouldStoreThumbnail(aBrowser);
  }

  #cancelDelayedCapture(aBrowser) {
    if (this.#timeouts.has(aBrowser)) {
      aBrowser.removeEventListener("scroll", this);
      this.#cancelDelayedCallbacks(aBrowser);
      this.#timeouts.delete(aBrowser);
    }
  }

  #cancelDelayedCallbacks(aBrowser) {
    let timeoutData = this.#timeouts.get(aBrowser);

    if (timeoutData.isTimeout) {
      this.#window.clearTimeout(timeoutData.id);
    } else {
      // idle callback dispatched
      this.#window.cancelIdleCallback(timeoutData.id);
    }
  }

  async #getTopSiteURLs() {
    // The _topSiteURLs getter can be expensive to run, but its return value can
    // change frequently on new profiles, so as a compromise we cache its return
    // value as a lazy getter for 1 minute every time it's called.
    this.#topSiteURLsRefreshTimer = Cc["@mozilla.org/timer;1"].createInstance(
      Ci.nsITimer
    );
    this.#topSiteURLsRefreshTimer.initWithCallback(
      this,
      60 * 1000,
      Ci.nsITimer.TYPE_ONE_SHOT
    );
    let sites = [];
    // Get both the top sites returned by the query, and also any pinned sites
    // that the user might have added manually that also need a screenshot.
    // Also include top sites that don't have rich icons
    let topSites = await NewTabUtils.activityStreamLinks.getTopSites();
    sites.push(...topSites.filter(link => !(link.faviconSize >= 96)));
    sites.push(...NewTabUtils.pinnedLinks.links);
    return sites.reduce((urls, link) => {
      if (link) {
        urls.push(link.url);
      }
      return urls;
    }, []);
  }
}

var gBrowserThumbnails = new BrowserThumbnails(window);
