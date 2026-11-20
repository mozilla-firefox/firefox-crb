/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  EVIDENCE,
  WORD_END,
  WORD_START,
  matches,
  trimTail,
} from "./util.sys.mjs";

/** @import { Rule, RegexMatch } from "./util.sys.mjs" */

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

// The model reads "Firefox123" in "password is Firefox123" as a product, so a
// secret introduced by a password cue is found here. In 8 languages.
const PASSWORD_CUE =
  "passwords?|passw[oö]rt|passwd|pwd|pw|pass\\s?code|pin(?:\\s?code)?" +
  "|kennwort|mot\\s+de\\s+passe|mdp|contrase[ñn]a|clave|senha|has[łl]o" +
  "|wachtwoord|codice";
// ":", "=" or "is" in 8 languages between the cue and the value.
const PASSWORD_IS = `(?::|=|${WORD_START}(?:is|are|ist|est|es|[ée]|jest)${WORD_END})`;
// An optional "for <account>" between the cue and "is". The account starts
// with a non-space, so the spaces before it are not also claimed by the
// account and the spaces after it, which made matching quadratic on long runs
// of spaces.
const PASSWORD_FOR =
  "(?:\\s+(?:for|of|to|on|von|f[üu]r|pour|para|voor|dla)\\s+[^\\s:;=][^\\n:;=]{0,39}?)?";
// The value: 3 to 64 characters without spaces, brackets or quotes.
const PASSWORD_VALUE = "(?<value>[^\\s,;()\\[\\]{}<>\"'`]{3,64})";

// "password for the wifi is hunter2", "PIN: 4821", "mot de passe = Soleil42".
const PASSWORD_ASSIGNED = new RegExp(
  [
    // The word start is checked after the cue, against the cue just matched,
    // so that matching does not test it at every character.
    `(?<cue>${PASSWORD_CUE})(?<![\\p{L}\\p{N}_]\\k<cue>)`,
    PASSWORD_FOR,
    `\\s*${PASSWORD_IS}\\s*`,
    // An optional opening quote.
    "[\"'`]?",
    PASSWORD_VALUE,
  ].join(""),
  "giu"
);

// "pw hunter2" with no "is": the value must also contain a digit or a symbol.
const PASSWORD_BARE = new RegExp(
  [
    WORD_START,
    "(?<cue>pw|pwd|passcode|pin|passwd)",
    // Spaces, then an optional opening quote.
    "\\s+[\"'`]?",
    PASSWORD_VALUE,
  ].join(""),
  "giu"
);

// "seed phrase: correct horse battery staple".
const PASSPHRASE = new RegExp(
  [
    WORD_START,
    "(?:pass\\s?phrase|seed\\s+phrase|recovery\\s+phrase)",
    // ":", "=" or "is".
    `(?:\\s*[:=]|\\s+(?<is>is)${WORD_END})\\s*`,
    // The value: 5 to 300 characters, enough for 24 words, up to the end of
    // the line, a ";" or a bracket.
    // A sentence end stops it too: a "." or "!" inside a passphrase is
    // followed by more of it.
    "(?<value>(?:[^\\n;().!?]|[.!?](?=[^\\s.!?])){5,300})",
  ].join(""),
  "giu"
);

// "password is required" is a sentence about a password, not a password.
const NOT_A_SECRET = new Set(
  (
    "a an the my your our his her its their this that these those it not no " +
    "yes ok okay fine wrong incorrect invalid expired required missing empty " +
    "blank weak strong secure safe correct valid long short too being still " +
    "now already never always stored saved changed reset visible hidden case " +
    "sensitive confidential private public default same different set unset " +
    "locked disabled enabled managed protected encrypted hashed unknown shown " +
    "masked what which how why when where who if and or but for to of in on " +
    "at by with from as is are was be been has have had do does did will " +
    "would can could should must may might need needs manager please und " +
    "oder der die das secret ein eine nicht falsch le la les un une pas el " +
    "los las es est ist"
  ).split(" ")
);

/**
 * @param {string} text
 * @param {RegexMatch} match - Has a named group "value" at its end.
 * @returns {{start: number, end: number} | null} The value without trailing
 *   punctuation, or null if it is a word about the secret.
 */
function secretSpan(text, match) {
  const start = match.end - match.groups.value.length;
  const end = trimTail(text, start, match.end, ".,;:?)]}'\"");
  const value = text.slice(start, end);
  if (value.length < 3 || NOT_A_SECRET.has(value.toLowerCase())) {
    return null;
  }
  return { start, end };
}

/**
 * @param {string} text
 * @param {number} start
 * @returns {boolean} Whether `start` begins a URL parameter, which urlToken
 *   handles.
 */
function startsUrlParameter(text, start) {
  return start > 0 && "?&#;".includes(text[start - 1]);
}

/** @type {Rule} */
export const passwordAssigned = {
  name: "passwordAssigned",
  type: "SECRET_IN_CONTEXT",
  detect({ text }) {
    const spans = [];
    for (const match of matches(PASSWORD_ASSIGNED, text)) {
      if (startsUrlParameter(text, match.start)) {
        continue;
      }
      const span = secretSpan(text, match);
      if (span) {
        spans.push({
          ...span,
          type: "SECRET_IN_CONTEXT",
          evidence: EVIDENCE.CHECKSUM_CUE,
        });
      }
    }
    return spans;
  },
};

/** @type {Rule} */
export const passwordBare = {
  name: "passwordBare",
  type: "SECRET_IN_CONTEXT",
  detect({ text }) {
    const spans = [];
    for (const match of matches(PASSWORD_BARE, text)) {
      const span = secretSpan(text, match);
      if (!span) {
        continue;
      }
      const value = text.slice(span.start, span.end);
      // "pwd /home/anna" is the shell command and the path it prints.
      if (value.startsWith("/") || value.startsWith("~")) {
        continue;
      }
      // A bare "pin" is also a connector pin ("pin GPIO17"): only digits count.
      if (
        match.groups.cue.toLowerCase() === "pin" &&
        !/^\d{4,8}$/.test(value)
      ) {
        continue;
      }
      if (/\d/.test(value) || /[^\p{L}\p{N}]/u.test(value)) {
        spans.push({
          ...span,
          type: "SECRET_IN_CONTEXT",
          evidence: EVIDENCE.CHECKSUM_CUE,
        });
      }
    }
    return spans;
  },
};

/** @type {Rule} */
export const passphrase = {
  name: "passphrase",
  type: "SECRET_IN_CONTEXT",
  detect({ text }) {
    const spans = [];
    for (const match of matches(PASSPHRASE, text)) {
      const { is, value } = match.groups;
      // "passphrase is too long" is a sentence about the passphrase.
      if (is && NOT_A_SECRET.has(value.split(/\s/)[0].toLowerCase())) {
        continue;
      }
      const start = match.end - value.length;
      spans.push({
        start,
        end: trimTail(text, start, match.end, " .,;:!?"),
        type: "SECRET_IN_CONTEXT",
        evidence: EVIDENCE.CHECKSUM_CUE,
      });
    }
    return spans;
  },
};
