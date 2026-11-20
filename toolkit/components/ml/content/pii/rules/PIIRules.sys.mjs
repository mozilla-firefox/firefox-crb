/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Deterministic detectors for identifiers with a fixed or checkable format,
 * such as emails, IBANs and national IDs. They only detect; replacing text is
 * up to the caller.
 */

import {
  bitcoinLegacy,
  bitcoinSegwit,
  card,
  cvv,
  ethereum,
  iban,
  routing,
} from "./finance.sys.mjs";
import { email } from "./email.sys.mjs";
import {
  gpsLabeled,
  gpsPairComma,
  gpsPairSpace,
  poBox,
  postcodeCanada,
  postcodeCued,
  postcodeUK,
  zipAfterState,
} from "./geo.sys.mjs";
import { ipv4, ipv6, mac } from "./network.sys.mjs";
import {
  phoneCued,
  phoneDE,
  phoneES,
  phoneFR,
  phoneGB,
  phoneInternational,
  phoneIT,
  phoneNL,
  phoneNorthAmerican,
  phonePL,
  phonePT,
} from "./phone.sys.mjs";
import {
  apiKey,
  jwt,
  passphrase,
  passwordAssigned,
  passwordBare,
  privateKey,
  secretKey,
  urlToken,
} from "./secrets.sys.mjs";
import {
  atHandle,
  discordTag,
  homePath,
  loginUser,
  platformAt,
  redditUser,
} from "./social.sys.mjs";

/** @import { Rule, RuleSpan } from "./util.sys.mjs" */

export { EVIDENCE } from "./util.sys.mjs";

/** @type {Rule[]} */
export const RULES = [
  email,
  iban,
  card,
  cvv,
  bitcoinLegacy,
  bitcoinSegwit,
  ethereum,
  routing,
  ipv4,
  ipv6,
  mac,
  jwt,
  apiKey,
  privateKey,
  urlToken,
  passwordAssigned,
  passwordBare,
  passphrase,
  secretKey,
  atHandle,
  redditUser,
  discordTag,
  homePath,
  loginUser,
  platformAt,
  phoneInternational,
  phoneNorthAmerican,
  phoneCued,
  phoneFR,
  phoneNL,
  phoneDE,
  phoneES,
  phonePT,
  phonePL,
  phoneIT,
  phoneGB,
  gpsLabeled,
  gpsPairComma,
  gpsPairSpace,
  poBox,
  postcodeUK,
  postcodeCanada,
  zipAfterState,
  postcodeCued,
];

/**
 * Keeps one span wherever candidates overlap: the more specific evidence
 * wins, then the longer span, then the earlier one. Empty spans are dropped.
 *
 * @param {RuleSpan[]} candidates - In any order.
 * @returns {RuleSpan[]} Non-overlapping spans, sorted by start.
 */
export function resolveOverlaps(candidates) {
  const ranked = candidates
    .filter(span => span.end > span.start)
    .sort(
      (a, b) =>
        b.evidence - a.evidence ||
        b.end - b.start - (a.end - a.start) ||
        a.start - b.start
    );
  // `accepted` stays sorted by start and non-overlapping, so only the two
  // neighbors of the insertion point can overlap a candidate.
  /** @type {RuleSpan[]} */
  const accepted = [];
  for (const candidate of ranked) {
    let low = 0;
    let high = accepted.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (accepted[middle].start < candidate.start) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    const previous = accepted[low - 1];
    const next = accepted[low];
    if (
      (previous && previous.end > candidate.start) ||
      (next && next.start < candidate.end)
    ) {
      continue;
    }
    accepted.splice(low, 0, candidate);
  }
  return accepted;
}

/**
 * Finds the identifiers the rules own in `text`.
 *
 * @param {string} text
 * @param {object} [options]
 * @param {string} [options.region] - The user's region as an upper-case ISO
 *   3166-1 code, such as "FR". Some layouts are only phone numbers in their
 *   own country, so they are found only when it is given.
 * @returns {RuleSpan[]} Non-overlapping spans, sorted by start. Offsets are
 *   UTF-16 code units.
 */
export function detectRules(text, { region } = {}) {
  if (typeof text !== "string") {
    throw new TypeError("detectRules expects a string.");
  }
  const context = { text, region };
  return resolveOverlaps(RULES.flatMap(rule => rule.detect(context)));
}
