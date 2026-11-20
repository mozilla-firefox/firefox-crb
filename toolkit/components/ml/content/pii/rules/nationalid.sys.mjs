/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { luhn } from "./checks.sys.mjs";
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
 * @param {number} year
 * @param {number} month - From 1.
 * @param {number} day
 * @returns {boolean} Whether the date exists.
 */
function isRealDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
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

// Dihedral group D5 multiplication and the position permutation of the
// Verhoeff check (Verhoeff, 1969).
const VERHOEFF_MULTIPLY = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const VERHOEFF_PERMUTE = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

/**
 * @param {string} digits
 * @returns {boolean} Whether the last digit is the Verhoeff check digit.
 */
function verhoeff(digits) {
  let check = 0;
  for (let i = 0; i < digits.length; i++) {
    const digit = Number(digits[digits.length - 1 - i]);
    check = VERHOEFF_MULTIPLY[check][VERHOEFF_PERMUTE[i % 8][digit]];
  }
  return check === 0;
}

// "2739 3903 6552": 12 digits in groups of 4, never starting with 0 or 1.
const AADHAAR = /(?<![\w.-])[2-9]\d{3}([ -]?)\d{4}\1\d{4}(?![\w-]|\.\d)/g;
// "Aadhaar" and its common spellings "adhar", "adhaar" and "aadhar", and
// "UID" only in capitals, as "uid" is common in code.
const AADHAAR_CUE = /\b(?:[Aa]a?dha{1,2}r|AA?DHAA?R|uidai|UIDAI|UID)\b/;

/** @type {Rule} */
export const aadhaarIN = {
  name: "aadhaarIN",
  type: "NATIONAL_ID",
  detect({ text }) {
    const spans = [];
    for (const match of matches(AADHAAR, text)) {
      if (
        verhoeff(digitsOf(match.text)) &&
        hasCueNear(text, match.start, match.end, AADHAAR_CUE)
      ) {
        spans.push({
          start: match.start,
          end: match.end,
          type: "NATIONAL_ID",
          evidence: EVIDENCE.CHECKSUM_CUE,
          country: "IN_AADHAAR",
        });
      }
    }
    return spans;
  },
};

// "ABCPE1234F": an Indian Permanent Account Number, in capitals as it is
// always written. Three letters, the holder type (P for a person, C for a
// company and so on), the first letter of the name, 4 digits and a check
// letter whose algorithm is not published.
const PAN = /(?<![\w-])[A-Z]{3}[ABCFGHJLPT][A-Z]\d{4}[A-Z](?![\w-])/g;

/** @type {Rule} */
export const panIN = {
  name: "panIN",
  type: "NATIONAL_ID",
  detect({ text }) {
    const spans = [];
    for (const match of matches(PAN, text)) {
      spans.push({
        start: match.start,
        end: match.end,
        type: "NATIONAL_ID",
        evidence: EVIDENCE.FORMAT,
        country: "IN_PAN",
      });
    }
    return spans;
  },
};

// "123 456 782": an Australian Tax File Number of 9 digits, or of 8 for some
// issued before 1990, in groups of 3 with the same separator or none.
const TFN = /(?<![\w.-])\d{3}([ -]?)\d{3}\1\d{2,3}(?![\w-]|\.\d)/g;
const TFN_CUE = /\btfn\b|\btax\s+file\b/i;

/**
 * @param {string} digits - Eight or nine digits.
 * @returns {boolean} Whether the weighted sum is a multiple of 11.
 */
function isTFN(digits) {
  const weights =
    digits.length === 9
      ? [1, 4, 3, 7, 5, 8, 6, 9, 10]
      : [10, 7, 8, 4, 6, 3, 5, 1];
  return weighted(digits, weights) % 11 === 0;
}

/** @type {Rule} */
export const tfnAU = {
  name: "tfnAU",
  type: "NATIONAL_ID",
  detect({ text }) {
    const spans = [];
    for (const match of matches(TFN, text)) {
      if (
        isTFN(digitsOf(match.text)) &&
        hasCueNear(text, match.start, match.end, TFN_CUE)
      ) {
        spans.push({
          start: match.start,
          end: match.end,
          type: "NATIONAL_ID",
          evidence: EVIDENCE.CHECKSUM_CUE,
          country: "AU_TFN",
        });
      }
    }
    return spans;
  },
};

// "6215 57417 3": an Australian Medicare card number, 4, 5 and 1 digits with
// the same separator or none, and optionally the 1-digit reference number of
// the person on the card.
const MEDICARE =
  /(?<![\w.-])[2-6]\d{3}([ -]?)\d{5}\1\d(?:\1\d)?(?![\w-]|\.\d)/g;
