/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * @typedef {object} RuleSpan
 * @property {number} start - UTF-16 offset of the first character.
 * @property {number} end - UTF-16 offset after the last character.
 * @property {string} type - The identifier type, such as "EMAIL".
 * @property {number} evidence - One of the EVIDENCE levels.
 * @property {string} [country] - For NATIONAL_ID, which country format matched.
 */

/**
 * @typedef {object} RuleContext
 * @property {string} text - The text to scan.
 */

/**
 * @typedef {object} Rule
 * @property {string} name - Unique, such as "iban"; names the rule's test cases.
 * @property {string} type - The type of the spans the rule returns.
 * @property {(context: RuleContext) => RuleSpan[]} detect
 */

/**
 * @typedef {object} RegexMatch
 * @property {number} start
 * @property {number} end
 * @property {string} text
 * @property {Record<string, string>} groups - Named groups, empty when none.
 * @property {RegExpExecArray} match - The raw match, for numbered groups.
 */

/**
 * How specific the evidence for a span is. When two rules claim overlapping
 * text, the more specific evidence wins.
 */
export const EVIDENCE = { FORMAT: 1, CHECKSUM: 2, CHECKSUM_CUE: 3 };

/**
 * Every match of a global regular expression in `text`.
 *
 * @param {RegExp} regex - Must have the g flag.
 * @param {string} text
 * @returns {Generator<RegexMatch>}
 */
export function* matches(regex, text) {
  regex.lastIndex = 0;
  let match;
  while ((match = regex.exec(text)) !== null) {
    if (match[0].length === 0) {
      regex.lastIndex++;
      continue;
    }
    yield {
      start: match.index,
      end: match.index + match[0].length,
      text: match[0],
      groups: match.groups ?? {},
      match,
    };
  }
}
