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

/** @type {Record<string, RuleCases>} */
export const RULE_CASES = {
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
      ["pin 4821", "a PIN, not a security code"],
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
};
