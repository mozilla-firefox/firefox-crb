/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/**
 * Bug 2095487 - www.long-mcquade.com - Navigation drop-down menus do not open
 *
 * The site loads jQuery and Bootstrap 5 as independent async scripts, and
 * puts a placeholder function without `.fn` into window.jQuery until the
 * real jQuery has loaded. If Bootstrap's jQuery plugin registration runs
 * before jQuery has loaded, it throws on the placeholder, so window.bootstrap
 * and all of its data-api handlers (dropdowns, modals, ...) are never set up.
 *
 * Until the real jQuery is there, we set Bootstrap's documented opt-out,
 * the data-bs-no-jquery attribute on <body>, so that Bootstrap ignores the
 * placeholder. Once jQuery has loaded we remove it again, and register the
 * jQuery plugins Bootstrap skipped.
 */

// Scoped in a block, as this runs in the page's main world.
{
  const ATTR = "data-bs-no-jquery";

  const getRealJQuery = () => {
    const jq = window.jQuery;
    return jq?.fn ? jq : null;
  };

  let applied = false;

  const registerMissedPlugins = () => {
    const bootstrap = window.bootstrap;
    const $ = getRealJQuery();
    if (!bootstrap || !$) {
      return;
    }
    for (const name of Object.keys(bootstrap)) {
      const plugin = bootstrap[name];
      const pluginName = plugin?.NAME;
      if (
        typeof pluginName !== "string" ||
        typeof plugin.jQueryInterface !== "function" ||
        $.fn[pluginName]
      ) {
        continue;
      }
      $.fn[pluginName] = plugin.jQueryInterface;
      $.fn[pluginName].Constructor = plugin;
      $.fn[pluginName].noConflict = () => {
        delete $.fn[pluginName];
        return plugin.jQueryInterface;
      };
    }
  };

  const onScriptLoaded = ({ target }) => {
    if (!(target instanceof HTMLScriptElement) || !getRealJQuery()) {
      return;
    }
    document.removeEventListener("load", onScriptLoaded, true);
    document.body?.removeAttribute(ATTR);
    registerMissedPlugins();
  };

  // Bootstrap registers its plugins either right away (once the document is no
  // longer "loading"), or on DOMContentLoaded. Both of these listeners run
  // before that happens.
  const hideJQueryFromBootstrapIfNotLoaded = () => {
    if (applied || getRealJQuery() || !document.body) {
      return;
    }
    applied = true;
    console.info(
      "Bootstrap's jQuery detection has been delayed for compatibility reasons. See https://bugzil.la/2095487 for details."
    );
    document.body.setAttribute(ATTR, "");
    document.addEventListener("load", onScriptLoaded, true);
  };

  document.addEventListener(
    "readystatechange",
    hideJQueryFromBootstrapIfNotLoaded,
    { once: true }
  );
  document.addEventListener(
    "DOMContentLoaded",
    hideJQueryFromBootstrapIfNotLoaded,
    { once: true }
  );
}
