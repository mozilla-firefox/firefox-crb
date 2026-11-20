/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { EVIDENCE, WORD_END, WORD_START, matches } from "./util.sys.mjs";

/** @import { Rule, RegexMatch } from "./util.sys.mjs" */

/**
 * @param {RegexMatch} match - With "lat" and "lon" groups.
 * @returns {boolean} Whether the latitude is at most 90 and the longitude at
 *   most 180, either way.
 */
function inRange(match) {
  return (
    Math.abs(parseFloat(match.groups.lat)) <= 90 &&
    Math.abs(parseFloat(match.groups.lon)) <= 180
  );
}

// "lat 48.8584, lon 2.2945". Each optional separator owns the spaces after it,
// so no two runs of spaces compete for the same characters, which would make
// matching polynomial on long runs of spaces.
const GPS_LABELED = new RegExp(
  [
    "\\blat(?:itude)?\\s*(?:[:=]\\s*)?",
    "(?<lat>-?\\d{1,2}(?:\\.\\d+)?)",
    // An optional degree sign or separator between the two.
    "\\s*(?:[°,;]\\s*)?(?:[,;]\\s*)?",
    "\\b(?:lon(?:g|gitude)?|lng)\\s*(?:[:=]\\s*)?",
    "(?<lon>-?\\d{1,3}(?:\\.\\d+)?)",
    // Not the start of a longer number, such as "1800" or "3.4.5".
    "(?!\\.?\\d)",
  ].join(""),
  "gi"
);

/** @type {Rule} */
export const gpsLabeled = {
  name: "gpsLabeled",
  type: "GPS",
  detect({ text }) {
    const spans = [];
    for (const match of matches(GPS_LABELED, text)) {
      if (inRange(match)) {
        spans.push({
          start: match.start,
          end: match.end,
          type: "GPS",
          evidence: EVIDENCE.FORMAT,
        });
      }
    }
    return spans;
  },
};

// "48.8584, 2.2945": decimal degrees with at least 3 decimals each, joined by
// a comma.
const GPS_PAIR_COMMA =
  /(?<![\w.-])(?<lat>-?\d{1,2}\.\d{3,})\s*,\s*(?<lon>-?\d{1,3}\.\d{3,})(?!\w|\.\d)/g;
// An unsigned number with exactly 3 decimals, which is also how "1.500"
// groups thousands in many European languages.
const MAY_BE_THOUSANDS = /^\d+\.\d{3}$/;

/** @type {Rule} */
export const gpsPairComma = {
  name: "gpsPairComma",
  type: "GPS",
  detect({ text }) {
    const spans = [];
    for (const match of matches(GPS_PAIR_COMMA, text)) {
      const { lat, lon } = match.groups;
      if (
        inRange(match) &&
        !(MAY_BE_THOUSANDS.test(lat) && MAY_BE_THOUSANDS.test(lon))
      ) {
        spans.push({
          start: match.start,
          end: match.end,
          type: "GPS",
          evidence: EVIDENCE.FORMAT,
        });
      }
    }
    return spans;
  },
};

// "48.8584 2.2945": without a comma, at least 4 decimals each, on one line.
const GPS_PAIR_SPACE =
  /(?<![\w.-])(?<lat>-?\d{1,2}\.\d{4,})[ \t]+(?<lon>-?\d{1,3}\.\d{4,})(?!\w|\.\d)/g;

/** @type {Rule} */
export const gpsPairSpace = {
  name: "gpsPairSpace",
  type: "GPS",
  detect({ text }) {
    const spans = [];
    for (const match of matches(GPS_PAIR_SPACE, text)) {
      if (inRange(match)) {
        spans.push({
          start: match.start,
          end: match.end,
          type: "GPS",
          evidence: EVIDENCE.FORMAT,
        });
      }
    }
    return spans;
  },
};

