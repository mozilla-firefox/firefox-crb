/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { EVIDENCE, matches } from "./util.sys.mjs";

/** @import { Rule } from "./util.sys.mjs" */

/**
 * @param {string} text
 * @returns {string} The ASCII digits in `text`.
 */
function digitsOf(text) {
  return text.replace(/[^0-9]/g, "");
}

/**
 * @param {string} digits - Nine digits.
 * @returns {boolean} Whether the Social Security Administration could have
 *   issued the number: not area 000, 666 or 900-999, group 00 or serial 0000.
 */
function isIssuableSSN(digits) {
  return (
    !digits.startsWith("000") &&
    !digits.startsWith("666") &&
    !digits.startsWith("9") &&
    digits.slice(3, 5) !== "00" &&
    digits.slice(5) !== "0000"
  );
}

// "123-45-6789", with the same separator, a dash or a space, both times.
const SSN_SEPARATED = /(?<![\w.-])\d{3}([- ])\d{2}\1\d{4}(?![\w-]|\.\d)/g;

/** @type {Rule} */
export const ssnSeparated = {
  name: "ssnSeparated",
  type: "SSN",
  detect({ text }) {
    const spans = [];
    for (const match of matches(SSN_SEPARATED, text)) {
      if (isIssuableSSN(digitsOf(match.text))) {
        spans.push({
          start: match.start,
          end: match.end,
          type: "SSN",
          evidence: EVIDENCE.FORMAT,
        });
      }
    }
    return spans;
  },
};
