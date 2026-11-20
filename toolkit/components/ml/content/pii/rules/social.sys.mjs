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

/** @import { Rule } from "./util.sys.mjs" */

// Platforms and account words, in 8 languages.
const PLATFORM =
  "insta(?:gram)?|twitter|x|tiktok|snap(?:chat)?|telegram|discord|reddit" +
  "|github|gitlab|mastodon|bluesky|threads|youtube|twitch|facebook|fb" +
  "|linkedin|handle|username|user\\s?name|nickname|nick|gamertag|pseudo" +
  "|account|profile|channel|benutzername|nutzername|utilisateur|usuario" +
  "|nome\\s+utente|u[żz]ytkownik|gebruikersnaam";
const POSSESSIVE =
  "(?:my|mine|mein[e]?[nrms]?|mon|ma|mes|mi|mis|mio|mia|meu|minha|m[óo]j" +
  "|moja|moje|mijn)";

// "@maria.lopez99" alone could be a public account or code, so a handle only
// counts after a first-person cue: "my insta", "follow me", "mein Insta".
const SELF_CUE = new RegExp(
  [
    WORD_START,
    "(?:",
    // "my insta", "my old twitter account": a possessive, up to 2 words, and
    // a platform.
    `${POSSESSIVE}\\s+(?:\\p{L}+\\s+){0,2}?(?:${PLATFORM})`,
    // "follow me" in 8 languages.
    "|(?:follow|find|add|dm|message|ping|tag)\\s+me|folge\\s+mir|suis[- ]moi",
    "|s[íi]gueme|seguimi|segue[- ]me|[śs]led[źz]\\s+mnie|volg\\s+mij",
    ")",
    WORD_END,
  ].join(""),
  "iu"
);

/**
 * @param {string} text
 * @param {number} start
 * @returns {boolean} Whether a first-person cue ends in the 70 characters
 *   before `start`.
 */
function hasSelfCue(text, start) {
  return SELF_CUE.test(text.slice(Math.max(0, start - 70), start));
}

// "@" words in code: decorators, JSDoc tags and CSS at-rules.
const CODE_AT_WORDS = new Set([
  "override",
  "test",
  "autowired",
  "component",
  "deprecated",
  "suppresswarnings",
  "injectable",
  "input",
  "output",
  "param",
  "returns",
  "see",
  "author",
  "media",
  "import",
  "font-face",
  "keyframes",
  "supports",
  "layer",
  "property",
  "dataclass",
  "staticmethod",
  "classmethod",
  "property.setter",
]);

// "@name": 2 to 30 handle characters, not inside an email address, a path or
// a longer word.
const AT_HANDLE =
  /(?<![\w@./+-])@[A-Za-z0-9_][A-Za-z0-9_.-]{1,29}(?![\w@]|\/)/g;

/** @type {Rule} */
export const atHandle = {
  name: "atHandle",
  type: "USERNAME",
  detect({ text }) {
    const spans = [];
    for (const match of matches(AT_HANDLE, text)) {
      // The first character after the "@" is never a dot or a dash, so at
      // least one stays.
      const end = trimTail(text, match.start + 1, match.end, ".-");
      const name = text.slice(match.start + 1, end).toLowerCase();
      if (!CODE_AT_WORDS.has(name) && hasSelfCue(text, match.start)) {
        // A handle has no checksum: it is labelled CHECKSUM because its cue
        // makes it as specific as one.
        spans.push({
          start: match.start,
          end,
          type: "USERNAME",
          evidence: EVIDENCE.CHECKSUM,
        });
      }
    }
    return spans;
  },
};

// "u/name" or "/u/name": Reddit allows 3 to 20 letters, digits, "_" and "-".
const REDDIT_USER = /(?<![\w/])\/?u\/[A-Za-z0-9_-]{3,20}(?![\w-])/g;

/** @type {Rule} */
export const redditUser = {
  name: "redditUser",
  type: "USERNAME",
  detect({ text }) {
    const spans = [];
    for (const match of matches(REDDIT_USER, text)) {
      if (hasSelfCue(text, match.start)) {
        // As for atHandle, the cue stands in for a checksum.
        spans.push({
          start: match.start,
          end: match.end,
          type: "USERNAME",
          evidence: EVIDENCE.CHECKSUM,
        });
      }
    }
    return spans;
  },
};

// "name#1234", the legacy Discord tag: 2 to 32 name characters and 4 digits.
// The name is read backwards from the "#", so that matching only starts at a
// "#".
const DISCORD_TAG = /(?<=(?<![\w.@])(?<name>[A-Za-z0-9_.]{2,32}))#\d{4}(?!\d)/g;
const DISCORD_CUE = new RegExp(`${WORD_START}discord${WORD_END}`, "iu");
// Words that number things rather than name someone: "issue#1234".
const NOT_DISCORD_NAMES = new Set(
  "issue issues bug bugs pr pull ticket case order item task step page room build commit version no nr".split(
    " "
  )
);

/** @type {Rule} */
export const discordTag = {
  name: "discordTag",
  type: "USERNAME",
  detect({ text }) {
    const spans = [];
    for (const match of matches(DISCORD_TAG, text)) {
      const start = match.start - match.groups.name.length;
      const before = text.slice(Math.max(0, start - 60), start);
      if (
        !NOT_DISCORD_NAMES.has(match.groups.name.toLowerCase()) &&
        DISCORD_CUE.test(before)
      ) {
        // As for atHandle, the cue stands in for a checksum.
        spans.push({
          start,
          end: match.end,
          type: "USERNAME",
          evidence: EVIDENCE.CHECKSUM,
        });
      }
    }
    return spans;
  },
};
