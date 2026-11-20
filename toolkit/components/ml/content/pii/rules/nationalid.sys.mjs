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
 * @param {string} digits
 * @param {number[]} weights
 * @returns {number} The sum of the first digits, each times its weight.
 */
function weighted(digits, weights) {
  let sum = 0;
  for (let i = 0; i < weights.length; i++) {
    sum += Number(digits[i]) * weights[i];
  }
  return sum;
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

/**
 * @param {string} digits - Nine digits.
 * @returns {boolean} Whether the IRS issues ITINs in the number's range: area
 *   900-999 and group 50-65, 70-88, 90-92 or 94-99.
 */
function isIssuableITIN(digits) {
  const group = Number(digits.slice(3, 5));
  return (
    digits[0] === "9" &&
    ((group >= 50 && group <= 65) ||
      (group >= 70 && group <= 88) ||
      (group >= 90 && group <= 92) ||
      group >= 94)
  );
}

/** @type {Rule} */
export const itinUS = {
  name: "itinUS",
  type: "NATIONAL_ID",
  detect({ text }) {
    const spans = [];
    for (const match of matches(SSN_SEPARATED, text)) {
      if (isIssuableITIN(digitsOf(match.text))) {
        spans.push({
          start: match.start,
          end: match.end,
          type: "NATIONAL_ID",
          evidence: EVIDENCE.FORMAT,
          country: "US_ITIN",
        });
      }
    }
    return spans;
  },
};

// "AB 12 34 56 C": two prefix letters, never D, F, I, Q, U or V and O not
// second, three pairs of digits and a suffix A to D, each part optionally
// after a space or dash.
const NINO = new RegExp(
  [
    "(?<![\\w-])",
    "(?<prefix>[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z])",
    "(?:[ -]?\\d{2}){3}",
    "[ -]?[A-D]",
    "(?![\\w-])",
  ].join(""),
  "gi"
);
// Prefixes that are not allocated.
const NINO_UNUSED_PREFIXES = new Set([
  "BG",
  "GB",
  "KN",
  "NK",
  "NT",
  "TN",
  "ZZ",
]);

/** @type {Rule} */
export const ninoUK = {
  name: "ninoUK",
  type: "NATIONAL_ID",
  detect({ text }) {
    const spans = [];
    for (const match of matches(NINO, text)) {
      if (!NINO_UNUSED_PREFIXES.has(match.groups.prefix.toUpperCase())) {
        spans.push({
          start: match.start,
          end: match.end,
          type: "NATIONAL_ID",
          evidence: EVIDENCE.FORMAT,
          country: "UK_NINO",
        });
      }
    }
    return spans;
  },
};

// "943 476 5919", in groups of 3, 3 and 4 with the same separator or none.
const NHS_NUMBER = /(?<![\w.-])\d{3}([ -]?)\d{3}\1\d{4}(?![\w-]|\.\d)/g;
const NHS_CUE = /\bnhs\b|\bnational\s+health\b|\bhealth\s+service\b/i;

/**
 * @param {string} digits - Ten digits.
 * @returns {boolean} Whether the modulus 11 check digit holds.
 */
function isNHSNumber(digits) {
  const remainder = weighted(digits, [10, 9, 8, 7, 6, 5, 4, 3, 2]) % 11;
  // A check of 10 matches no digit: such numbers are never issued.
  return (11 - remainder) % 11 === Number(digits[9]);
}

/** @type {Rule} */
export const nhsUK = {
  name: "nhsUK",
  type: "NATIONAL_ID",
  detect({ text }) {
    const spans = [];
    for (const match of matches(NHS_NUMBER, text)) {
      if (
        isNHSNumber(digitsOf(match.text)) &&
        hasCueNear(text, match.start, match.end, NHS_CUE)
      ) {
        spans.push({
          start: match.start,
          end: match.end,
          type: "NATIONAL_ID",
          evidence: EVIDENCE.CHECKSUM_CUE,
          country: "UK_NHS",
        });
      }
    }
    return spans;
  },
};
