/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { EVIDENCE, matches } from "./util.sys.mjs";

/** @import { Rule } from "./util.sys.mjs" */

// The common subset of RFC 5322 addresses, in any script.
const EMAIL = new RegExp(
  [
    // The local part, read backwards from the "@" so that matching only
    // starts at an "@": a letter or digit not inside a longer address or
    // word, then up to 63 more characters.
    "(?<=(?<![\\w.+%-])(?<local>[\\p{L}\\p{N}][\\p{L}\\p{N}._%+-]{0,63}))",
    "@",
    // Domain labels of up to 63 characters, with no hyphen at either end,
    // each followed by a dot.
    "(?:[\\p{L}\\p{N}](?:[\\p{L}\\p{N}-]{0,61}[\\p{L}\\p{N}])?\\.)+",
    // Top-level domain of letters only, so "v1.2@3.4" is not an address.
    "\\p{L}{2,24}",
    // Not followed by more of a word or by another "@".
    "(?![\\p{L}\\p{N}@])",
  ].join(""),
  "giu"
);

// Shared business mailboxes such as support@example.com belong to a company,
// not a person, so they are left alone. Only the exact local part counts:
// "jane.support@" and "support.team@" are still replaced.
const ROLE_ACCOUNTS = new Set([
  "support",
  "help",
  "helpdesk",
  "info",
  "contact",
  "contacts",
  "sales",
  "billing",
  "privacy",
  "service",
  "services",
  "customerservice",
  "customercare",
  "care",
  "feedback",
  "press",
  "media",
  "jobs",
  "careers",
  "hr",
  "legal",
  "abuse",
  "security",
  "admin",
  "webmaster",
  "postmaster",
  "hello",
  "team",
  "noreply",
  "no-reply",
  "donotreply",
  "do-not-reply",
  "atencionalcliente",
  "atencioncliente",
  "servicioalcliente",
  "soporte",
  "contacto",
  "ventas",
  "kundenservice",
  "kontakt",
  "service-client",
  "serviceclient",
  "contato",
  "suporte",
  "atendimento",
  "contatto",
  "assistenza",
  "klantenservice",
  "obsluga",
  "biuro",
  "reklamacje",
]);

/** @type {Rule} */
export const email = {
  name: "email",
  type: "EMAIL",
  detect({ text }) {
    const spans = [];
    let lastEnd = 0;
    for (const match of matches(EMAIL, text)) {
      const local = match.groups.local;
      const start = match.start - local.length;
      // The lookbehind can reach back into the previous address.
      if (start < lastEnd || ROLE_ACCOUNTS.has(local.toLowerCase())) {
        continue;
      }
      lastEnd = match.end;
      spans.push({
        start,
        end: match.end,
        type: "EMAIL",
        evidence: EVIDENCE.FORMAT,
      });
    }
    return spans;
  },
};
