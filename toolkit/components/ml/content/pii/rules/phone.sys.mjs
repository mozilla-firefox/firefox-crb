/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { EVIDENCE, WORD_END, WORD_START, matches } from "./util.sys.mjs";

/** @import { Rule } from "./util.sys.mjs" */

// Free helplines belong to a business, not a person, so they are left alone.
// The patterns match the national form, and for North America also the
// number after a 1.
const TOLL_FREE = [
  /^1?8(?:00|33|44|55|66|77|88)\d{7}$/, // North America: 1-800 and similar.
  /^0?800\d{6,7}$|^0808\d{7}$|^080[0-5]\d{6}$/, // UK, Germany, Netherlands, France.
  /^(?:900|800)\d{6}$/, // Spain 900, Italy, Portugal and Poland 800.
];
// The national prefix that takes the place of each country code above, so
// that "+44 800 ..." is checked as "0800 ...".
/** @type {Record<string, string>} */
const TRUNK_PREFIX = {
  31: "0",
  33: "0",
  34: "",
  39: "",
  44: "0",
  48: "",
  49: "0",
  351: "",
};

/**
 * @param {string} text
 * @returns {string} Only the digits in `text`.
 */
function digitsOf(text) {
  return text.replace(/\D/g, "");
}

/**
 * @param {string} digits - A national number, or "00" and a country code
 *   before it.
 * @returns {boolean}
 */
