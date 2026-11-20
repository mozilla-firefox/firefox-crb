/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { EVIDENCE, matches } from "./util.sys.mjs";

/** @import { Rule } from "./util.sys.mjs" */

const IPV4 = new RegExp(
  [
    // Not inside a longer number, word or dotted name.
    "(?<![\\w.-])",
    // Four groups of 1 to 3 digits separated by dots.
    "(?:\\d{1,3}\\.){3}\\d{1,3}",
    // Not followed by more of a word, or by a fifth group.
    "(?![\\w-]|\\.\\d)",
  ].join(""),
  "g"
);

// "v1.2.3.4" or "version 10.0.0.1" is a version number, not an address.
const VERSION_CUE =
  /(?:\bv(?:ersion|er)?\.?\s*|\bversion\s+|\bapp\s+|\bpython\s+|\bnode\s+|\bsdk\s+)$/i;

/** @type {Rule} */
export const ipv4 = {
  name: "ipv4",
  type: "IP",
  detect({ text }) {
    const spans = [];
    for (const match of matches(IPV4, text)) {
      const parts = match.text.split(".");
      if (parts.some(part => Number(part) > 255)) {
        continue;
      }
      if (
        VERSION_CUE.test(text.slice(Math.max(0, match.start - 14), match.start))
      ) {
        continue;
      }
      if (parts.some(part => part.length > 1 && part.startsWith("0"))) {
        continue;
      }
      spans.push({
        start: match.start,
        end: match.end,
        type: "IP",
        evidence: EVIDENCE.FORMAT,
      });
    }
    return spans;
  },
};

const IPV6_CANDIDATE = new RegExp(
  [
    // The first group, read backwards from the first colon so that matching
    // only starts at a colon, and not inside a longer word, address or
    // dotted name.
    "(?<=(?<head>(?<![\\w:.])[0-9a-f]{0,4})):",
    // 3 to 8 groups in all of up to 4 hex digits separated by colons. Groups
    // can be empty for "::"; validIPv6 checks the structure.
    "(?:[0-9a-f]{0,4}:){1,6}[0-9a-f]{0,4}",
    "(?![\\w:])",
  ].join(""),
  "gi"
);

/**
 * Whether the URL parser accepts `candidate` as an IPv6 host: 8 groups, or
 * fewer with a single "::". Times such as 10:30:45 have neither.
 *
 * @param {string} candidate
 * @returns {boolean}
 */
function validIPv6(candidate) {
  return URL.canParse(`http://[${candidate}]/`);
}

/** @type {Rule} */
export const ipv6 = {
  name: "ipv6",
  type: "IP",
  detect({ text }) {
    const spans = [];
    for (const match of matches(IPV6_CANDIDATE, text)) {
      const { head } = match.groups;
      const candidate = `${head}${match.text}`;
      // "::" alone, as in Haskell's "x :: Int", has no address in it.
      if (!/[0-9a-f]/i.test(candidate) || !validIPv6(candidate)) {
        continue;
      }
      spans.push({
        start: match.start - head.length,
        end: match.end,
        type: "IP",
        evidence: EVIDENCE.FORMAT,
      });
    }
    return spans;
  },
};

const MAC = new RegExp(
  [
    // Each form is matched from its first separator, with the hex digits
    // before it read backwards, so that matching only starts at a separator.
    // Six pairs of hex digits, all separated by the same ":" or "-"
    // (captured, then repeated with \\k<separator>).
    "(?<=(?<pairHead>(?<![\\w:.-])[0-9a-f]{2}))(?<separator>[:-])",
    "(?:[0-9a-f]{2}\\k<separator>){4}[0-9a-f]{2}(?![\\w:-])",
    // Or three dotted groups of four, as Cisco writes them.
    "|(?<=(?<dotHead>(?<![\\w.])[0-9a-f]{4}))\\.[0-9a-f]{4}\\.[0-9a-f]{4}(?![\\w.])",
  ].join(""),
  "gi"
);

/** @type {Rule} */
export const mac = {
  name: "mac",
  type: "MAC",
  detect({ text }) {
    const spans = [];
    for (const match of matches(MAC, text)) {
      const head = match.groups.pairHead ?? match.groups.dotHead;
      spans.push({
        start: match.start - head.length,
        end: match.end,
        type: "MAC",
        evidence: EVIDENCE.FORMAT,
      });
    }
    return spans;
  },
};