// A PO box keyword (8 languages) and the box number; the whole phrase is
// replaced. Words that are ambiguous on their own are left out: a bare "BP"
// (also a company) and Spanish "apartado" without "de correos" or "postal"
// (also "section of a document").
const PO_BOX = new RegExp(
  [
    "(?<![\\p{L}\\p{N}])",
    "(?:p\\.?\\s?o\\.?\\s?box|post\\s+office\\s+box",
    // A bare "POB" must not touch the digits: "POB268787" is a Polish ID card
    // number, not a box.
    "|pob(?![\\p{N}])",
    "|postfach|bo[iî]te\\s+postale|b\\.p\\.",
    "|apartado\\s+(?:de\\s+correos|postal)|apdo\\.?|caixa\\s+postal",
    "|casella\\s+postale|postbus|skrytka\\s+pocztowa|skr\\.\\s?poczt\\.)",
    // An optional "No.", "Nr.", "nº" or "#", each owning the spaces after it.
    "\\s*(?:(?:no\\.?|nr\\.?|n[º°o]\\.?|#)\\s*)?",
    // The box number, possibly grouped: "Postfach 12 34 56".
    "\\d{1,6}(?:[ -]\\d{2,4}){0,2}",
    "(?![\\p{N}])",
  ].join(""),
  "giu"
);

/** @type {Rule} */
export const poBox = {
  name: "poBox",
  type: "PO_BOX",
  detect({ text }) {
    const spans = [];
    for (const match of matches(PO_BOX, text)) {
      // A keyword and a number is as strong as a cued checksum.
      spans.push({
        start: match.start,
        end: match.end,
        type: "PO_BOX",
        evidence: EVIDENCE.CHECKSUM,
      });
    }
    return spans;
  },
};

// A UK postcode in capitals: "SW1A 2AA", "M1 1AE", "GIR 0AA".
const UK_POSTCODE = new RegExp(
  [
    "(?<![A-Za-z0-9])",
    "(?:GIR ?0AA",
    // Outward code: area letters, district digit and an optional character.
    "|[A-PR-UWYZ][A-HK-Y]?\\d[A-Z\\d]?",
    // Inward code: a digit and two letters, optionally after a space.
    " ?\\d[ABD-HJLNP-UW-Z]{2})",
    "(?![A-Za-z0-9])",
  ].join(""),
  "g"
);

/** @type {Rule} */
export const postcodeUK = {
  name: "postcodeUK",
  type: "POSTCODE",
  detect({ text }) {
    const spans = [];
    for (const match of matches(UK_POSTCODE, text)) {
      // A storage size such as "M2 1TB" has the same shape.
      if (/\d[GPT]B$/.test(match.text)) {
        continue;
      }
      spans.push({
        start: match.start,
        end: match.end,
        type: "POSTCODE",
        evidence: EVIDENCE.FORMAT,
      });
    }
    return spans;
  },
};

// A Canadian postal code in capitals: "K1A 0B1". D, F, I, O, Q and U are not
// used, nor W and Z as the first letter.
const CANADA_POSTCODE =
  /(?<![A-Za-z0-9])[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z][ -]?\d[ABCEGHJ-NPRSTV-Z]\d(?![A-Za-z0-9])/g;

/** @type {Rule} */
export const postcodeCanada = {
  name: "postcodeCanada",
  type: "POSTCODE",
  detect({ text }) {
    const spans = [];
    for (const match of matches(CANADA_POSTCODE, text)) {
      spans.push({
        start: match.start,
        end: match.end,
        type: "POSTCODE",
        evidence: EVIDENCE.FORMAT,
      });
    }
    return spans;
  },
};

// USPS abbreviations of the 50 states and DC.
const US_STATES =
  "AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN " +
  "MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA " +
  "WV WI WY";
// "Springfield, IL 62704": a ZIP code after a comma and a state.
const ZIP_AFTER_STATE = new RegExp(
  `(?<=,\\s?(?:${US_STATES.split(" ").join("|")}),?\\s)\\d{5}(?:-\\d{4})?(?![\\w-])`,
  "g"
);

/** @type {Rule} */
export const zipAfterState = {
  name: "zipAfterState",
  type: "POSTCODE",
  detect({ text }) {
    const spans = [];
    for (const match of matches(ZIP_AFTER_STATE, text)) {
      spans.push({
        start: match.start,
        end: match.end,
        type: "POSTCODE",
        evidence: EVIDENCE.FORMAT,
      });
    }
    return spans;
  },
};

