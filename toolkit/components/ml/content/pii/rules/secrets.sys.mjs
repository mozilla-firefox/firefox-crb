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

// Vendor prefixes are distinctive enough to be replaced on sight.
const API_KEYS = [
  /\bsk-[\w-]{20,}/g, // OpenAI, Anthropic and compatible APIs
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub tokens
  /\bgithub_pat_\w{40,}/g, // GitHub fine-grained tokens
  /\b(?:AKIA|ASIA|AGPA|AIDA|AROA)[0-9A-Z]{16}\b/g, // AWS access key ids
  /\bxox[abeprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /\bAIza[\w-]{35}\b/g, // Google
  /\bglpat-[\w-]{20,}/g, // GitLab
  /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g, // Stripe secret and restricted
  /\bSG\.[\w-]{22}\.[\w-]{43}\b/g, // SendGrid
  /\bnpm_[A-Za-z0-9]{36}\b/g, // npm
  /\bhf_[A-Za-z0-9]{30,}/g, // Hugging Face
];

/** @type {Rule} */
export const apiKey = {
  name: "apiKey",
  type: "API_KEY",
  detect({ text }) {
    const spans = [];
    for (const pattern of API_KEYS) {
      for (const match of matches(pattern, text)) {
        spans.push({
          start: match.start,
          end: match.end,
          type: "API_KEY",
          evidence: EVIDENCE.CHECKSUM,
        });
      }
    }
    return spans;
  },
};

// A PEM private key runs from its BEGIN line to the next END line. PGP
// armor adds " BLOCK" to the label.
const PEM_BEGIN = /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY(?: BLOCK)?-----/g;
const PEM_END = /-----END (?:[A-Z]+ )?PRIVATE KEY(?: BLOCK)?-----/g;
// Without a footer, as when a paste is cut short, the key runs over the
// base64 lines after the header. Lines are 64 characters long, so a run of 16
// stops at the first ordinary word. A line break lost on paste is a space.
const KEY_TEXT = /(?:\s+[A-Za-z0-9+/=]{16,})+/y;

/** @type {Rule} */
export const privateKey = {
  name: "privateKey",
  type: "API_KEY",
  detect({ text }) {
    // Headers and footers are found once each: a lazy BEGIN...END regex
    // rescans the rest of the text for every header, which is quadratic on
    // many headers with no footer.
    const ends = [...matches(PEM_END, text)];
    const spans = [];
    let next = 0;
    for (const begin of matches(PEM_BEGIN, text)) {
      while (next < ends.length && ends[next].start < begin.end) {
        next++;
      }
      let end = ends[next]?.end;
      if (end === undefined) {
        KEY_TEXT.lastIndex = begin.end;
        if (!KEY_TEXT.test(text)) {
          continue;
        }
        end = KEY_TEXT.lastIndex;
      }
      spans.push({
        start: begin.start,
        end,
        type: "API_KEY",
        evidence: EVIDENCE.CHECKSUM,
      });
    }
    return spans;
  },
};
