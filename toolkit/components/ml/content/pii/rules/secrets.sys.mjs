/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { EVIDENCE, matches, trimTail } from "./util.sys.mjs";

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

// Finds URL-like text only. What is a password or a parameter in it is decided
// by the URL parser and by splitting the raw text, not by this pattern.
const URL_CANDIDATE = /\b[a-z][a-z0-9+.-]{1,12}:\/\/[^\s<>"'`]+/gi;

// Parameter names whose value is a credential.
const CREDENTIAL_PARAMS = new Set([
  "access_token",
  "access-token",
  "accesstoken",
  "id_token",
  "id-token",
  "idtoken",
  "refresh_token",
  "refresh-token",
  "refreshtoken",
  "auth_token",
  "auth-token",
  "authtoken",
  "token",
  "api_key",
  "api-key",
  "apikey",
  "api_secret",
  "api-secret",
  "apisecret",
  "secret_key",
  "secret-key",
  "secretkey",
  "access_key",
  "access-key",
  "accesskey",
  "private_key",
  "private-key",
  "privatekey",
  "secret",
  "client_secret",
  "client-secret",
  "clientsecret",
  "password",
  "passwd",
  "pwd",
  "sig",
  "signature",
  "x-amz-signature",
  "x-amz-security-token",
  "x-amz-credential",
  "x-goog-signature",
  "sessionid",
  "session_id",
  "session-id",
  "sid",
  "auth",
  "bearer",
  "private_token",
  "private-token",
  "privatetoken",
]);
// Short names that are credentials only when the value looks random.
const AMBIGUOUS_PARAMS = new Set(["key", "code", "k", "t", "s"]);

/**
 * @param {string} value
 * @returns {boolean} Whether `value` is long and mixes letters and digits.
 */
function looksRandom(value) {
  return value.length >= 12 && /[A-Za-z]/.test(value) && /\d/.test(value);
}

/**
 * @param {string} text
 * @param {string} chars
 * @param {number} from
 * @returns {number} The index of the first of `chars` at or after `from`, or
 *   `text.length`.
 */
function indexOfAny(text, chars, from) {
  for (let i = from; i < text.length; i++) {
    if (chars.includes(text[i])) {
      return i;
    }
  }
  return text.length;
}

/**
 * Decodes each "%XX" escape as one character. Enough for the ASCII names in
 * CREDENTIAL_PARAMS, and unlike decodeURIComponent it never throws, which
 * made text full of malformed escapes slow.
 *
 * @param {string} text
 * @returns {string}
 */
function decodeEscapes(text) {
  return text.replace(/%([0-9a-f]{2})/gi, (_, hex) =>
    String.fromCharCode(parseInt(hex, 16))
  );
}

/** @type {Rule} */
export const urlToken = {
  name: "urlToken",
  type: "URL_TOKEN",
  detect({ text }) {
    const spans = [];
    for (const match of matches(URL_CANDIDATE, text)) {
      const url = match.text.slice(
        0,
        trimTail(match.text, 0, match.text.length)
      );
      // The parser decides what is a password, the way the browser reads the
      // URL. Offsets come from the raw text, as the parser's values are
      // decoded and no longer line up with it.
      let parsed;
      try {
        parsed = new URL(url);
      } catch {
        continue;
      }
      const authorityStart = url.indexOf("://") + 3;
      if (parsed.password) {
        const authority = url.slice(
          authorityStart,
          indexOfAny(url, "/?#", authorityStart)
        );
        const at = authority.lastIndexOf("@");
        const colon = authority.indexOf(":");
        if (colon >= 0 && colon < at - 1) {
          spans.push({
            start: match.start + authorityStart + colon + 1,
            end: match.start + authorityStart + at,
            type: "URL_TOKEN",
            evidence: EVIDENCE.CHECKSUM,
          });
        }
      }
      // name=value pairs in the query and the fragment, separated by ? & # ;
      for (
        let separator = indexOfAny(url, "?#", authorityStart);
        separator < url.length;
      ) {
        const next = indexOfAny(url, "?&#;", separator + 1);
        const pair = url.slice(separator + 1, next);
        const equals = pair.indexOf("=");
        if (equals > 0) {
          const name = decodeEscapes(pair.slice(0, equals)).toLowerCase();
          const value = pair.slice(equals + 1);
          const isCredential =
            CREDENTIAL_PARAMS.has(name) ||
            (AMBIGUOUS_PARAMS.has(name) && looksRandom(value));
          if (isCredential && value.length >= 6) {
            const start = match.start + separator + 1 + equals + 1;
            spans.push({
              start,
              end: start + value.length,
              type: "URL_TOKEN",
              evidence: EVIDENCE.FORMAT,
            });
          }
        }
        separator = next;
      }
    }
    return spans;
  },
};