const MEDICARE_CUE = /\bmedicare\b/i;

/**
 * @param {string} digits - Ten or eleven digits.
 * @returns {boolean} Whether the ninth digit is the weighted check digit and
 *   the issue number, the tenth, is not 0.
 */
function isMedicareNumber(digits) {
  return (
    digits[9] !== "0" &&
    weighted(digits, [1, 3, 7, 9, 1, 3, 7, 9]) % 10 === Number(digits[8])
  );
}

/** @type {Rule} */
export const medicareAU = {
  name: "medicareAU",
  type: "NATIONAL_ID",
  detect({ text }) {
    const spans = [];
    for (const match of matches(MEDICARE, text)) {
      if (
        isMedicareNumber(digitsOf(match.text)) &&
        hasCueNear(text, match.start, match.end, MEDICARE_CUE)
      ) {
        spans.push({
          start: match.start,
          end: match.end,
          type: "NATIONAL_ID",
          evidence: EVIDENCE.CHECKSUM_CUE,
          country: "AU_MEDICARE",
        });
      }
    }
    return spans;
  },
};

// "046 454 286": a Canadian Social Insurance Number, 9 digits in groups of 3
// with the same separator or none.
const SIN = /(?<![\w.-])\d{3}([ -]?)\d{3}\1\d{3}(?![\w-]|\.\d)/g;
// "SIN" only in capitals: in Spanish "sin" means "without".
const SIN_CUE =
  /\bSIN\b|\b(?:[Ss]ocial|SOCIAL)\s+(?:[Ii]nsurance|INSURANCE)\b|\b(?:[Aa]ssurance|ASSURANCE)\s+(?:[Ss]ociale|SOCIALE)\b/;

/** @type {Rule} */
export const sinCA = {
  name: "sinCA",
  type: "NATIONAL_ID",
  detect({ text }) {
    const spans = [];
    for (const match of matches(SIN, text)) {
      if (
        luhn(digitsOf(match.text)) &&
        hasCueNear(text, match.start, match.end, SIN_CUE)
      ) {
        spans.push({
          start: match.start,
          end: match.end,
          type: "NATIONAL_ID",
          evidence: EVIDENCE.CHECKSUM_CUE,
          country: "CA_SIN",
        });
      }
    }
    return spans;
  },
};

// "1234567T": an Irish Personal Public Service Number, 7 digits, a check
// letter and, on numbers issued since 2013, a second letter A to I or W.
// The first digit comes before the check on the character in front of it, so
// that matching only starts at a digit.
const PPS =
  /(?<digits>\d(?<![\w.-]\d)\d{6})[ -]?(?<check>[A-W])(?<second>[A-IW])?(?![\w-])/g;
// The check letter for each remainder modulo 23.
const PPS_CHECK_LETTERS = "WABCDEFGHIJKLMNOPQRSTUV";

/**
 * @param {Record<string, string>} groups - "digits", "check" and an optional
 *   "second" letter.
 * @returns {boolean} Whether the check letter matches the weighted digits
 *   and second letter.
 */
function isPPSNumber({ digits, check, second }) {
  let sum = weighted(digits, [8, 7, 6, 5, 4, 3, 2]);
  if (second) {
    sum += (second.charCodeAt(0) - 64) * 9;
  }
  return PPS_CHECK_LETTERS[sum % 23] === check;
}

/** @type {Rule} */
export const ppsIE = {
  name: "ppsIE",
  type: "NATIONAL_ID",
  detect({ text }) {
    const spans = [];
    for (const match of matches(PPS, text)) {
      if (isPPSNumber(match.groups)) {
        spans.push({
          start: match.start,
          end: match.end,
          type: "NATIONAL_ID",
          evidence: EVIDENCE.CHECKSUM,
          country: "IE_PPSN",
        });
      }
    }
    return spans;
  },
};

// "49-091-850": a New Zealand IRD number, 8 or 9 digits in groups of 2 or 3,
// 3 and 3 with the same separator or none.
const IRD = /(?<![\w.-])\d{2,3}([ -]?)\d{3}\1\d{3}(?![\w-]|\.\d)/g;
const IRD_CUE = /\bird\b|\binland\s+revenue\b/i;

/**
 * @param {string} digits - Eight or nine digits.
 * @returns {boolean} Whether the number is in the issued range and its last
 *   digit is the modulus 11 check digit (Inland Revenue, 2020 specification).
 */
function isIRDNumber(digits) {
  const number = Number(digits);
  if (number < 10000000 || number > 150000000) {
    return false;
  }
  const padded = digits.padStart(9, "0");
  /** @param {number[]} weights */
  const checkDigit = weights => {
    const remainder = weighted(padded, weights) % 11;
    return remainder === 0 ? 0 : 11 - remainder;
  };
  let check = checkDigit([3, 2, 7, 6, 5, 4, 3, 2]);
  if (check === 10) {
    check = checkDigit([7, 4, 3, 2, 5, 2, 7, 6]);
  }
  return check === Number(padded[8]);
}

