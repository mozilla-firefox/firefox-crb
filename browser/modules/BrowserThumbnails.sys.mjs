/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { XPCOMUtils } from "resource://gre/modules/XPCOMUtils.sys.mjs";

const lazy = XPCOMUtils.declareLazy({
  NewTabUtils: "resource://gre/modules/NewTabUtils.sys.mjs",
  PageThumbs: "resource://gre/modules/PageThumbs.sys.mjs",
});

/**
 * Keeps thumbnails of open web pages up-to-date. Each browser window has its
 * own instance, created by `init` and destroyed by `uninit`.
 */
export class BrowserThumbnails {
  static #instances = new WeakMap();

  /**
   * @param {Window} window
   */
  static init(window) {
    let instance = new BrowserThumbnails(window);
    BrowserThumbnails.#instances.set(window, instance);
    instance.init();
  }

  /**
   * @param {Window} window
   */
  static uninit(window) {
    BrowserThumbnails.#instances.get(window)?.uninit();
    BrowserThumbnails.#instances.delete(window);
  }

  /**
   * @param {Window} window
   */
  static clearTopSiteURLCache(window) {
    BrowserThumbnails.#instances.get(window)?.clearTopSiteURLCache();
  }

  /**
   * @param {Window} window
   * @returns {Promise<string[]>|undefined} The top site URLs whose pages the
   *   window captures, or undefined if the window has no instance.
   */
  static getTopSiteURLs(window) {
    return BrowserThumbnails.#instances.get(window)?._topSiteURLs;
  }

  /**
   * Pref that controls whether we can store SSL content on disk
   */
  PREF_DISK_CACHE_SSL = "browser.cache.disk_cache_ssl";

  _captureDelayMS = 1000;

  /**
   * Used to keep track of disk_cache_ssl preference
   */
  _sslDiskCacheEnabled = null;

  /**
   * Map of capture() timeouts assigned to their browsers.
   */
  _timeouts = null;

  /**
   * Top site URLs refresh timer.
   */
  _topSiteURLsRefreshTimer = null;

  /**
   * List of tab events we want to listen for.
   */
  _tabEvents = ["TabClose", "TabSelect"];

  /**
   * @param {Window} window The browser window whose tabs this keeps
   *   thumbnails of.
   */
  constructor(window) {
    this._window = window;
    ChromeUtils.defineLazyGetter(this, "_topSiteURLs", () =>
      this._getTopSiteURLs()
    );
  }

  init() {
    let { gBrowser } = this._window;
    gBrowser.addTabsProgressListener(this);
    Services.prefs.addObserver(this.PREF_DISK_CACHE_SSL, this);

    this._sslDiskCacheEnabled = Services.prefs.getBoolPref(
      this.PREF_DISK_CACHE_SSL
    );

    this._tabEvents.forEach(function (aEvent) {
      gBrowser.tabContainer.addEventListener(aEvent, this);
    }, this);

    this._timeouts = new WeakMap();
  }

  uninit() {
    let { gBrowser } = this._window;
    gBrowser.removeTabsProgressListener(this);
    Services.prefs.removeObserver(this.PREF_DISK_CACHE_SSL, this);

    if (this._topSiteURLsRefreshTimer) {
      this._topSiteURLsRefreshTimer.cancel();
      this._topSiteURLsRefreshTimer = null;
    }

    this._tabEvents.forEach(function (aEvent) {
      gBrowser.tabContainer.removeEventListener(aEvent, this);
    }, this);
  }

  handleEvent(aEvent) {
    switch (aEvent.type) {
      case "scroll": {
        let browser = aEvent.currentTarget;
        if (this._timeouts.has(browser)) {
          this._delayedCapture(browser);
        }
        break;
      }
      case "TabSelect":
        this._delayedCapture(aEvent.target.linkedBrowser);
        break;
      case "TabClose": {
        this._cancelDelayedCapture(aEvent.target.linkedBrowser);
        break;
      }
    }
  }

