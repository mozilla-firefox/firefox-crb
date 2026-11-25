/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* global DOCS_REDIRECTS */

// Applies the first matching prefix redirect from docs/config.yml.
{
  const path = location.pathname;
  const redirect = DOCS_REDIRECTS.find(([from]) => path.startsWith(from));
  if (redirect) {
    const target = redirect[1] + path.slice(redirect[0].length);
    location.replace(target + location.search + location.hash);
  }
}
