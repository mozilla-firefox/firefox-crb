/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

/**
 * Test cases for the PII rules in toolkit/components/ml/content/pii/rules, one
 * block per rule. All values are synthetic: numbers come from published
 * examples where one exists (marked "published"), the rest were generated to
 * pass the check.
 *
 * In `finds`, each expected span is marked in place as "[[value]]", or as
 * "[[TYPE: value]]" when another rule's type is expected.
 * A value right next to a bracket cannot be marked this way.
 *
 * @typedef {object} RuleCases
 * @property {string} type - The type the rule returns.
 * @property {string} source - Where the format and its check come from.
 * @property {string[]} finds - Texts with every expected span marked.
 * @property {Array<[string, string]>} ignores - Look-alikes that must produce
 *   no span, each with the reason the rule rejects it.
 * @property {Record<string, (length: number) => string>} adversarial - Inputs
 *   that contain no identifier but are built to make the rule's patterns
 *   backtrack, by the length to build.
 */

/**
 * @param {string} unit
 * @param {number} length
 * @returns {string} `unit` repeated, cut to `length`.
 */
const repeatTo = (unit, length) =>
  unit.repeat(Math.ceil(length / unit.length)).slice(0, length);

/**
 * @param {string} unit
 * @param {number} length
 * @returns {string} Only whole copies of `unit`, padded with spaces to
 *   `length`, for inputs whose cut-off last copy could be valid.
 */
const wholeUnits = (unit, length) =>
  unit.repeat(Math.floor(length / unit.length)).padEnd(length);

// Published (jwt.io): {"alg":"HS256","typ":"JWT"} with a "John Doe" payload.
const JWT_HS =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
// {"alg":"RS256"}, {"iss":"acme","sub":"anna"}, "signature-bytes-here".
const JWT_RS =
  "eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJhY21lIiwic3ViIjoiYW5uYSJ9.c2lnbmF0dXJlLWJ5dGVzLWhlcmU";

/**
 * @param {...string} parts
 * @returns {string} The parts joined, so that no key appears whole in the
 *   source for secret scanners to flag.
 */
const joinParts = (...parts) => parts.join("");

const KEY = {
  openai: joinParts("sk-", "Ab3dE5gH7jK9mN1pQ3sT5vW7yZ9bC2eF4hJ6kL8n"),
  openaiProject: joinParts("sk-proj-", "Zx8Cv7Bn6Mm5Ll4Kk3Jj2Hh1Gg0Ff9Ee"),
  anthropic: joinParts(
    "sk-ant-api03-",
    "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-AbCd"
  ),
  ghp: joinParts("ghp_", "aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789"),
  ghpat: joinParts(
    "github_pat_",
    "11ABCDEFG0abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUV"
  ),
  // Published (AWS docs).
  aws: "AKIAIOSFODNN7EXAMPLE",
  slack: joinParts("xoxb-", "1234567890-0987654321-AbCdEfGhIjKlMnOpQrStUvWx"),
  google: joinParts("AIza", "SyA1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q"),
  gitlab: joinParts("glpat-", "AbCdEfGhIjKlMnOpQrSt"),
  stripe: joinParts("sk_live_", "AbCdEfGhIjKlMnOpQrStUvWx"),
  sendgrid: joinParts(
    "SG.",
    "AbCdEfGhIjKlMnOpQrStUv",
    ".",
    "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfG"
  ),
  npm: joinParts("npm_", "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"),
  hf: joinParts("hf_", "AbCdEfGhIjKlMnOpQrStUvWxYz01234567"),
};

/**
 * @param {string} label - Such as "RSA PRIVATE KEY".
 * @param {string} [body]
 * @param {string} [newline]
 * @returns {string} A PEM block, built here so that none appears whole in the
 *   source for secret scanners to flag.
 */
const pem = (label, body = "MIIEowIBAAKCAQEAsynthetic", newline = "\n") =>
  joinParts("-----BEGIN ", label, "-----", newline, body, newline) +
  joinParts("-----END ", label, "-----");

