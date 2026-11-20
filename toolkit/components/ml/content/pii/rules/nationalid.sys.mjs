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
 * @param {string} text
 * @param {number} start
 * @param {number} end
 * @param {RegExp} cue - Without the g flag.
 * @returns {boolean} Whether `cue` appears in the 48 characters before
 *   `start` or the 16 after `end`.
 */
function hasCueNear(text, start, end, cue) {
  return (
    cue.test(text.slice(Math.max(0, start - 48), start)) ||
    cue.test(text.slice(end, end + 16))
  );
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

// Nine digits pass the issuable check most of the time, so without separators
// they need a cue.
const SSN_CUE = /\bssn\b|\bsocial\s+security\b/i;
const NINE_DIGITS = /(?<![\w.-])\d{9}(?![\w-]|\.\d)/g;

/** @type {Rule} */
export const ssnCued = {
  name: "ssnCued",
  type: "SSN",
  detect({ text }) {
    const spans = [];
    for (const match of matches(NINE_DIGITS, text)) {
      if (
        isIssuableSSN(match.text) &&
        hasCueNear(text, match.start, match.end, SSN_CUE)
      ) {
        spans.push({
          start: match.start,
          end: match.end,
          type: "SSN",
          evidence: EVIDENCE.CHECKSUM_CUE,
        });
      }
    }
    return spans;
  },
};