// A postcode cue right before the number, in 8 languages: "zip code",
// "PLZ", "code postal", "kod pocztowy".
const POSTCODE_CUE = new RegExp(
  [
    WORD_START,
    "(?:zip(?:\\s?code)?|post(?:al)?\\s?code|postcode|plz|postleitzahl",
    "|code\\s+postal|c\\.p\\.|c[óo]digo\\s+postal|kod\\s+pocztowy",
    "|kod\\s+pocz\\.?|postnummer|codice\\s+postale)",
    // A word edge that also works after the dot of "C.P.".
    WORD_END,
    // An optional "is" in one of the languages: "my zip code is 94105".
    "(?:\\s+(?:is|ist|est|es|è|é)(?![\\p{L}\\p{N}_]))?",
    // Up to 6 separator characters before the number.
    "[\\s:.=#-]{0,6}$",
  ].join(""),
  "iu"
);
// Short cues that are also ordinary words ("price cap 5000") only count in
// capitals.
const POSTCODE_CUE_UPPERCASE = /\b(?:CAP|CEP|CP)\b[\s:.=#-]{0,6}$/;

/**
 * @param {string} text
 * @param {number} start
 * @returns {boolean} Whether a postcode cue ends right before `start`.
 */
function hasPostcodeCue(text, start) {
  const before = text.slice(Math.max(0, start - 24), start);
  return POSTCODE_CUE.test(before) || POSTCODE_CUE_UPPERCASE.test(before);
}

// Postcode shapes that look like ordinary numbers, so they only count after a
// cue or in their own region.
// 4 or 5 digits standing alone, not followed by a decimal part.
const PLAIN_POSTCODE = /(?<![\w.-])\d{4,5}(?![\w-]|\.\d)/g;
// US ZIP+4: "94105-1234".
const ZIP_PLUS_4 = /(?<![\w.-])\d{5}-\d{4}(?![\w-])/g;
// The Netherlands: "1012 AB".
const DUTCH_POSTCODE = /(?<![\w.-])[1-9]\d{3} ?[A-Z]{2}(?![A-Za-z0-9])/g;
// Poland: "00-950".
const POLISH_POSTCODE = /(?<![\w.-])\d{2}-\d{3}(?![\w-])/g;
// Portugal: "1000-001".
const PORTUGUESE_POSTCODE = /(?<![\w.-])\d{4}-\d{3}(?![\w-])/g;

/** @type {Rule} */
export const postcodeCued = {
  name: "postcodeCued",
  type: "POSTCODE",
  detect({ text }) {
    const spans = [];
    for (const pattern of [
      PLAIN_POSTCODE,
      ZIP_PLUS_4,
      DUTCH_POSTCODE,
      POLISH_POSTCODE,
      PORTUGUESE_POSTCODE,
    ]) {
      for (const match of matches(pattern, text)) {
        if (hasPostcodeCue(text, match.start)) {
          spans.push({
            start: match.start,
            end: match.end,
            type: "POSTCODE",
            evidence: EVIDENCE.FORMAT,
          });
        }
      }
    }
    return spans;
  },
};

/**
 * A rule for a postcode shape that is only distinctive in its own region.
 *
 * @param {string} name
 * @param {string} region - Upper-case ISO 3166-1 code, such as "NL".
 * @param {RegExp} pattern - Must have the g flag.
 * @returns {Rule}
 */
function regionalPostcode(name, region, pattern) {
  return {
    name,
    type: "POSTCODE",
    detect({ text, region: userRegion }) {
      if (userRegion !== region) {
        return [];
      }
      const spans = [];
      for (const match of matches(pattern, text)) {
        spans.push({
          start: match.start,
          end: match.end,
          type: "POSTCODE",
          evidence: EVIDENCE.FORMAT,
        });
      }
      return spans;
    },
  };
}

export const postcodeUS = regionalPostcode("postcodeUS", "US", ZIP_PLUS_4);