  observe(subject, topic, data) {
    switch (data) {
      case this.PREF_DISK_CACHE_SSL:
        this._sslDiskCacheEnabled = Services.prefs.getBoolPref(
          this.PREF_DISK_CACHE_SSL
        );
        break;
    }
  }

  clearTopSiteURLCache() {
    if (this._topSiteURLsRefreshTimer) {
      this._topSiteURLsRefreshTimer.cancel();
      this._topSiteURLsRefreshTimer = null;
    }
    // Delete the defined property
    delete this._topSiteURLs;
    ChromeUtils.defineLazyGetter(this, "_topSiteURLs", () =>
      this._getTopSiteURLs()
    );
  }

  notify() {
    this._topSiteURLsRefreshTimer = null;
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
      this._delayedCapture(aBrowser);
    }
  }

  async _capture(aBrowser) {
    // Only capture about:newtab top sites.
    const topSites = await this._topSiteURLs;
    if (!aBrowser.currentURI || !topSites.includes(aBrowser.currentURI.spec)) {
      return;
    }
    if (await this._shouldCapture(aBrowser)) {
      await lazy.PageThumbs.captureAndStoreIfStale(aBrowser);
    }
  }

  _delayedCapture(aBrowser) {
    if (this._timeouts.has(aBrowser)) {
      this._cancelDelayedCallbacks(aBrowser);
    } else {
      aBrowser.addEventListener("scroll", this, true);
    }

    let idleCallback = () => {
      this._cancelDelayedCapture(aBrowser);
      this._capture(aBrowser);
    };

    // setTimeout to set a guarantee lower bound for the requestIdleCallback
    // (and therefore the delayed capture)
    let timeoutId = this._window.setTimeout(() => {
      let idleCallbackId = this._window.requestIdleCallback(idleCallback, {
        timeout: this._captureDelayMS * 30,
      });
      this._timeouts.set(aBrowser, { isTimeout: false, id: idleCallbackId });
    }, this._captureDelayMS);

    this._timeouts.set(aBrowser, { isTimeout: true, id: timeoutId });
  }

  async _shouldCapture(aBrowser) {
    let { gBrowser } = this._window;
    // Capture only if it's the currently selected tab and not an about: page.
    if (
      aBrowser != gBrowser.selectedBrowser ||
      gBrowser.currentURI.schemeIs("about")
    ) {
      return false;
    }
    return lazy.PageThumbs.shouldStoreThumbnail(aBrowser);
  }

  _cancelDelayedCapture(aBrowser) {
    if (this._timeouts.has(aBrowser)) {
      aBrowser.removeEventListener("scroll", this);
      this._cancelDelayedCallbacks(aBrowser);
      this._timeouts.delete(aBrowser);
    }
  }

  _cancelDelayedCallbacks(aBrowser) {
    let timeoutData = this._timeouts.get(aBrowser);

    if (timeoutData.isTimeout) {
      this._window.clearTimeout(timeoutData.id);
    } else {
      // idle callback dispatched
      this._window.cancelIdleCallback(timeoutData.id);
    }
  }

  async _getTopSiteURLs() {
    // The _topSiteURLs getter can be expensive to run, but its return value can
    // change frequently on new profiles, so as a compromise we cache its return
    // value as a lazy getter for 1 minute every time it's called.
    this._topSiteURLsRefreshTimer = Cc["@mozilla.org/timer;1"].createInstance(
      Ci.nsITimer
    );
    this._topSiteURLsRefreshTimer.initWithCallback(
      this,
      60 * 1000,
      Ci.nsITimer.TYPE_ONE_SHOT
    );
    let sites = [];
    // Get both the top sites returned by the query, and also any pinned sites
    // that the user might have added manually that also need a screenshot.
    // Also include top sites that don't have rich icons
    let topSites = await lazy.NewTabUtils.activityStreamLinks.getTopSites();
    sites.push(...topSites.filter(link => !(link.faviconSize >= 96)));
    sites.push(...lazy.NewTabUtils.pinnedLinks.links);
    return sites.reduce((urls, link) => {
      if (link) {
        urls.push(link.url);
      }
      return urls;
    }, []);
  }
}
