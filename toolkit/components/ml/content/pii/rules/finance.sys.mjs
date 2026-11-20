/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { XPCOMUtils } from "resource://gre/modules/XPCOMUtils.sys.mjs";
import { EVIDENCE, matches } from "./util.sys.mjs";
import { luhn, mod97 } from "./checks.sys.mjs";

/** @import { Rule } from "./util.sys.mjs" */

const lazy = XPCOMUtils.declareLazy({
  CreditCard: "resource://gre/modules/CreditCard.sys.mjs",
});

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

const CARD_CANDIDATE = new RegExp(
  [
    "(?<![\\w.-])",
    // 13 to 19 digits, optionally separated by single spaces or dashes.
    "\\d(?:[ -]?\\d){12,18}",
    // Not followed by more of a word or by a decimal part.
    "(?![\\w-]|\\.\\d)",
  ].join(""),
  "g"
);

/**
 * Real card numbers are written ungrouped or in standard groups: 4-4-4-4 with
 * a last group of 1 to 4, American Express 4-6-5 and Diners Club 4-6-4.
 *
 * @param {string} number - Digits separated by spaces or dashes.
 * @returns {boolean}
 */
function standardGrouping(number) {
  const groups = number.split(/[ -]/).map(group => group.length);
  if (groups.length === 1) {
    return true;
  }
  if (groups.length === 3) {
    return (
      groups[0] === 4 && groups[1] === 6 && (groups[2] === 5 || groups[2] === 4)
    );
  }
  const last = groups[groups.length - 1];
  return (
    groups.length >= 4 &&
    groups.slice(0, -1).every(length => length === 4) &&
    last >= 1 &&
    last <= 4
  );
}

/**
 * Whether the number passes Luhn and its issuer prefix and length match a
 * card network.
 *
 * @param {string} digits
 * @returns {boolean}
 */
function isCardNumber(digits) {
  // Luhn alone rejects nine numbers in ten, much faster than building a
  // CreditCard, which checks Luhn too.
  if (!luhn(digits) || !lazy.CreditCard.isValidNumber(digits)) {
    return false;
  }
  const network = lazy.CreditCard.getType(digits);
  // CreditCard accepts Visa numbers of 13 to 19 digits, but Visa issues only
  // 13, 16 and 19. The other lengths are mostly IMEIs starting with 49,
  // which pass Luhn too.
  if (network === "visa") {
    return [13, 16, 19].includes(digits.length);
  }
  return network !== null;
}

// "card ... 4920 0727 1234 5678": a cued number is replaced even when Luhn
// fails, as a mistyped card number is still a card number.
const CARD_CUE = new RegExp(
  [
    "\\b(?:card|credit|debit|visa|master\\s?card|amex|maestro|kreditkarte",
    "|bankkarte|karte|carte|tarjeta|cart[ãa]o|carta|karty|kaart",
    "|kredietkaart|pagamento|payment)\\b",
    // Up to 40 characters with no digit or line break before the number.
    "[^\\d\\n]{0,40}$",
  ].join(""),
  "i"
);

/** @type {Rule} */
export const card = {
  name: "card",
  type: "CARD",
  detect({ text }) {
    const spans = [];
    for (const match of matches(CARD_CANDIDATE, text)) {
      if (!standardGrouping(match.text)) {
        continue;
      }
      const digits = match.text.replace(/[ -]/g, "");
      const cued =
        digits.length >= 15 &&
        digits[0] >= "2" &&
        digits[0] <= "6" &&
        CARD_CUE.test(text.slice(Math.max(0, match.start - 48), match.start));
      if (isCardNumber(digits) || cued) {
        // A cued number that fails Luhn is labelled CHECKSUM too, so it is
        // not outranked by shape-only matches of other rules.
        spans.push({
          start: match.start,
          end: match.end,
          type: "CARD",
          evidence: EVIDENCE.CHECKSUM,
        });
      }
    }
    return spans;
  },
};

// Three or four digits mean nothing on their own, so the code must come after
// a security-code cue (8 languages), not before it: then the last group of a
// card number written just before "CVV" is not taken for the code. A 4-digit
// code is the American Express CID.
const CVV_CUE = new RegExp(
  [
    "\\b(?:cvv2?|cvc2?|csc|card\\s+verification\\s+(?:code|value|number)",
    "|(?:card\\s+)?security\\s+code|sicherheitscode|kartenpr[üu]fnummer",
    "|pr[üu]fziffer|code\\s+de\\s+s[ée]curit[ée]|cryptogramme(?:\\s+visuel)?",
    "|c[óo]digo\\s+de\\s+seguridad|c[óo]digo\\s+de\\s+seguran[çc]a",
    "|codice\\s+di\\s+sicurezza|kod\\s+bezpiecze[ńn]stwa|veiligheidscode",
    "|beveiligingscode)",
    "(?:[-\\s]?(?:code|kod|nummer|number|numero))?",
    // In the same sentence with no digit in between, or in a short follow-up
    // sentence that introduces the number ("my CVV. It's 289.").
    "(?:[^\\d\\n.!?]{0,32}",
    "|[^\\d\\n.!?]{0,20}[.!]\\s*",
    "(?:it['’]?s|it\\s+is|that['’]?s|es\\s+ist|c['’]est|è|é|es|to)\\s+)$",
  ].join(""),
  "iu"
);
// 3 or 4 digits standing alone.
const CVV_DIGITS = /(?<![\w.-])\d{3,4}(?![\w-]|\.\d)/g;

/** @type {Rule} */
export const cvv = {
  name: "cvv",
  type: "CVV",
  detect({ text }) {
    const spans = [];
    for (const match of matches(CVV_DIGITS, text)) {
      if (
        CVV_CUE.test(text.slice(Math.max(0, match.start - 64), match.start))
      ) {
        // A security code has no checksum: it is labelled CHECKSUM because
        // its cue makes it as specific as one.
        spans.push({
          start: match.start,
          end: match.end,
          type: "CVV",
          evidence: EVIDENCE.CHECKSUM,
        });
      }
    }
    return spans;
  },
};