/** @type {Record<string, RuleCases>} */
export const RULE_CASES = {
  redditUser: {
    type: "USERNAME",
    source:
      "u/name with Reddit's 3 to 20 username characters, after a first-person cue",
    finds: [
      "my reddit is [[u/throwaway_8812]]",
      "follow me on reddit: [[/u/cat_lover-22]]",
      "my reddit account [[u/Ann_K]]",
      "find me at [[u/abc]]",
      "DM me, [[u/abcdefghij0123456789]]",
      "mein Reddit ist [[u/max_m]]",
      "mon reddit c'est [[u/lucie-m]]",
      "mi usuario de reddit es [[u/pedro_88]]",
      "message me: [[u/night_owl]].",
      "seguimi su reddit [[u/giulia_r]]",
      "volg mij: [[u/jan-dekker]]",
      "my old reddit account was [[u/old_acc_1]] (banned)",
    ],
    ignores: [
      ["check out u/spez's post", "no first-person cue"],
      ["follow u/spez", "'follow' without 'me'"],
      ["my reddit is u/ab", "shorter than 3 characters"],
      ["my reddit is u/abcdefghij0123456789x", "longer than 20 characters"],
      ["my reddit: r/firefox", "a subreddit"],
      [
        "my reddit is https://reddit.com/u/spez_fan",
        "inside a URL path, an accepted gap",
      ],
      ["my reddit cache is in src/u/tmp_files", "inside a path"],
      ["my reddit is au/thor", "u/ inside a word"],
      ["my reddit karma is high", "no u/name"],
      ["my reddit is u/ spez", "a space after u/"],
      ["follow me, I post as u_spez", "no slash"],
    ],
    adversarial: {
      "u/ in a row": length => repeatTo("u/", length),
      "a cue and a long name-like run": length =>
        `my reddit u/${"a".repeat(length - 12)}`,
      "many names with no cue": length =>
        wholeUnits("u/throwaway_8812 ", length),
      "slashes and u": length => repeatTo("/u/u/u/", length),
      "dashes after u/": length => `u/${"-".repeat(length - 2)}`,
    },
  },
  atHandle: {
    type: "USERNAME",
    source:
      "an @handle of 2 to 30 characters after a first-person cue such as 'my insta' or 'follow me'",
    finds: [
      "follow me on instagram [[@maria.lopez99]]",
      "my twitter is [[@jsmith_42]]",
      "my handle is [[@danny.k]]",
      "find me on tiktok [[@coolcat]]",
      "DM me [[@sam_w]]",
      "add me on snapchat [[@ed99]]",
      "my github is [[@octo-dev7]] and I pushed",
      "my old twitter account was [[@jsmith_42]]",
      "mein Instagram ist [[@anna.k]]",
      "folge mir auf Insta: [[@lena.b]]",
      "mon insta c'est [[@lucie_m]]",
      "sígueme en [[@pedro88]]",
      "seguimi su instagram [[@giulia.r]]",
      "śledź mnie [[@kasia_w99]]",
      "volg mij op [[@jan_dekker]]",
      // A trailing dot or dash is punctuation.
      "my insta is [[@kim.lee]]- thanks",
      "my insta is [[@kim.lee]].",
    ],
    ignores: [
      ["What did @elonmusk tweet today?", "no first-person cue"],
      ["follow @nytimes for news", "'follow' without 'me'"],
      ["contact @support", "no first-person cue"],
      ["my twitter is cool", "no @name"],
      ["follow me at 5 @ the gym", "no name after the @"],
      ["follow me @a", "a single character is too short"],
      [`my insta is @${"a".repeat(31)}`, "longer than 30 characters"],
      ["in my github repo I use @Override", "a Java annotation"],
      ["my profile CSS has @media screen", "a CSS at-rule"],
      ["my github project uses @angular/core", "a scoped package"],
      ["my insta login is anna@coolcat", "an @ inside a word"],
      [
        `my twitter is great and I post long threads about my two cats, ${"so ".repeat(4)}@coolcat`,
        "the cue is more than 70 characters before",
      ],
    ],
    adversarial: {
      "@ starts glued together": length => repeatTo("@a", length),
      "a cue and a long handle-like run": length =>
        `my insta @${"a".repeat(length - 10)}`,
      "many handles with no cue": length => wholeUnits("@coolcat ", length),
      "possessives with no platform before handles": length =>
        wholeUnits("my my my my my my @coolcat ", length),
      "dots and dashes after @": length => repeatTo("@a.-.-.-.-.-.-", length),
    },
  },
  secretKey: {
    type: "SECRET_IN_CONTEXT",
    source:
      "a long value that mixes letters with digits or both cases, after a key, token or secret cue",
    finds: [
      // Published (AWS docs).
      "AWS secret key [[wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY]]",
      // Published (AWS docs).
      "secret access key: [[je7MtGbClwBF/2Zp9Utk/h3yCo8nvbEXAMPLEKEY]]",
      "client secret: [[AbCdEf1234567890xyz]]",
      "access token = [[a1b2c3d4e5f6g7h8i9]]",
      'api_key: "[[Zm9vYmFyYmF6cXV4MTIz]]"',
      "my private key is [[MHcCAQEEIBkg4LVWM9nuwN]]",
      "auth token [[ya29.A0ARrdaM-abc123XYZ]]",
      "session_token=[[Xy7Zk9Lm2Qp4Rs6Tu8Vw]].",
      "api secret [[AbcdefGhijklMnopQ]]",
      "SECRET_KEY = '[[django-insecure-k3y9x2m7]]'",
      "bearer token: [[f7d6s5a4q3w2e1r0t9y8]]",
      // URL parameters are left to urlToken.
      "https://x.com/?client_secret=[[URL_TOKEN: Ab12Cd34Ef56Gh78Ij]]",
    ],
    ignores: [
      ["key management is hard", "no cue"],
      ["public key: Ab12Cd34Ef56Gh78Ij", "a public key"],
      [
        "the api is great, token: Ab12Cd34Ef56Gh78",
        "'token' alone is not a cue",
      ],
      ["mysecret key Ab12Cd34Ef56Gh78Ij", "secret inside a word"],
      ["the secret key to success is hard work", "no value of 16 characters"],
      ["access token: ghijkl", "shorter than 16 characters"],
      ["private key file", "no value of 16 characters"],
      ["session key exchange happens first", "no value of 16 characters"],
      ["secret token", "no value"],
      ["api key: lowercaseonlyletters", "one case and no digit"],
      ["secret key: 1234567890123456", "digits only"],
      [
        "const apiKeyValidationMiddleware = require(x)",
        "an identifier in code, with no separator after the cue",
      ],
    ],
    adversarial: {
      "a cue word then separators": length =>
        `secret${repeatTo(" _-", length - 6)}`,
      "a cue then spaces": length => `secret key${" ".repeat(length - 10)}`,
      "cues with one-case values": length =>
        wholeUnits("secret key: lowercaseonlyletters ", length),
      "cues with a long one-case value": length =>
        `api key ${"a".repeat(length - 8)}`,
      "cue words glued with dashes": length =>
        repeatTo("secret-access-api-session-", length),
    },
  },
  passphrase: {
    type: "SECRET_IN_CONTEXT",
    source:
      "the rest of the line after a passphrase or seed phrase cue and ':', '=' or 'is'",
    finds: [
      "Passphrase: [[blue monkey eats banana]] (KeePass)",
      "seed phrase: [[abandon ability able about above absent absorb abstract absurd abuse access accident]]",
      "recovery phrase = [[correct horse battery staple]]",
      "pass phrase: [[my dog has fleas]]",
      "passphrase=[[Tr0ub4dor&3]]",
      "Seed Phrase: [[zoo zoo zoo zoo wrong]].",
      "my passphrase: [[purple rain falls]]; the rest is fine",
      "passphrase:\t[[sunny day today]]",
      "recovery phrase: [[apple banana cherry date]]\nThanks!",
      "PASSPHRASE : [[open sesame now]]!",
      "seed phrase:  [[one two three four five six]]?",
      // 24 words, about 160 characters.
      "seed phrase: [[abandon ability able about above absent absorb abstract absurd abuse access accident account accuse achieve acid acoustic acquire across act action actor actress actual]]",
      "my passphrase is [[purple rain falls]]",
      "the recovery phrase is [[apple banana cherry date]].",
      "seed phrase: [[correct horse battery staple]]. Then I went to the store",
    ],
    ignores: [
      ["what is a seed phrase?", "no ':' or '='"],
      ["my passphrase is too long to remember", "a word about the passphrase"],
      ["the passphrase is required", "a word about the passphrase"],
      ["the passphrase isn't working", "isn't is not 'is'"],
      ["never share your recovery phrase", "no ':' or '='"],
      ["passphrase; alpha beta", "';' is not ':' or '='"],
      ["pass: alpha beta gamma", "'pass' alone is not a passphrase cue"],
      ["passphrase:", "no value"],
      ["seed phrase: abc", "shorter than 5 characters"],
      ["seed phrase: (hidden)", "the value cannot start with a bracket"],
      ["Passphrase: ;;;;;;", "the value cannot start with ';'"],
      [`seed phrase =${" ".repeat(10)}`, "only spaces"],
      ["recovery phrase: !!!!!", "only punctuation, which is trimmed"],
      ["bypass phrase: hold shift at boot", "pass phrase inside a word"],
    ],
    adversarial: {
      "a cue, ':' then spaces": length =>
        `seed phrase:${" ".repeat(length - 12)}`,
      "cues with no ':'": length =>
        repeatTo("seed phrase recovery phrase ", length),
      "cues with short values": length => repeatTo("passphrase: abc;", length),
      "cues with punctuation values": length =>
        repeatTo("passphrase: !!!!!\n", length),
      "cues with 'is' and a word about the passphrase": length =>
        repeatTo("passphrase is too short\n", length),
    },
  },
  passwordBare: {
    type: "SECRET_IN_CONTEXT",
    source:
      "a value with a digit or a symbol right after a short password or PIN cue",
    finds: [
      "pw [[Chase2024!]] for my Chase account",
      "passcode [[8821]] for the iPhone",
      "pwd [[hunter2]]",
      "passwd [[s3cret!]]",
      "PW [[Kiwi_77]]",
      "wifi pw '[[Tr0ub4dor]]'",
      "my pin [[0000]] is easy",
      "the pw [[a1b2c3]], thanks",
      "pwd [[x9y8z7]].",
      "passcode [[#4521]]",
      "PIN [[908172]] for the card",
      "pwd [[S@fe-Word]]",
    ],
    ignores: [
      ["pw hunter", "no digit or symbol"],
      ["pin numbers", "no digit or symbol"],
      ["passcode required", "no digit or symbol"],
      ["pwd command prints the directory", "no digit or symbol"],
      ["pin the tail", "no digit or symbol"],
      ["pin 3 of the connector", "shorter than 3 characters"],
      ["pin 12", "shorter than 3 characters"],
      ["pin it to the top", "shorter than 3 characters"],
      ["spin 4821", "pin inside a word"],
      ["pinned 4821", "pin inside a word"],
      [
        "I ran pwd /home/anna/project and it says permission denied",
        "a path, as the pwd command prints",
      ],
      ["pwd ~/code/app", "a path, as the pwd command prints"],
      ["connect pin GPIO17 to ground", "a connector pin, not 4 to 8 digits"],
      ["the pin 5V-tolerant input", "a connector pin, not 4 to 8 digits"],
    ],
    adversarial: {
      "a cue then spaces": length => `pw${" ".repeat(length - 2)}`,
      "cues with letter-only values": length =>
        wholeUnits("pw hunter ", length),
      "cues one after another": length => repeatTo("pin pw pwd ", length),
      "cues with short values": length => repeatTo("pin 12 ", length),
    },
  },
  passwordAssigned: {
    type: "SECRET_IN_CONTEXT",
    source:
      "a value after a password or PIN cue and ':', '=' or 'is', in 8 languages",
    finds: [
      "password is [[Firefox123]] for Firefox Sync",
      "password: [[P@ssw0rd!]] for Gmail",
      "my wifi password is [[correcthorsebattery]]",
      "The Windows PIN is [[482915]]",
      "PIN: [[4821]]",
      "the password is [[hunter2]].",
      "password = '[[hunter22]]'",
      "the password for the wifi is [[Kiwi2024]]",
      "the password for Zoom meeting 8821 3345 998 is [[abc123]]",
      "Passwort: [[Sommer2024!]]",
      "mot de passe est [[Fraise99]]",
      "contraseña: [[Sol2024]]",
      "a senha é [[Praia#7]]",
      "hasło: [[Kot123]]",
      "wachtwoord is [[Fiets2024!]]",
    ],
    ignores: [
      ["I forgot my password", "no value"],
      ["password reset link", "no ':', '=' or 'is' after the cue"],
      ["password manager is Bitwarden", "no ':', '=' or 'is' after the cue"],
      ["passwordless login is great", "no ':', '=' or 'is' after the cue"],
      ["password is required", "a word about the password"],
      ["password is too short", "a word about the password"],
      ["the password is not working", "a word about the password"],
      ["my password is secret", "a word about the password"],
      ["Is the password wrong?", "no value after the cue"],
      ["your password must contain a number", "no value after the cue"],
      ["password: ab", "shorter than 3 characters"],
      ["spin is 4821", "pin inside a word"],
    ],
    adversarial: {
      "a cue then spaces": length => `password${" ".repeat(length - 8)}`,
      "a cue, for, then spaces": length =>
        `password for${" ".repeat(length - 12)}`,
      "cues with no value": length => repeatTo("password ", length),
      "cues with 'for' and no 'is'": length =>
        repeatTo("password for the account ", length),
      "cues with words about the password": length =>
        wholeUnits("password is required ", length),
      "cues with short values": length => repeatTo("pin: ab ", length),
    },
  },
  urlToken: {
    type: "URL_TOKEN",
    source:
      "the password in a URL, as the URL parser reads it, and query or fragment values whose name is a credential",
    finds: [
      "https://site.com/reset?token=[[a8f3k29dk3]]&x=1",
      "https://api.x.com/v1?access_token=[[ya29.a0AfH6SMBx]]",
      "https://app.com/cb#access_token=[[abc123def456]]&token_type=bearer",
      "https://x.com/?api_key=[[SECRET123456]]",
      "https://b.s3.amazonaws.com/f.pdf?X-Amz-Signature=[[ab12cd34ef56ab12]]",
      "https://u:[[p4ssw0rd]]@host.com/",
      "https://x.com/login?user=a&password=[[hunter22]]",
      "https://x.com/a?sessionid=[[9f8e7d6c5b4a]]",
      "https://x.com/a?key=[[a1b2c3d4e5f6g7h8]]",
      "https://x.com/a?sig=[[MEUCIQDx7u]]",
      "see (https://x.com/r?secret=[[Zk9vQm4xTw]]).",
      "https://x.com/a?access%5Ftoken=[[q9w8e7r6t5]]",
      "https://api.x.com/upload?secret_key=[[Ab12Cd34Ef56Gh78]]",
      "https://s3.x.com/b?access-key=[[q1w2e3r4t5y6]]&x=1",
      "https://x.com/hook?api_secret=[[z9x8c7v6b5]]",
      "https://x.com/k?privatekey=[[m1n2b3v4c5]]",
      // A user name with no password is not a token.
      "https://[[EMAIL: user@host.com]]/",
    ],
    ignores: [
      ["https://www.bbc.co.uk/news/123", "no credential"],
      ["https://example.com/search?q=cats&page=2", "no credential parameter"],
      [
        "https://site.com/p?utm_source=news&ref=home",
        "no credential parameter",
      ],
      ["https://x.com/a?key=sort", "key is ambiguous and sort is not random"],
      ["https://x.com/?key=abc", "key is ambiguous and abc is not random"],
      ["https://x.com/?token=", "an empty value"],
      ["https://x.com/?sig=abc", "shorter than 6 characters"],
      ["https://example.com/#section-2", "a fragment with no parameter"],
      ["http://localhost:3000/api/users", "a port, not a password"],
      ["ftp://files.example.org/readme.txt", "no credential"],
      ["https://youtu.be/dQw4w9WgXcQ?t=42", "t is ambiguous and 42 is short"],
      ["https://github.com/jsmith/repo", "no credential"],
      ["token=a8f3k29dk3", "not in a URL"],
      [
        "https://shop.com/?code=SUMMERSALE",
        "code is ambiguous and the value has no digit",
      ],
      [
        "https://host.com\\u:pw12@x",
        "the URL parser reads the backslash as the start of the path",
      ],
    ],
    adversarial: {
      "one URL with many parameters": length =>
        `https://x.com/?${repeatTo("a=b&", length - 15)}`,
      "credential names with short values": length =>
        `https://x.com/?${repeatTo("token=abc&", length - 15)}`,
      "malformed percent escapes in names": length =>
        `https://x.com/?${repeatTo("%zz=1&", length - 15)}`,
      "schemes with no slashes": length => repeatTo("https:", length),
      "scheme-like words glued together": length =>
        repeatTo("ab+cd.ef-gh:", length),
      "a URL ending in punctuation": length =>
        `https://x.com/${")".repeat(length - 14)}`,
    },
  },
  privateKey: {
    type: "API_KEY",
    source:
      "PEM private key blocks (RFC 7468), OpenSSH keys and PGP private key blocks (RFC 4880)",
    finds: [
      `[[${pem("RSA PRIVATE KEY")}]]`,
      `[[${pem("PRIVATE KEY")}]]`,
      `[[${pem("EC PRIVATE KEY")}]]`,
      `[[${pem("DSA PRIVATE KEY")}]]`,
      `[[${pem("ENCRYPTED PRIVATE KEY")}]]`,
      `[[${pem("OPENSSH PRIVATE KEY", "b3BlbnNzaC1rZXktdjEAAAAA")}]]`,
      `here is my key:\n[[${pem("RSA PRIVATE KEY")}]]\ncan you fix it?`,
      `[[${pem("PRIVATE KEY", "MIIEvQIBADANBgkqhkiG9w0B", "\r\n")}]]`,
      // Escaped newlines, as in JSON or an .env file.
      `{"key": "[[${pem("PRIVATE KEY", "MIIEvQIBADAN", "\\n")}]]"}`,
      `one [[${pem("EC PRIVATE KEY")}]] two [[${pem("PRIVATE KEY")}]]`,
      // A header pasted twice belongs to the same key.
      `[[-----BEGIN PRIVATE KEY-----\n${pem("PRIVATE KEY")}]]`,
      `[[${pem("PGP PRIVATE KEY BLOCK", "lQOYBF4sYnQBCAC5rP0a")}]]`,
      // With no footer, the key runs to the last line of key text.
      "[[-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0B]]",
      "my key:\n[[-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAx8f3\nQk9vQm4xTwZk9vQm4xTw]]\nwhy won't ssh accept it?",
      // Newlines lost on paste.
      "[[-----BEGIN RSA PRIVATE KEY----- MIIEowIBAAKCAQEAx8f3 Qk9vQm4xTwZk9vQm4x]] thanks",
    ],
    ignores: [
      [pem("PUBLIC KEY"), "a public key"],
      [pem("RSA PUBLIC KEY"), "a public key"],
      [pem("CERTIFICATE"), "a certificate"],
      [pem("PGP PUBLIC KEY BLOCK"), "a public key"],
      [
        "the first line is -----BEGIN OPENSSH PRIVATE KEY----- and then",
        "a header with no footer and no key text after it",
      ],
      [
        "-----BEGIN PRIVATE KEY-----\nMIIE\nabc",
        "a header with no footer and only short lines after it",
      ],
      ["MIIEvQIBADAN\n-----END PRIVATE KEY-----", "a footer with no header"],
      ["the file starts with BEGIN PRIVATE KEY", "no dashes around the header"],
      [pem("private key"), "lower case, PEM labels are upper case"],
      [
        "----BEGIN PRIVATE KEY----\nMIIE\n----END PRIVATE KEY----",
        "four dashes, PEM uses five",
      ],
      [
        "-----END PRIVATE KEY----- then -----BEGIN PRIVATE KEY-----",
        "the footer comes before the header",
      ],
    ],
    adversarial: {
      "headers with no footer": length =>
        repeatTo("-----BEGIN PRIVATE KEY-----\nMIIE\n", length),
      "footers with no header": length =>
        repeatTo("MIIE\n-----END PRIVATE KEY-----\n", length),
      dashes: length => repeatTo("-", length),
      "headers cut before the label ends": length =>
        repeatTo("-----BEGIN RSA PRIVATE ", length),
      "a header then spaces": length =>
        `-----BEGIN PRIVATE KEY-----${" ".repeat(length - 27)}`,
      "a header then lines one character short": length =>
        `-----BEGIN PRIVATE KEY-----${repeatTo("\nMIIEvQIBADANBgk", length - 27)}`,
    },
  },
  apiKey: {
    type: "API_KEY",
    source: "prefixes and lengths each vendor documents for its keys",
    finds: [
      `key [[${KEY.openai}]]`,
      `OPENAI_API_KEY=[[${KEY.openaiProject}]]`,
      `ANTHROPIC_API_KEY=[[${KEY.anthropic}]]`,
      `token [[${KEY.ghp}]] leaked`,
      `pat [[${KEY.ghpat}]]`,
      `aws [[${KEY.aws}]]`,
      `slack [[${KEY.slack}]]`,
      `google [[${KEY.google}]].`,
      `gitlab [[${KEY.gitlab}]]`,
      `stripe [[${KEY.stripe}]]`,
      `sendgrid [[${KEY.sendgrid}]]`,
      `npm [[${KEY.npm}]]`,
      `hf [[${KEY.hf}]]`,
      `short [[${joinParts("ghp_", "1qF05S2lxVRRVYrAzhgDdrWdwa")}]] token`,
      `"[[${KEY.openai}]]"`,
    ],
    ignores: [
      ["sk-short", "too short after the prefix"],
      ["ghp_tooshort", "too short after the prefix"],
      ["hf_short", "too short after the prefix"],
      ["xox-12", "a Slack prefix needs a letter after xox"],
      ["SG.abc.def", "both SendGrid parts are too short"],
      ["the AKIA prefix is for AWS", "a prefix alone"],
      ["github_pat_ is a prefix", "a prefix alone"],
      ["npm_install", "an npm token has 36 characters after the prefix"],
      [`${KEY.aws}X`, "17 characters after AKIA, an AWS key id has 16"],
      ["ask-me-anything", "sk- inside a word"],
      ["task-1234567890123456789012345", "sk- inside a word"],
      ["risk-assessment-framework-2024-final-version", "sk- inside a word"],
      ["my password is secret", "no vendor prefix"],
    ],
    adversarial: {
      "every prefix glued, each too short": length =>
        repeatTo("ghp_xoxb-AIzaSG.npm_hf_glpat-sk-ab ", length),
      "AWS key ids one character too long": length =>
        wholeUnits(`${KEY.aws}X `, length),
      "npm tokens one character too long": length =>
        wholeUnits(`${KEY.npm}X `, length),
      "SendGrid keys with a short second part": length =>
        repeatTo(`${KEY.sendgrid.slice(0, -2)} `, length),
    },
  },
  jwt: {
    type: "JWT",
    source: "three base64url parts whose header decodes to JSON (RFC 7519)",
    finds: [
      `[[${JWT_HS}]]`,
      `Authorization: Bearer [[${JWT_HS}]]`,
      `token=[[${JWT_HS}]] end`,
      `cookie: session=[[${JWT_RS}]];`,
      `https://app.com/cb#id_token=[[${JWT_HS}]]`,
      `{"jwt": "[[${JWT_RS}]]"}`,
      `my token is [[${JWT_HS}]], please decode`,
      `curl -H 'x-auth: [[${JWT_RS}]]' https://a.b`,
      `two: [[${JWT_HS}]] and [[${JWT_RS}]]`,
      // Neither the signature nor the payload is checked.
      `JWT [[${JWT_HS.slice(0, -5)}abcde]]`,
      "[[eyJhbGciOiJIUzI1NiJ9.Zm9vYmFy.abc]]",
    ],
    ignores: [
      ["eyJabcde.defghi.ghijkl", "the header decodes to garbage, not JSON"],
      ["eyJfoobar.bazqux.quux", "the header decodes to garbage, not JSON"],
      ["eyJhbGciOi.eyJzdWIiOiJ4In0.c2ln", 'the header is cut off: {"alg":'],
      [
        "eyJhbGciOiJIUzI1NiI.eyJzdWIiOiJ4In0.c2ln",
        'the header has no closing brace: {"alg":"HS256"',
      ],
      [
        "eyJhbGcifQ.eyJzdWIiOiJ4In0.c2ln",
        'the header is not JSON: {"alg"} has no value',
      ],
      ["eyJ", "a header prefix alone"],
      ["eyJzdWIiOiJ4In0", "one part, a token has three"],
      ["eyJhbGciOi.abc", "two parts, a token has three"],
      ["eyJhbGciOiJIUzI1NiJ9.e30", "two parts, a token has three"],
      ["eyJhbGciOiJIUzI1NiJ9..c2ln", "the payload is empty"],
      ["eyJ not base64!.x.y", "spaces are not base64url"],
      ["www.example.com/eyJhbGci", "no parts after the header"],
      [`abc${JWT_HS}`, "glued to a word, so part of a longer token"],
      ["a.b.c", "does not start with eyJ"],
      ["file.name.ext", "does not start with eyJ"],
      ["version 1.2.3", "does not start with eyJ"],
      ["token.token.token", "does not start with eyJ"],
    ],
    adversarial: {
      "eyJ repeated": length => repeatTo("eyJ", length),
      "a header with no dot": length => `eyJ${"a".repeat(length - 3)}`,
      "a header and payload with no second dot": length =>
        repeatTo(" eyJaaaaa.bbbbbbb", length),
      "tokens whose header is not JSON": length =>
        repeatTo("eyJaaaaa.", length),
      "one long token whose header is not JSON": length =>
        `eyJ${"a".repeat(length - 11)}.aaaaa.b`,
    },
  },
  mac: {
    type: "MAC",
    source:
      "six hex pairs with one separator, or Cisco's three dotted groups (IEEE 802)",
    finds: [
      "[[00:1A:2B:3C:4D:5E]]",
      "mac [[00-1a-2b-3c-4d-5e]]",
      "[[aa:bb:cc:dd:ee:ff]]",
      "cisco [[0012.3456.789a]]",
      "device [[AA:BB:CC:11:22:33]] online",
      "wifi: [[DE:AD:BE:EF:00:01]].", // the period stays out
      "([[f0:18:98:5a:6b:7c]])",
      "ether [[52-54-00-12-34-56]]",
      "both [[00:11:22:33:44:55]] and [[66:77:88:99:aa:bb]]",
      "bt [[3c:5a:b4:00:01:02]]",
    ],
    ignores: [
      ["12:34:56", "a time: three pairs"],
      ["10:30:45:12", "four pairs, an address has six"],
      ["ab:cd:ef", "three pairs, an address has six"],
      ["00:1A:2B:3C:4D", "five pairs, an address has six"],
      ["1234.5678", "two dotted groups, Cisco's format has three"],
      ["zz:zz:zz:zz:zz:zz", "z is not a hex digit"],
      ["00:1A:2B:3C:4D:5E:6F", "seven pairs, an address has six"],
      ["aa-bb-cc-dd-ee", "five pairs, an address has six"],
      ["time 12:00:00 sharp", "a time: three pairs"],
      ["00:1A:2B:3C:4D:5", "the last group has one digit"],
      ["00:1A-2B:3C-4D:5E", "colons and dashes mixed"],
    ],
    adversarial: {
      "colon-separated pairs with no end": length => repeatTo("ab:", length),
      "dash-separated pairs with no end": length => repeatTo("ab-", length),
      "dotted groups with no end": length => repeatTo("abcd.", length),
      "mixed separators": length => repeatTo("00:1A-", length),
    },
  },
  ipv6: {
    type: "IP",
    source: "what the URL parser accepts as an IPv6 host (RFC 4291)",
    finds: [
      "ipv6 [[2001:0db8:85a3:0000:0000:8a2e:0370:7334]]",
      "link-local [[fe80::1]] only",
      "loopback [[::1]] here",
      "[[2001:db8::ff00:42:8329]]",
      "server [[2001:db8::1]]",
      "ssh to [[2001:db8::2]] on port 22",
      "unique local [[fd00::abcd]]",
      "multicast [[ff02::1]]",
      "[[2001:DB8:0:0:8:800:200C:417A]]", // published (RFC 4291); upper case
      "gateway [[fe80::1ff:fe23:4567:890a]]%eth0", // the zone stays out
      "MAC [[MAC: 00:1A:2B:3C:4D:5E]]", // a MAC address, not IPv6
    ],
    ignores: [
      ["time 10:30:45", "a time: three groups and no ::"],
      ["ratio 3:1", "one colon"],
      ["score 12:45", "one colon"],
      ["12:30:00 pm", "a time: three groups and no ::"],
      ["a:b:c", "three groups and no ::"],
      ["deadbeef:cafe::1", "an 8-digit group, a group has at most 4"],
      [":::", "three colons in a row"],
      ["1::2::3", "two ::, an address has at most one"],
      [
        "2001:db8:85a3:0:0:8a2e:370:7334:1234",
        "nine groups, an address has at most eight",
      ],
      ["std::vector<int>", "the C++ scope operator, glued to a word"],
      ["g001:db8::1", "g is not a hex digit"],
      ["x :: Int", '"::" alone, a Haskell type'],
    ],
    adversarial: {
      "colons only": length => ":".repeat(length),
      "times in a row": length => repeatTo("10:30:45 ", length),
      "hex groups with no end": length => repeatTo("ab:", length),
      "double colons in a row": length => repeatTo("1::", length),
    },
  },
  ipv4: {
    type: "IP",
    source: "four dotted groups of 0 to 255, as in RFC 791",
    finds: [
      "ip [[192.168.1.10]]",
      "server [[10.0.0.1]] is down",
      "connect to [[8.8.8.8]]:53",
      "[[255.255.255.255]]",
      "ping [[127.0.0.1]]",
      "from [[203.0.113.42]], then",
      "([[172.16.254.1]])",
      "gateway [[192.168.0.1]].", // the period stays out
      "IP: [[0.0.0.0]]",
      "from [[100.64.0.1]] to [[100.64.0.2]]",
    ],
    ignores: [
      ["version 1.2.3.4", "a version number after 'version'"],
      ["ver. 10.0.0.1", "a version number after 'ver.'"],
      ["app 1.2.3.4", "a version number after 'app'"],
      ["python 3.11.2.1", "a version number after 'python'"],
      ["999.1.1.1", "999 is over 255"],
      ["256.1.1.1", "256 is over 255"],
      ["01.02.03.04", "leading zeros are not how addresses are written"],
      ["1.2.3", "three groups, an address has four"],
      ["see 1.2.3.4.5", "five groups, an address has four"],
      ["date 2024.01.15.10", "a 4-digit group"],
      ["v2.10.3.1", "glued to v, a version number"],
      ["host-10.0.0.1", "glued to a hostname before it"],
      ["1.2.3.4a", "glued to a letter after it"],
    ],
    adversarial: {
      "dotted digits with no end": length => repeatTo("1.", length),
      "groups over 255": length => repeatTo("999.999.999.999 ", length),
      "version cues before addresses": length =>
        repeatTo("version 1.2.3.4 ", length),
      "five-group numbers": length => repeatTo("1.2.3.4.5 ", length),
    },
  },
  email: {
    type: "EMAIL",
    source: "the common subset of RFC 5322 addresses, in any script",
    finds: [
      "email me at [[drrana@mozilla.com]]",
      "contact: [[first.last+tag@sub.example.co.uk]].", // the period stays out
      "Mail [[jsmith@mozilla.com]] or [[anna.k@gmail.com]]",
      "([[bob_smith@company.org]])",
      "écrire à [[émile@exemple.fr]]",
      "Kontakt: [[m.müller@uni-bonn.de]], danke",
      "<[[jane@doe.io]]>",
      "my email is [[sam1998@gmail.com]]",
      "send to [[a@b.co]]",
      "https://site.com/unsubscribe?email=[[anna.k@gmail.com]]",
      "[[USER@EXAMPLE.COM]] is my login",
      "write to [[jane.support@acme.com]]", // only an exact role name is left alone
    ],
    ignores: [
      ["price is 5@3 each", "a top-level domain made of digits"],
      ["@mention only", "nothing before the @"],
      ["email me", "no @"],
      ["name@localhost", "no domain with a dot"],
      ["v1.2@3.4", "a top-level domain made of digits"],
      ["a@b", "no domain with a dot"],
      ["meet @ 5pm", "spaces around the @"],
      ["tweet @jack hello", "a handle, nothing before the @"],
      ["foo@bar", "no domain with a dot"],
      ["100@200.5", "a top-level domain made of digits"],
      ["see section@2", "no domain with a dot"],
      ["user @ example dot com", "an address spelled out in words"],
      [
        "Should I email support@amazon.com",
        "a company's support mailbox, not a person's",
      ],
      ["write to privacy@spotify.com", "a company's privacy mailbox"],
      ["cc support@zalando.de.", "a company's support mailbox"],
      ["billing@netflix.com", "a company's billing mailbox"],
      [
        "escribe a atencioncliente@renfe.es",
        "a company's customer service mailbox, in Spanish",
      ],
    ],
    adversarial: {
      "a long dotted domain": length => `y@${"a.".repeat(length / 2)}1`,
      "many at signs": length => "a@".repeat(length / 2),
      "a long local part with no domain": length =>
        `${"a".repeat(length - 1)}@`,
      "domain labels with hyphens at both ends": length =>
        repeatTo("x@-a-.", length),
      "role mailboxes in a row": length =>
        repeatTo("support@example.com ", length),
    },
  },
  iban: {
    type: "IBAN",
    source:
      "ISO 13616 mod-97 check; length per country from the SWIFT IBAN registry",
    finds: [
      "iban [[DE89 3704 0044 0532 0130 00]] thanks", // published
      "[[GB82 WEST 1234 5698 7654 32]]", // published
      "[[NL91ABNA0417164300]]", // published
      "[[FR14 2004 1010 0505 0001 3M02 606]]", // published
      "[[ES91 2100 0418 4502 0005 1332]] is mine", // published
      "[[IT60 X054 2811 1010 0000 0123 456]]", // published
      "[[CH93 0076 2011 6238 5295 7]]", // published
      "[[BE68 5390 0754 7034]].", // published; the period stays out
      "[[AT61 1904 3002 3457 3201]]", // published
      "[[PL61 1090 1014 0000 0712 1981 2874]]", // published
      "IBAN: [[IE29AIBK93115212345678]] please pay", // published
      "[[NO9386011117947]] and [[DK5000400440116243]]", // published
      "ref [[DE89 3704 0044 0532 0130 00]] 2024", // the next group is not part of it
    ],
    ignores: [
      ["DE89 3704 0044 0532 0130 01", "one digit off, so mod-97 fails"],
      ["GB00 WEST 1234 5698 7654 32", "check digits 00 never pass mod-97"],
      ["XX12 3456", "too short to be any IBAN"],
      ["ABC123", "does not start with two letters and two digits"],
      ["AB12 CD34", "8 characters, under the 15 every IBAN needs"],
      ["order DE12345", "7 characters, a German IBAN has 22"],
      ["NL91 ABNA 0417 1643", "16 characters, a Dutch IBAN has 18"],
      ["serial no FR14 2004", "8 characters, a French IBAN has 27"],
      ["1234 5678 9012 3456", "digits only, no country code"],
      ["IBAN", "the word alone"],
      [
        "DE89370400440532013000abc",
        "glued to more letters, so part of a longer code",
      ],
    ],
    adversarial: {
      "IBAN starts, capitals, then a lower-case letter": length =>
        repeatTo(`DE89${"ABCD".repeat(9)}a `, length),
      "one IBAN start and a long run of capitals": length =>
        `DE89${"A".repeat(length - 5)}a`,
      "single characters between separators": length =>
        repeatTo(`DE89${" A".repeat(18)}a `, length),
      "IBAN starts in a row": length => repeatTo("DE89", length),
      "digits after an IBAN start": length => `DE89${"1".repeat(length - 4)}`,
    },
  },
  card: {
    type: "CARD",
    source:
      "Luhn and issuer prefixes from CreditCard.sys.mjs; Visa lengths 13, 16, 19",
    finds: [
      "my card [[4111 1111 1111 1111]] expired", // published test number
      "visa [[4012-8888-8888-1881]]", // published
      "mc [[5555555555554444]]", // published
      "mc2 [[5105 1051 0510 5100]]", // published
      "amex [[3782 822463 10005]]", // published; grouped 4-6-5
      "discover [[6011111111111117]]", // published
      "jcb [[3530111333300000]]", // published
      "diners [[30569309025904]]", // published
      "unionpay [[6200000000000005]]", // published
      "my card [[4532015112830366]]",
      "pay with [[4111111111111111]].", // the period stays out
      "credit debit card [[4920 0727 1234 5678]] and", // Luhn fails, card cue
      "Kreditkarte: [[5312-3456-7890-1234]]", // Luhn fails, card cue
      "maestro [[6759649826438453]]", // published; Maestro is found by its cue
    ],
    ignores: [
      ["4111 1111 1111 1112", "one digit off, so Luhn fails"],
      ["1090203012303930", "Luhn fails, and no network starts with 1"],
      ["timestamp 1696118400123", "a 13-digit timestamp that fails Luhn"],
      ["1234 5678 9012 3456", "a counting sequence that fails Luhn"],
      ["ref 4155550134", "10 digits, cards have at least 13"],
      ["0000 0000 0000 0000", "passes Luhn, but no network starts with 0"],
      ["12 digits 123456789012", "12 digits, cards have at least 13"],
      ["IMEI 490154203237518", "15 digits, Visa issues 13, 16 or 19"],
      ["ISBN 9780306406157", "an ISBN, which uses a different checksum"],
      ["order 4111-1111", "8 digits"],
      ["id 411111111111", "12 digits"],
      ["order 635-5506281-3168090", "grouped 3-7-7, not how cards are written"],
      [
        "reference 4920 0727 1234 5678 ok",
        "fails Luhn and has no card word before it",
      ],
      [
        "serial 4111 1111 1111 111 1",
        "grouped 4-4-4-3-1, not how cards are written",
      ],
      [
        "pay 6759649826438453",
        "a Maestro number without a card word: CreditCard does not know Maestro",
      ],
    ],
    adversarial: {
      "one long run of digits": length => "1".repeat(length),
      "a separator between every digit": length => repeatTo("1 ", length),
      "19-digit blocks glued to letters": length =>
        repeatTo("1234567890123456789x", length),
      "card words before numbers no network starts with": length =>
        repeatTo("card 7111111111111112 ", length),
      "a card word, then a long run without digits": length =>
        `card${"x".repeat(length - 4)}`,
      "dashes and spaces only": length => repeatTo("- ", length),
      "digits between dashes": length => repeatTo("1-", length),
    },
  },
  cvv: {
    type: "CVV",
    source:
      "3 or 4 digits after a security-code cue, as card networks name it in 8 languages",
    finds: [
      "my CVV is [[208]]",
      "CVV: [[123]]",
      "the cvv2 [[745]] is on the back",
      "CVC [[612]]",
      "security code on the back is [[987]]",
      "card security code: [[4321]]", // 4 digits: American Express
      "card verification value [[551]] please",
      "has a CVV of [[260]], then",
      "keep your CVV, which is [[899]], secret",
      "Der CVV-Code meiner Karte ist [[842]].",
      "Sicherheitscode: [[119]]",
      "le code de sécurité est [[523]].",
      "kod CVV to [[459]]",
      "Mi código de seguridad es [[731]]",
      "Il codice di sicurezza è [[265]]",
      "Meu código de segurança é [[318]]",
      "Mijn veiligheidscode is [[902]]",
      "card [[CARD: 4111 1111 1111 1111]], CVV [[123]], exp 12/27",
      "The app is asking for my CVV. It's [[289]]. Is that safe?",
      "they want my CVV! That's [[556]]",
      "Meine CVV. Es ist [[127]]",
      // A PIN, not a security code.
      "pin [[SECRET_IN_CONTEXT: 4821]]",
    ],
    ignores: [
      ["CVV. It's on the back of the card", "a cue but no number"],
      ["CVV. It's 12345 miles away", "5 digits, a security code has 3 or 4"],
      ["What is a CVV?", "a question about CVVs, no number"],
      ["CVV stands for card verification value", "a definition, no number"],
      ["my CVV is 12", "2 digits, a security code has 3 or 4"],
      ["CVV is 12345", "5 digits, a security code has 3 or 4"],
      ["CVV is 3 digits on the back", "1 digit, a security code has 3 or 4"],
      ["the code is 1234", "'code' alone is not a security-code cue"],
      ["verification code 4821", "a one-time verification code, not a card's"],
      ["area code 415", "a phone area code"],
      ["country code 351", "a phone country code"],
      ["order 123", "a number with no cue"],
      ["123 Main Street, my CVV is hidden", "the cue comes after the number"],
      ["the cvv number is on the back of the card", "a cue but no number"],
      [
        "ask for the CVV. 208 Elm Street",
        "a new sentence that starts with a house number",
      ],
    ],
    adversarial: {
      "many 3-digit numbers, no cue": length => repeatTo("123 ", length),
      "a cue, a 33-character gap, then a number": length =>
        repeatTo(`cvv ${"x".repeat(33)} 123 `, length),
      "a cue, then a sentence starting with a number": length =>
        repeatTo("CVV. 208 ", length),
      "a cue, many spaces, then a number": length =>
        repeatTo(`cvv${" ".repeat(40)}123 `, length),
      "cue words packed before 5-digit numbers": length =>
        repeatTo("cvv cvc csc security code sicherheitscode 12345 ", length),
      "sentence ends and intro words, then a long number": length =>
        repeatTo("my cvv. it's it's it's 12345 ", length),
      "numbers glued to cue fragments": length => repeatTo("cvv.123.", length),
    },
  },
  bitcoinLegacy: {
    type: "CRYPTO_WALLET",
    source:
      "Base58Check, as in Bitcoin's legacy (1...) and P2SH (3...) formats",
    finds: [
      "btc [[1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2]]",
      "genesis [[1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa]]", // published
      "p2sh [[3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy]]", // published
      "([[1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2]])",
      "send it to [[1b3DbGNVjzAYFZz5YTrwMmt1Qpa7xs9mV]] please", // 33 characters
      "my wallet: [[15wXkBRt2EGPGuWwZr1GHw83tJ3GHuvGa7]].", // the period stays out
      "[[1CPbWziZFBvpRhuWUMirA6Zv9zWJeZ2NJS]]",
      "Adresse: [[1EScSbtpB3g5R2TwEpUX7eMhRHUZ8JTrko]]",
      "pay to [[3CHdM5inGD9FPFbmV1Ld4fSotxw2zbcQNX]], thanks",
      "[[38m81wHYmVTBpZrDrtKYjBfnnrAvnPBd7L]] or [[3EvPgZERGiiQwreHrthffrBJKLFTVu2Wge]]",
    ],
    ignores: [
      [
        "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN3",
        "the last character changed, so Base58Check fails",
      ],
      [
        "tx 3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLz",
        "the last character of a P2SH address changed",
      ],
      [
        "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNNV2",
        "two characters swapped, so Base58Check fails",
      ],
      ["3Jabc", "5 characters, an address has at least 26"],
      ["1 apple", "a number and a word"],
      ["1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN0", "0 is not a Base58 character"],
      ["x1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2", "glued to a letter before it"],
      [
        "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN20",
        "glued to a 0 after it, so part of a longer code",
      ],
      [
        "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2x",
        "one letter added, so Base58Check fails",
      ],
      [
        "2BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2",
        "starts with 2, not a legacy or P2SH address",
      ],
      [
        "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2abcd",
        "38 characters, longer than any address",
      ],
      [
        "licence key 1A2B3C4D5E6F7G8H9JAKBMCNDPEQFRGS",
        "a key shaped like an address that fails Base58Check",
      ],
      [
        "tx 4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b",
        "a 64-character hex transaction hash",
      ],
    ],
    adversarial: {
      "address-shaped words that fail Base58Check": length =>
        repeatTo("1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN3 ", length),
      "addresses glued to a 0": length =>
        repeatTo("1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN20 ", length),
      "one long run of Base58 characters": length =>
        `1${"A".repeat(length - 1)}`,
      "one long run of 1s": length => "1".repeat(length),
      "shortest address-shaped words": length =>
        repeatTo(`3${"J".repeat(25)} `, length),
    },
  },
  bitcoinSegwit: {
    type: "CRYPTO_WALLET",
    source:
      "Bech32 (BIP 173) and Bech32m (BIP 350), as in Bitcoin's bc1 format",
    finds: [
      "bech32 [[bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq]]", // published
      "wallet: [[bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq]], thanks",
      "[[BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4]]", // published; upper case
      "script [[bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3]]", // published; 62 characters
      "taproot [[bc1pw508d6qejxtdg4y5r3zarvary0c5xw7kw508d6qejxtdg4y5r3zarvary0c5xw7kt5nd6y]]", // published; Bech32m
      "send to [[bc1q7ytkjfayyz3g7mednamugyxzn9n266g9tzntgr]] please",
      "([[bc1qpxk6fx7wzzjch3m2gvvsxns4arsxtpk38qagug]])",
      "Adresse: [[bc1qywe23j2qsf4ez2whe5t0weufdzu06fqauz46r0cmuwyrzumh5nlqtfmlpw]].", // the period stays out
      "pay [[bc1p72tgg5xhrwhzlqrvm8sca0dpms2d0slgrmk28r982qq53kw38z5q4jn4s7]] now", // Bech32m
      "[[bc1pkg5r3x9njdhdg069ucw3ll43wjfhvcfw5hwzepnzpg7kftc33c0qh2cak4]] or [[1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2]]",
    ],
    ignores: [
      [
        "address bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdr",
        "the last character changed, so Bech32 fails",
      ],
      [
        "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mqd",
        "the last two characters swapped",
      ],
      ["bc1qinvalid", "8 characters after bc1, an address has at least 11"],
      [
        "bc1qAr0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
        "upper and lower case mixed, which Bech32 never allows",
      ],
      [
        "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdo",
        "o is not a Bech32 character",
      ],
      [
        "xbc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
        "glued to a letter before it",
      ],
      [
        "lnbc1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdpl2pkx2ctnv5sxxmmwwd5kgetjypeh2ursdae8g6twvus8g6rfwvs8qun0dfjkxaq8rkx3yf5tcsyz3d73gafnh3cax9rn449d9p5uxz9ezhhypd0elx87sjle52x86fux2ypatgddc6k63n7erqz25le42c4u4ecky03ylcqca784w",
        "a Lightning invoice (BOLT 11), which starts with lnbc",
      ],
      [
        "testnet tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx",
        "a testnet address (tb1), not real money",
      ],
      ["bc1 is the prefix", "the prefix alone"],
      [
        "BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T5",
        "an upper-case address with its last character changed",
      ],
    ],
    adversarial: {
      "address-shaped words that fail Bech32": length =>
        repeatTo("bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdr ", length),
      "mixed-case address-shaped words": length =>
        repeatTo("bc1qAr0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq ", length),
      "one long run after bc1": length => `bc1${"q".repeat(length - 3)}`,
      "bc1 prefixes in a row": length => repeatTo("bc1", length),
      "short words after bc1": length => repeatTo("bc1qqqqqqqqqqqq ", length),
    },
  },
  ethereum: {
    type: "CRYPTO_WALLET",
    source: "0x and 40 hex digits; the EIP-55 checksum is not checked",
    finds: [
      "eth [[0x71C7656EC7ab88b098defB751B7401B5f6d8976F]]",
      "send to [[0xde0B295669a9FD93d5F28D9Ec85E40f4cb697BAe]].", // published; the period stays out
      "lowercase [[0x52908400098527886e0f7030069857d2e4169ee7]]", // published (EIP-55)
      "[[0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed]]", // published (EIP-55)
      "wallet: [[0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359]], thanks", // published (EIP-55)
      "([[0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB]])", // published (EIP-55)
      "pay [[0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb]] now", // published (EIP-55)
      "[[0x8617E340B3D01FA5F11F306F4090FD50E238070D]]", // published (EIP-55); upper case
      "Adresse: [[0x27b1fdb04752bbc536007a920d24acb045561c26]]", // published (EIP-55)
      "[[0x71C7656EC7ab88b098defB751B7401B5f6d8976F]] or [[1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa]]",
    ],
    ignores: [
      ["0x123", "3 hex digits, an address has 40"],
      ["0x" + "G".repeat(40), "G is not a hex digit"],
      ["hash 0x" + "ab".repeat(32), "64 hex digits: a transaction hash"],
      ["0x" + "1".repeat(39), "39 hex digits, an address has 40"],
      ["0x" + "1".repeat(41), "41 hex digits, an address has 40"],
      [
        "a0x71C7656EC7ab88b098defB751B7401B5f6d8976F",
        "glued to a letter before it",
      ],
      [
        "0x71C7656EC7ab88b098defB751B7401B5f6d8976Fg",
        "glued to a letter after it",
      ],
      [
        "0X71C7656EC7ab88b098defB751B7401B5f6d8976F",
        "0X with a capital X is not how addresses are written",
      ],
      [
        "commit 71c7656ec7ab88b098defb751b7401b5f6d8976f",
        "40 hex digits without 0x: a Git commit hash",
      ],
      ["color 0xFF00FF", "a 6-digit hex colour"],
    ],
    adversarial: {
      "one long run of hex digits": length => `0x${"a".repeat(length - 2)}`,
      "0x prefixes in a row": length => repeatTo("0x", length),
      "39 hex digits after each 0x": length =>
        repeatTo(`0x${"1".repeat(39)} `, length),
      "41 hex digits after each 0x": length =>
        repeatTo(`0x${"1".repeat(41)} `, length),
    },
  },
  routing: {
    type: "ROUTING_NUMBER",
    source:
      "ABA 3-7-1 checksum and Federal Reserve prefixes, after or before a routing cue",
    finds: [
      "routing number [[021000021]]", // published (Chase NY)
      "Routing: [[011000015]]", // published (Federal Reserve Boston)
      "my routing no. is [[121000358]]",
      "ABA [[026009593]]",
      "ABA number: [[111000025]]",
      "RTN [[322271627]]",
      "routing transit number [[063100277]].", // the period stays out
      "use [[071000013]] (routing) for the transfer", // the cue comes after
      "[[044000037]] is the ABA", // the cue comes after
      "numéro de routage : [[091000019]]",
      "the bank's routing # is [[256074974]]",
    ],
    ignores: [
      [
        "routing number 021000022",
        "the last digit changed, so the checksum fails",
      ],
      ["order 021000021", "a valid routing number, but no cue"],
      [
        "routing 921000008",
        "passes the checksum, but no Federal Reserve district starts with 92",
      ],
      ["ABA 500000005", "no routing number starts with 50"],
      ["routing 0210000210", "10 digits, a routing number has 9"],
      ["RTN 123456789", "a counting sequence that fails the checksum"],
      ["routing 02100002", "8 digits, a routing number has 9"],
      [
        "ABA 2024 conference in 021000021 rooms",
        "another number comes between the cue and this one",
      ],
      [
        "routing table has 3 entries; 021000021",
        "another number comes between the cue and this one",
      ],
      [
        "the routing slip, then 2 more: 021000021",
        "another number comes between the cue and this one",
      ],
      ["account 021000021", "an account cue, not a routing cue"],
    ],
    adversarial: {
      "valid routing numbers with no cue": length =>
        repeatTo("021000021 ", length),
      "routing cues before numbers that fail the checksum": length =>
        repeatTo("routing 021000022 ", length),
      "a routing cue, then a gap longer than 24 characters": length =>
        repeatTo(`routing ${"x".repeat(25)} 021000021. `, length),
      "a cue just too far after the number": length =>
        repeatTo(`021000021 ${"x".repeat(9)} aba. `, length),
    },
  },
};
