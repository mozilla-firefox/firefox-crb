/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { EVIDENCE, matches } from "./util.sys.mjs";

/** @import { Rule } from "./util.sys.mjs" */

// Free helplines belong to a business, not a person, so they are left alone.
const TOLL_FREE = [
  /^1?8(?:00|33|44|55|66|77|88)\d{7}$/, // North America: 1-800 and similar.
];

/**
 * @param {string} text
 * @returns {string} Only the digits in `text`.
 */
function digitsOf(text) {
  return text.replace(/\D/g, "");
}

/**
 * @param {string} digits
 * @returns {boolean}
 */
function isTollFree(digits) {
  return TOLL_FREE.some(pattern => pattern.test(digits));
}

// "+" and a digit, then 6 to 18 digits or separators, ending in a digit.
const INTERNATIONAL = /(?<![\w+])\+\d[\d ()./-]{6,18}\d(?![\w-])/g;

/** @type {Rule} */
export const phoneInternational = {
  name: "phoneInternational",
  type: "PHONE",
  detect({ text }) {
    const spans = [];
    for (const match of matches(INTERNATIONAL, text)) {
      const digits = digitsOf(match.text);
      // A plus sign and 8 to 15 digits is strong on its own. At CHECKSUM, a
      // phone number that also passes Luhn ties with a card and wins as the
      // longer match.
      if (digits.length >= 8 && digits.length <= 15 && !isTollFree(digits)) {
        spans.push({
          start: match.start,
          end: match.end,
          type: "PHONE",
          evidence: EVIDENCE.CHECKSUM,
        });
      }
    }
    return spans;
  },
};
