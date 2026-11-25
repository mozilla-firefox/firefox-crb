/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* global DOCS_REDIRECTS */

// Applies the first matching prefix redirect from docs/config.yml, after
// moving pre-/docs/ URLs under /docs/.
{
  let path = location.pathname;
  if (!path.startsWith("/docs/")) {
    path = "/docs" + path;
  }
  const redirect = DOCS_REDIRECTS.find(([from]) => path.startsWith(from));
  if (redirect) {
    path = redirect[1] + path.slice(redirect[0].length);
  }
  if (path !== location.pathname) {
    location.replace(path + location.search + location.hash);
  }
}
