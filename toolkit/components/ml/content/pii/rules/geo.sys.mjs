/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { EVIDENCE, matches } from "./util.sys.mjs";

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
