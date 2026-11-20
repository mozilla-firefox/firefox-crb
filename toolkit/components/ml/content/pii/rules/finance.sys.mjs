/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { EVIDENCE, matches } from "./util.sys.mjs";
import { mod97 } from "./checks.sys.mjs";

/** @import { Rule } from "./util.sys.mjs" */

// IBAN length per country, from the SWIFT IBAN registry. Other countries must
// be 15 to 34 characters with a valid mod-97.
/** @type {Record<string, number>} */
const IBAN_LENGTHS = {
  AD: 24, AE: 23, AL: 28, AT: 20, AZ: 28, BA: 20, BE: 16, BG: 22, BH: 22,
  BR: 29, BY: 28, CH: 21, CR: 22, CY: 28, CZ: 24, DE: 22, DK: 18, DO: 28,
  EE: 20, EG: 29, ES: 24, FI: 18, FO: 18, FR: 27, GB: 22, GE: 22, GI: 23,
  GL: 18, GR: 27, GT: 28, HR: 21, HU: 28, IE: 22, IL: 23, IQ: 23, IS: 26,
  IT: 27, JO: 30, KW: 30, KZ: 20, LB: 28, LI: 21, LT: 20, LU: 20, LV: 21,
  MC: 27, MD: 24, ME: 22, MK: 19, MR: 27, MT: 31, MU: 30, NL: 18, NO: 15,
  PK: 24, PL: 28, PS: 29, PT: 25, QA: 29, RO: 24, RS: 22, SA: 24, SC: 31,
  SE: 24, SI: 19, SK: 24, SM: 27, TL: 23, TN: 24, TR: 26, UA: 29, VA: 22,
  VG: 24, XK: 20,
}; // prettier-ignore

const IBAN_CANDIDATE = new RegExp(
  [
    "(?<![A-Za-z0-9])",
    // Country code and check digits.
    "[A-Z]{2}\\d{2}",
    // 11 to 30 more characters, for 15 to 34 in all, each optionally after a
    // separator. Matching one character at a time leaves a single way to read
    // a long run, so a failed match does not retry every way of grouping it.
    "(?:[ -]?[A-Z0-9]){11,30}",
    "(?![A-Za-z0-9])",
  ].join(""),
  "g"
);

/**
 * @param {string} char
 * @returns {boolean}
 */
function isGroupSeparator(char) {
  return char === " " || char === "-";
}

/** @type {Rule} */
export const iban = {
  name: "iban",
  type: "IBAN",
  detect({ text }) {
    const spans = [];
    for (const match of matches(IBAN_CANDIDATE, text)) {
      // The candidate can run into the following words ("... 00 and ..."),
      // so shorter groupings are tried too, longest first.
      const cuts = [match.text.length];
      for (let i = match.text.length - 1; i > 14; i--) {
        if (isGroupSeparator(match.text[i])) {
          cuts.push(i);
        }
      }
      // The candidate without separators, and how much of it comes before
      // each character, so that each cut is a slice rather than a rebuild.
      let all = "";
      const compactBefore = [];
      for (const char of match.text) {
        compactBefore.push(all.length);
        if (!isGroupSeparator(char)) {
          all += char;
        }
      }
      compactBefore.push(all.length);
      const expected = IBAN_LENGTHS[all.slice(0, 2)];
      for (const cut of cuts) {
        const length = compactBefore[cut];
        const lengthOk = expected
          ? length === expected
          : length >= 15 && length <= 34;
        if (lengthOk && mod97(all.slice(0, length))) {
          spans.push({
            start: match.start,
            end: match.start + cut,
            type: "IBAN",
            evidence: EVIDENCE.CHECKSUM,
          });
          break;
        }
      }
    }
    return spans;
  },
};
