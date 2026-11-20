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

// The account name in a home directory path, up to the next separator. The
// name excludes characters no file system allows in it.
const HOME_PATHS = [
  // macOS
  /(?<![\w.-])\/Users\/(?<name>[^/\s\\:*?"<>|]+)(?=\/|\s|$)/g,
  // Linux
  /(?<![\w.-])\/home\/(?<name>[^/\s\\:*?"<>|]+)(?=\/|\s|$)/g,
  // Windows, which ignores case.
  /(?<![\w.-])[A-Za-z]:\\Users\\(?<name>[^\\\s/:*?"<>|]+)(?=\\|\s|$)/gi,
];
// Shared, system and placeholder accounts, which identify no one.
const SYSTEM_ACCOUNTS = new Set([
  "shared",
  "public",
  "default",
  "guest",
  "root",
  "runner",
  "ubuntu",
  "ec2-user",
  "admin",
  "administrator",
  "user",
  "username",
  "you",
  "yourname",
  "your-name",
  "name",
  "me",
  "docker",
  "vagrant",
  "node",
  "appuser",
  "app",
  "www-data",
  "nobody",
  "defaultuser0",
  "{user}",
  "$user",
  "%username%",
]);

/** @type {Rule} */
export const homePath = {
  name: "homePath",
  type: "USERNAME",
  detect({ text }) {
    const spans = [];
    for (const pattern of HOME_PATHS) {
      for (const match of matches(pattern, text)) {
        // A path at the end of a sentence: "my home is /home/anna."
        const start = match.end - match.groups.name.length;
        const end = trimTail(text, start, match.end);
        const name = text.slice(start, end);
        if (name && !SYSTEM_ACCOUNTS.has(name.toLowerCase())) {
          // A path has no checksum: its shape makes the name as specific as
          // one.
          spans.push({
            start,
            end,
            type: "USERNAME",
            evidence: EVIDENCE.CHECKSUM,
          });
        }
      }
    }
    return spans;
  },
};

// "username: firefox_fan99", "log in as admin_kyle": the model reads a product
// word inside a handle ("firefox", "pixel8pro") as a product, so a handle after
// a login cue is found here.
const LOGIN_CUE =
  "user\\s?name|user(?:\\s?id)?|login(?:\\s?(?:name|id))?|log\\s?in\\s+as" +
  "|logged\\s+in\\s+as|sign(?:ed)?\\s?in\\s+as|screen\\s?name|gamertag" +
  "|steam\\s?id|psn(?:\\s?id)?|nick(?:name)?|benutzername|nutzername" +
  "|utilisateur|usuario|gebruikersnaam|u[żz]ytkownik";
const LOGIN_USER = new RegExp(
  [
    // The word start is checked after the cue, against the cue just matched,
    // so that matching does not test it at every character.
    `(?<cue>${LOGIN_CUE})(?<![\\p{L}\\p{N}_]\\k<cue>)`,
    // Not part of a longer word or an email address.
    "(?![\\p{L}\\p{N}_@])",
    // An optional "is", "as", ":" or "=", owning the spaces after it. A word
    // must end, so that "isabel_99" keeps its "is".
    `\\s*(?:(?:(?:is|as|ist|est|es)${WORD_END}|:|=)\\s*)?`,
    // An optional "@", then the handle.
    "@?(?<value>[A-Za-z0-9][A-Za-z0-9_.-]{2,31})",
  ].join(""),
  "giu"
);
// Example and placeholder names that identify no one.
const PLACEHOLDER_USERS = new Set([
  "user",
  "user_",
  "userid",
  "user_id",
  "username",
  "user_name",
  "yourname",
  "your_name",
  "yourusername",
  "your_username",
  "example",
  "testuser",
  "test_user",
  "johndoe",
  "john_doe",
  "name",
  "null",
  "none",
  "undefined",
  "admin",
  "root",
]);

/** @type {Rule} */
export const loginUser = {
  name: "loginUser",
  type: "USERNAME",
  detect({ text }) {
    const spans = [];
    for (const match of matches(LOGIN_USER, text)) {
      const start = match.end - match.groups.value.length;
      const end = trimTail(text, start, match.end, ".-");
      const value = text.slice(start, end);
      if (value.length < 3 || PLACEHOLDER_USERS.has(value.toLowerCase())) {
        continue;
      }
      // Code such as user_id(...) or user = ...
      if (text[end] === "(" || text[end] === "=") {
        continue;
      }
      // A handle mixes a letter with an underscore or a digit, or follows an
      // "@": "user John" and "login page" are left alone.
      const afterAt = text[start - 1] === "@";
      if (!/[A-Za-z]/.test(value) || !(afterAt || /[_\d]/.test(value))) {
        continue;
      }
      spans.push({
        // The "@" is part of the handle, as in atHandle.
        start: afterAt ? start - 1 : start,
        end,
        type: "USERNAME",
        evidence: EVIDENCE.CHECKSUM_CUE,
      });
    }
    return spans;
  },
};
