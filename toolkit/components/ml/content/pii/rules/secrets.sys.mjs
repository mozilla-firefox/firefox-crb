/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { EVIDENCE, matches } from "./util.sys.mjs";

/** @import { Rule } from "./util.sys.mjs" */

const JWT = new RegExp(
  [
    // Not inside a longer token.
    "(?<![\\w-])",
    // Header, payload and signature in base64url. A JSON header always starts
    // with "eyJ", the encoding of '{"' and a letter.
    "eyJ[\\w-]{5,}\\.[\\w-]{5,}\\.[\\w-]*",
  ].join(""),
  "g"
);

/**
 * @param {string} part - A base64url segment without padding.
 * @returns {boolean} Whether it decodes to JSON.
 */
function decodesToJson(part) {
  try {
    const bytes = ChromeUtils.base64URLDecode(part, { padding: "ignore" });
    JSON.parse(new TextDecoder().decode(bytes));
    return true;
  } catch {
    return false;
  }
}

/** @type {Rule} */
export const jwt = {
  name: "jwt",
  type: "JWT",
  detect({ text }) {
    const spans = [];
    for (const match of matches(JWT, text)) {
      if (decodesToJson(match.text.split(".")[0])) {
        spans.push({
          start: match.start,
          end: match.end,
          type: "JWT",
          evidence: EVIDENCE.CHECKSUM,
        });
      }
    }
    return spans;
  },
};