/** @type {Rule} */
export const irdNZ = {
  name: "irdNZ",
  type: "NATIONAL_ID",
  detect({ text }) {
    const spans = [];
    for (const match of matches(IRD, text)) {
      if (
        isIRDNumber(digitsOf(match.text)) &&
        hasCueNear(text, match.start, match.end, IRD_CUE)
      ) {
        spans.push({
          start: match.start,
          end: match.end,
          type: "NATIONAL_ID",
          evidence: EVIDENCE.CHECKSUM_CUE,
          country: "NZ_IRD",
        });
      }
    }
    return spans;
  },
};

// "8001015009087": a South African ID number, 13 digits: date of birth as
// YYMMDD, 4 digits, a citizenship digit, a digit and a Luhn check digit.
const SOUTH_AFRICAN_ID = /(?<![\w.-])\d{13}(?![\w-]|\.\d)/g;

/**
 * @param {string} digits - Thirteen digits.
 * @returns {boolean} Whether the date of birth exists, the citizenship digit
 *   is 0 or 1 and the number passes Luhn.
 */
function isSouthAfricanID(digits) {
  // The century is not encoded, so any year divisible by 4 allows 29
  // February.
  const year = 2000 + Number(digits.slice(0, 2));
  return (
    isRealDate(year, Number(digits.slice(2, 4)), Number(digits.slice(4, 6))) &&
    (digits[10] === "0" || digits[10] === "1") &&
    luhn(digits)
  );
}

/** @type {Rule} */
export const idZA = {
  name: "idZA",
  type: "NATIONAL_ID",
  detect({ text }) {
    const spans = [];
    for (const match of matches(SOUTH_AFRICAN_ID, text)) {
      if (isSouthAfricanID(match.text)) {
        spans.push({
          start: match.start,
          end: match.end,
          type: "NATIONAL_ID",
          evidence: EVIDENCE.CHECKSUM,
          country: "ZA_ID",
        });
      }
    }
    return spans;
  },
};

// "S1234567D": a Singapore NRIC (S and T, for citizens and permanent
// residents born before and since 2000) or FIN (F and G, for foreigners), 7
// digits and a check letter.
const NRIC =
  /(?<![\w-])(?<prefix>[STFG])(?<digits>\d{7})(?<check>[A-Z])(?![\w-])/g;

/**
 * @param {Record<string, string>} groups - "prefix", "digits" and "check".
 * @returns {boolean} Whether the check letter matches the weighted digits.
 */
function isNRIC({ prefix, digits, check }) {
  // T and G numbers, issued since 2000, add 4 to the sum.
  const offset = prefix === "T" || prefix === "G" ? 4 : 0;
  const remainder = (weighted(digits, [2, 7, 6, 5, 4, 3, 2]) + offset) % 11;
  const letters =
    prefix === "S" || prefix === "T" ? "JZIHGFEDCBA" : "XWUTRQPNMLK";
  return letters[remainder] === check;
}

/** @type {Rule} */
export const nricSG = {
  name: "nricSG",
  type: "NATIONAL_ID",
  detect({ text }) {
    const spans = [];
    for (const match of matches(NRIC, text)) {
      if (isNRIC(match.groups)) {
        spans.push({
          start: match.start,
          end: match.end,
          type: "NATIONAL_ID",
          evidence: EVIDENCE.CHECKSUM,
          country: "SG_NRIC",
        });
      }
    }
    return spans;
  },
};

// The check letter of a Spanish DNI or NIE for each remainder modulo 23.
const DNI_CHECK_LETTERS = "TRWAGMYFPDXBNJZSQVHLCKE";
// "12345678Z": a Spanish DNI, 8 digits and a check letter.
// As for PPS, the first digit comes before the check in front of it.
const DNI = /(?<digits>\d(?<![\w.-]\d)\d{7})[ -]?(?<check>[A-Z])(?![\w-])/g;

/** @type {Rule} */
export const dniES = {
  name: "dniES",
  type: "NATIONAL_ID",
  detect({ text }) {
    const spans = [];
    for (const match of matches(DNI, text)) {
      const { digits, check } = match.groups;
      if (DNI_CHECK_LETTERS[Number(digits) % 23] === check) {
        spans.push({
          start: match.start,
          end: match.end,
          type: "NATIONAL_ID",
          evidence: EVIDENCE.CHECKSUM,
          country: "ES_DNI",
        });
      }
    }
    return spans;
  },
};