function isTollFree(digits) {
  let national = digits;
  if (digits.startsWith("00")) {
    const rest = digits.slice(2);
    const code = Object.keys(TRUNK_PREFIX).find(prefix =>
      rest.startsWith(prefix)
    );
    national =
      code === undefined ? rest : TRUNK_PREFIX[code] + rest.slice(code.length);
  }
  return TOLL_FREE.some(pattern => pattern.test(national));
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
      if (
        digits.length >= 8 &&
        digits.length <= 15 &&
        !isTollFree(`00${digits}`)
      ) {
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

// North American NXX-NXX-XXXX, where N is 2 to 9: "(415) 555-0134",
// "(415)555-0134", "415.555.0134" or "1-415-555-0134".
const NORTH_AMERICAN = new RegExp(
  [
    "(?<![\\w+-])",
    // An optional country code 1.
    "(?:1[ .-])?",
    // The area code, in parentheses or followed by a separator.
    "(?:\\([2-9]\\d{2}\\)[ .-]?|[2-9]\\d{2}[ .-])",
    // The exchange and the line number.
    "[2-9]\\d{2}[ .-]\\d{4}",
    "(?![\\w-])",
  ].join(""),
  "g"
);

/** @type {Rule} */
export const phoneNorthAmerican = {
  name: "phoneNorthAmerican",
  type: "PHONE",
  detect({ text }) {
    const spans = [];
    for (const match of matches(NORTH_AMERICAN, text)) {
      if (!isTollFree(digitsOf(match.text))) {
        // The shape alone, which a reference number can share.
        spans.push({
          start: match.start,
          end: match.end,
          type: "PHONE",
          evidence: EVIDENCE.FORMAT,
        });
      }
    }
    return spans;
  },
};

// A cue word right before the number: "call me on", "Tel.:", "📞".
const PHONE_CUE_BEFORE = new RegExp(
  [
    `(?:${WORD_START}(?:`,
    // English
    "call|phone|tel|telephone|mobile|cell(?:phone)?|whatsapp|signal|sms",
    "|text\\s+me|dial|fax|gsm|reach\\s+me|phone\\s+number|mobile\\s+number",
    "|cell\\s+number",
    // German
    "|telefon|handy|rufnummer|anrufen|rufen|erreichen|telefonnummer",
    "|handynummer",
    // French
    "|t[ée]l[ée]phone|t[ée]l|portable|appelle[rz]?|joignable",
    "|num[ée]ro\\s+de\\s+t[ée]l[ée]phone",
    // Spanish and Portuguese
    "|tel[ée]fono|m[óo]vil|celular|llama|ligue|ligar|telefone|contacto",
    "|contato|n[úu]mero\\s+de\\s+tel[ée]fono|n[úu]mero\\s+de\\s+telefone",
    // Polish
    "|zadzwo[ńn]|dzwo[ńn]|kom[óo]rka|kontakt|numer\\s+telefonu",
    // Italian
    "|chiama|cellulare|contatto|numero\\s+di\\s+telefono",
    // Dutch
    "|bel|mobiel|belt|bereikbaar|telefoon(?:nummer)?",
    `)${WORD_END}|☎|📞)`,
    // Then up to 3 short words with punctuation around them, up to the
    // number: "call me on", "tel. (mobile):".
    "(?:[\\s:.=#()?!¿-]+(?:\\p{L}{1,8}[\\s:.=#()?!¿-]+){0,3})?$",
  ].join(""),
  "iu"
);
// A cue right after the number: "... is my phone", "... anrufen".
const PHONE_CUE_AFTER = new RegExp(
  [
    "^\\s*(?:",
    "(?:is\\s+my|ist\\s+meine|c'est\\s+mon|es\\s+mi|é\\s+o\\s+meu)",
    "\\s+(?:phone|tel|number|handy|numéro|número|numero|mobile|cell)",
    "|(?:bellen|anrufen|appeler|llamar|ligar|chiamare|zadzwoni[ćc]",
    `|dzwoni[ćc]|call)${WORD_END}`,
    ")",
  ].join(""),
  "iu"
);
// Dates such as 2024-01-15 or 15.01.2024 are not phone numbers.
const LOOKS_LIKE_DATE =
  /^(?:\d{4}-\d{2}-\d{2}|\d{1,2}[./-]\d{1,2}[./-]\d{2,4})\b/;
// An optional "(", a digit, then 5 to 16 digits or separators, ending in a
// digit, and not followed by a decimal part.
const NATIONAL = /(?<![\w+-])\(?\d[\d ()./-]{5,16}\d(?![\w-]|[.,]\d)/g;

/** @type {Rule} */
export const phoneCued = {
  name: "phoneCued",
  type: "PHONE",
  detect({ text }) {
    const spans = [];
    for (const match of matches(NATIONAL, text)) {
      const digits = digitsOf(match.text);
      const maxDigits = digits.startsWith("00") ? 15 : 12;
      if (
        digits.length < 7 ||
        digits.length > maxDigits ||
        isTollFree(digits)
      ) {
        continue;
      }
      // Dates, and times such as "10 30 45:12", are not phone numbers.
      if (
        LOOKS_LIKE_DATE.test(match.text) ||
        (text[match.end] === ":" && /\d/.test(text[match.end + 1] ?? ""))
      ) {
        continue;
      }
      const before = text.slice(Math.max(0, match.start - 30), match.start);
      const after = text.slice(match.end, match.end + 30);
      if (PHONE_CUE_BEFORE.test(before) || PHONE_CUE_AFTER.test(after)) {
        // A phone number has no checksum: it is labelled CHECKSUM because its
        // cue makes it as specific as one.
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

/**
 * A rule for the usual layout of phone numbers in one region. On its own the
 * layout is too common elsewhere, so the rule only runs in that region.
 *
 * @param {string} name
 * @param {string} region - Upper-case ISO 3166-1 code, such as "FR".
 * @param {RegExp} layout - Must have the g flag.
 * @returns {Rule}
 */
function regionalPhone(name, region, layout) {
  return {
    name,
    type: "PHONE",
    detect({ text, region: userRegion }) {
      if (userRegion !== region) {
        return [];
      }
      const spans = [];
      for (const match of matches(layout, text)) {
        if (!isTollFree(digitsOf(match.text))) {
          // The layout alone, which a reference number can share.
          spans.push({
            start: match.start,
            end: match.end,
            type: "PHONE",
            evidence: EVIDENCE.FORMAT,
          });
        }
      }
      return spans;
    },
  };
}

// France: 0, then 9 digits in pairs: "06 12 34 56 78", "0612345678".
export const phoneFR = regionalPhone(
  "phoneFR",
  "FR",
  /(?<![\w+-])0[1-9](?:[ .-]?\d{2}){4}(?![\w-])/g
);

// The Netherlands: 06 and 8 digits, whole or in pairs: "06 12345678",
// "06-12 34 56 78".
export const phoneNL = regionalPhone(
  "phoneNL",
  "NL",
  /(?<![\w+-])06(?:[ -]?\d{8}|[ -]\d{2}(?:[ -]?\d{2}){3})(?![\w-])/g
);

// Germany: a 015x, 016x or 017x prefix, then 6 to 8 digits in one or two
// groups: "0171 2345678", "0176 1234 5678".
export const phoneDE = regionalPhone(
  "phoneDE",
  "DE",
  /(?<![\w+-])01[567]\d[ /-]?\d{3,4}[ -]?\d{3,4}(?![\w-])/g
);

// Spain: 9 digits starting with 6 to 9, in groups 3-3-3 or 3-2-2-2:
// "612 345 678", "612 34 56 78".
export const phoneES = regionalPhone(
  "phoneES",
  "ES",
  /(?<![\w+-])[6-9]\d{2}(?:[ -]\d{3}[ -]\d{3}|(?:[ -]\d{2}){3})(?![\w-])/g
);

// Portugal: 91, 92, 93 or 96, then 7 digits in groups 3-3-3: "912 345 678".
export const phonePT = regionalPhone(
  "phonePT",
  "PT",
  /(?<![\w+-])9[1236]\d[ -]\d{3}[ -]\d{3}(?![\w-])/g
);

// Poland: a mobile prefix, then 7 digits in groups 3-3-3: "512 345 678".
// Landlines are written 2-3-2-2 instead.
export const phonePL = regionalPhone(
  "phonePL",
  "PL",
  /(?<![\w+-])(?:45|5[0137]|6[069]|7[2389]|88)\d[ -]\d{3}[ -]\d{3}(?![\w-])/g
);

// Italy: 3 and 2 digits, then 6 or 7 digits whole or in groups:
// "333 1234567", "320 123 4567".
export const phoneIT = regionalPhone(
  "phoneIT",
  "IT",
  /(?<![\w+-])3\d{2}[ -](?:\d{6,7}|\d{3}[ -]\d{3,4})(?![\w-])/g
);

// The UK: 07 and 3 digits, then 6 digits whole or as 3-3: "07700 900123",
// "07700 900 123".
export const phoneGB = regionalPhone(
  "phoneGB",
  "GB",
  /(?<![\w+-])07\d{3}[ -]?(?:\d{6}|\d{3}[ -]\d{3})(?![\w-])/g
);
