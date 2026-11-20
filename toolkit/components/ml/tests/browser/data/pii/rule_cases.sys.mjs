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
 * @property {string} [region] - The region every case is detected in, for a
 *   rule that only runs in one.
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
  ninoUK: {
    type: "NATIONAL_ID",
    source:
      "a UK National Insurance number, two allocatable prefix letters, 6 digits and a suffix A to D (HMRC National Insurance Manual NIM39110)",
    finds: [
      "NI number [[AB123456C]]",
      "ni: [[ab 12 34 56 c]]",
      "[[YZ 12 34 56 A]]",
      "my NINO is [[JG-10-37-26-D]].",
      "([[CE123456B]])",
      "[[AA 123456 A]]",
      "national insurance [[ZY987654A]]",
      "[[WZ 11 22 33 D]] and [[HP 99 88 77 C]]",
      "[[TP123456A]]",
      "[[Sk 00 00 00 b]]",
    ],
    ignores: [
      ["AB 12 34 56 F", "a suffix after D"],
      ["DN123456C", "first letter D"],
      ["QQ 12 34 56 C", "first letter Q, the prefix of HMRC's examples"],
      ["AO123456C", "second letter O"],
      ["AV123456C", "second letter V"],
      ["BG123456C", "prefix BG not allocated"],
      ["GB123456C", "prefix GB not allocated"],
      ["NK123456C", "prefix NK not allocated"],
      ["ZZ123456C", "prefix ZZ not allocated"],
      ["AB12345C", "5 digits"],
      ["AB1234567C", "7 digits"],
      ["XAB123456C", "inside a word"],
      ["AB123456CD", "followed by a letter"],
      ["AB  123456C", "two spaces"],
    ],
    adversarial: {
      "unallocated prefixes": length => wholeUnits("BG123456C ", length),
      "letters and digits": length => repeatTo("AB12", length),
      "separators and digits": length => repeatTo("AB 12 -", length),
    },
  },
  itinUS: {
    type: "NATIONAL_ID",
    source:
      "a US Individual Taxpayer Identification Number, 9xx-xx-xxxx with the same dash or space twice and a group the IRS issues (50-65, 70-88, 90-92, 94-99)",
    finds: [
      "ITIN [[912-70-1234]]",
      "my itin is [[900-50-0001]]",
      "[[999-99-9999]]",
      "ITIN: [[945 65 4321]]",
      "([[987-88-1234]])",
      "[[912-90-5678]].",
      "[[912-92-5678]] and [[912-94-5678]]",
      "taxpayer id [[955-77-1234]]",
      "[[903-60-0000]]",
      "itin=[[911-81-2222]]",
      "area 8 is an SSN: [[SSN: 812-70-1234]]",
    ],
    ignores: [
      ["912-49-1234", "group 49"],
      ["912-66-1234", "group 66"],
      ["912-69-1234", "group 69"],
      ["912-89-1234", "group 89"],
      ["912-93-1234", "group 93"],
      ["912-00-1234", "group 00"],
      ["666-70-1234", "area 666, neither an ITIN nor an SSN"],
      ["000-70-1234", "area 000, neither an ITIN nor an SSN"],
      ["912-70 1234", "two different separators"],
      ["912701234", "no separators"],
      ["x912-70-1234", "inside a word"],
      ["912-70-12345", "a longer last group"],
    ],
    adversarial: {
      "numbers with unissued groups": length =>
        wholeUnits("912-66-1234 ", length),
      "digits and dashes": length => repeatTo("912-70-", length),
      "a long run of nines": length => repeatTo("9", length),
    },
  },
  ssnCued: {
    type: "SSN",
    source:
      "a US Social Security number of 9 digits without separators, in an issuable range, within 48 characters after or 16 before an 'SSN' or 'social security' cue",
    finds: [
      "SSN [[123456789]]",
      "my ssn is [[219099999]]",
      "Social Security number: [[457555462]]",
      "social security no. [[078051121]].",
      "SSN#[[301228765]]",
      "[[612345678]] is my SSN",
      "ssn=[[555123456]]",
      "my social   security number is [[665123456]]",
      "SSN ([[899999999]])",
      "SSN: [[123-45-6789]] or [[123456789]]",
    ],
    ignores: [
      ["order 123456789", "no cue"],
      ["SSN 000123456", "area 000"],
      ["SSN 666123456", "area 666"],
      ["SSN 912345678", "area 900-999"],
      ["SSN 123004567", "group 00"],
      ["SSN 123450000", "serial 0000"],
      ["SSN 12345678", "8 digits"],
      ["SSN 1234567890", "10 digits"],
      ["SSN 123456789.5", "a decimal"],
      ["SSNs 123456789", "a longer word than the cue"],
      ["classnames 123456789", "the cue inside a word"],
      ["social securityholder 123456789", "a longer word than the cue"],
      [
        `SSN ${"x".repeat(60)} 123456789`,
        "the cue more than 48 characters before",
      ],
      ["123456789 and then the SSN", "the cue more than 16 characters after"],
    ],
    adversarial: {
      "a long run of digits after a cue": length =>
        `SSN ${"1".repeat(length - 4)}`,
      "nine digits without a cue": length => wholeUnits("123456789 ", length),
      "cues without digits": length => repeatTo("SSN ", length),
      "unissued numbers after cues": length =>
        wholeUnits("SSN 000123456 ", length),
    },
  },
  ssnSeparated: {
    type: "SSN",
    source:
      "a US Social Security number, 3-2-4 digits with the same dash or space twice, in an issuable range",
    finds: [
      "ssn [[123-45-6789]]",
      "my social security number is [[219-09-9999]]",
      "SSN: [[457 55 5462]]",
      "([[078-05-1121]])",
      "social security [[321-54-9876]].",
      "it is [[612-34-5678]] ok",
      "both [[123-45-6789]] and 987-12-4321?",
      "SSN#: [[301-22-8765]]",
      "[[665-12-3456]]",
      "[[899-99-9999]]",
      "[[001-01-0001]]",
    ],
    ignores: [
      ["000-12-3456", "area 000"],
      ["666-12-3456", "area 666"],
      ["900-12-3456", "area 900-999"],
      ["123-00-4567", "group 00"],
      ["123-45-0000", "serial 0000"],
      ["123-45 6789", "two different separators"],
      ["123 45-6789", "two different separators"],
      ["123--45-6789", "a double dash"],
      ["123456789", "no separators"],
      ["date 2024-01-15", "a date"],
      ["ISBN 0-306-40615-2", "an ISBN"],
      ["1123-45-6789", "a longer first group"],
      ["123-45-67890", "a longer last group"],
      ["x123-45-6789", "inside a word"],
      ["123-45-6789.5", "a decimal"],
      ["1.123-45-6789", "after a decimal point"],
      ["123-45-6789-1", "followed by a dash"],
    ],
    adversarial: {
      "dashes in a row": length => repeatTo("-", length),
      "digits and dashes": length => repeatTo("123-45-", length),
      "spaces and digits": length => repeatTo("123 45 ", length),
      "unissued numbers": length => wholeUnits("000-12-3456 ", length),
      "a long run of digits": length => repeatTo("1", length),
    },
  },
  postcodeIT: {
    type: "POSTCODE",
    source:
      "a Poste Italiane postcode, 5 digits before a capitalized place name, in region IT",
    region: "IT",
    finds: [
      "Via Roma 1, [[20121]] Milano",
      "[[00184]] Roma",
      "[[80100]] Napoli",
      "[[10121]] Torino",
      "[[50122]] Firenze",
      "[[40121]] Bologna",
      "[[16121]] Genova",
      "([[30121]] Venezia)",
      "[[90133]] Palermo e [[95121]] Catania",
      "[[70121]] Bari.",
      "[[37121]] Verona",
    ],
    ignores: [
      ["75008 roma", "a lower-case place"],
      ["75008 Ro", "a word of 2 letters"],
      ["75008 R3ma", "a digit in the word"],
      ["7500 Roma", "4 digits"],
      ["750081 Roma", "6 digits"],
      ["75008  Roma", "two spaces"],
      ["75008, Roma", "a comma"],
      ["75008-Roma", "a dash"],
      ["a75008 Roma", "inside a word"],
      ["1.75008 Roma", "after a dot"],
      ["Roma 75008", "the place before the number"],
    ],
    adversarial: {
      "numbers and lower-case words": length =>
        wholeUnits("75008 roma ", length),
      "numbers and short words": length => wholeUnits("75008 Ro ", length),
      "a long run of digits before a word": length =>
        `${"1".repeat(length - 5)} Roma`,
      "capitals in a row": length => repeatTo("R", length),
      "words with digits": length => wholeUnits("75008 R3ma ", length),
    },
  },
  postcodeES: {
    type: "POSTCODE",
    source:
      "a Correos postcode, 5 digits before a capitalized place name, in region ES",
    region: "ES",
    finds: [
      "Calle Mayor 1, [[28013]] Madrid",
      "[[08001]] Barcelona",
      "[[41001]] Sevilla",
      "[[46001]] Valencia",
      "[[48001]] Bilbao",
      "[[29001]] Málaga",
      "([[50001]] Zaragoza)",
      "[[18001]] Granada",
      "[[03001]] Alicante y [[30001]] Murcia",
      "[[07001]] Palma.",
      "[[35001]] Las Palmas",
    ],
    ignores: [
      ["75008 madrid", "a lower-case place"],
      ["75008 Ma", "a word of 2 letters"],
      ["75008 M3drid", "a digit in the word"],
      ["7500 Madrid", "4 digits"],
      ["750081 Madrid", "6 digits"],
      ["75008  Madrid", "two spaces"],
      ["75008, Madrid", "a comma"],
      ["75008-Madrid", "a dash"],
      ["a75008 Madrid", "inside a word"],
      ["1.75008 Madrid", "after a dot"],
      ["Madrid 75008", "the place before the number"],
    ],
    adversarial: {
      "numbers and lower-case words": length =>
        wholeUnits("75008 madrid ", length),
      "numbers and short words": length => wholeUnits("75008 Ma ", length),
      "a long run of digits before a word": length =>
        `${"1".repeat(length - 7)} Madrid`,
      "capitals in a row": length => repeatTo("M", length),
      "words with digits": length => wholeUnits("75008 M3drid ", length),
    },
  },
  postcodeFR: {
    type: "POSTCODE",
    source:
      "a La Poste postcode, 5 digits before a capitalized place name, in region FR",
    region: "FR",
    finds: [
      "12 rue des Lilas, [[69003]] Lyon",
      "[[75008]] Paris",
      "[[13001]] Marseille",
      "[[31000]] Toulouse",
      "[[06000]] Nice",
      "[[33000]] Bordeaux",
      "[[59000]] Lille",
      "([[67000]] Strasbourg)",
      "[[44000]] Nantes et [[35000]] Rennes",
      "[[34000]] Montpellier.",
      "[[97400]] Saint-Denis",
    ],
    ignores: [
      ["75008 lyon", "a lower-case place"],
      ["75008 Ly", "a word of 2 letters"],
      ["75008 L3on", "a digit in the word"],
      ["7500 Lyon", "4 digits"],
      ["750081 Lyon", "6 digits"],
      ["75008  Lyon", "two spaces"],
      ["75008, Lyon", "a comma"],
      ["75008-Lyon", "a dash"],
      ["a75008 Lyon", "inside a word"],
      ["1.75008 Lyon", "after a dot"],
      ["Lyon 75008", "the place before the number"],
    ],
    adversarial: {
      "numbers and lower-case words": length =>
        wholeUnits("75008 lyon ", length),
      "numbers and short words": length => wholeUnits("75008 Ly ", length),
      "a long run of digits before a word": length =>
        `${"1".repeat(length - 5)} Lyon`,
      "capitals in a row": length => repeatTo("L", length),
      "words with digits": length => wholeUnits("75008 L3on ", length),
    },
  },
  postcodeDE: {
    type: "POSTCODE",
    source:
      'a Deutsche Post postcode, 5 digits before a capitalized place name, starting a line or after a comma or "(", in region DE',
    region: "DE",
    finds: [
      "Lindenstraße 12, [[10115]] Berlin",
      "[[80331]] München",
      "[[20095]] Hamburg",
      "[[50667]] Köln",
      "[[60311]] Frankfurt am Main",
      "[[01067]] Dresden",
      "Hauptstr. 5, [[70173]] Stuttgart",
      "([[04109]] Leipzig)",
      "[[90402]] Nürnberg,[[28195]] Bremen",
      "Muster GmbH\n[[10117]] Berlin",
      "[[99084]] Erfurt.",
      "[[24103]] Kiel",
    ],
    ignores: [
      ["10115 berlin", "a lower-case place"],
      ["10115 Bo", "a word of 2 letters"],
      ["10115 B3rlin", "a digit in the word"],
      ["1011 Berlin", "4 digits"],
      ["101155 Berlin", "6 digits"],
      ["10115  Berlin", "two spaces"],
      ["10115, Berlin", "a comma"],
      ["10115-Berlin", "a dash"],
      ["a10115 Berlin", "inside a word"],
      ["1.10115 Berlin", "after a dot"],
      ["Berlin 10115", "the place before the number"],
      ["Es kamen 50000 Leute", "mid-sentence, where nouns are capitalized"],
      ["Nürnberg und 28195 Bremen", "mid-sentence"],
      ["  10115 Berlin", "an indented line (gap)"],
    ],
    adversarial: {
      "numbers and lower-case words": length =>
        wholeUnits("10115 berlin ", length),
      "numbers and short words": length => wholeUnits("10115 Bo ", length),
      "a long run of digits before a word": length =>
        `${"1".repeat(length - 7)} Berlin`,
      "capitals in a row": length => repeatTo("B", length),
      "words with digits": length => wholeUnits("10115 B3rlin ", length),
    },
  },
  postcodePT: {
    type: "POSTCODE",
    source: "a CTT postcode, 4 digits, a dash and 3 digits, in region PT",
    region: "PT",
    finds: [
      "[[1000-001]] Lisboa",
      "[[4000-322]] Porto",
      "Rua Augusta 10, [[1100-053]] Lisboa",
      "[[3000-214]] Coimbra",
      "[[8000-001]] Faro",
      "([[4700-035]])",
      "[[2750-642]].",
      "[[1000-001]] e [[1050-099]]",
      "código [[9000-018]] Funchal",
      "[[6000-084]] Castelo Branco",
    ],
    ignores: [
      ["1000001", "no dash"],
      ["1000 001", "a space instead of a dash"],
      ["100-001", "3 digits before the dash"],
      ["10000-001", "5 digits before the dash"],
      ["1000-01", "2 digits after the dash"],
      ["1000-0011", "4 digits after the dash"],
      ["a1000-001", "inside a word"],
      ["1.1000-001", "after a dot"],
      ["1000-001x", "followed by a letter"],
      ["1000-001-2", "followed by a dash"],
      ["00-950", "a Polish layout"],
      ["94105-1234", "a ZIP+4"],
    ],
    adversarial: {
      "digits and dashes": length => repeatTo("1000-", length),
      "short tails": length => wholeUnits("1000-01 ", length),
      "long tails": length => wholeUnits("1000-0011 ", length),
      "dashes after 4 digits": length => `1000${"-".repeat(length - 4)}`,
      "a long run of digits": length => "1".repeat(length),
    },
  },
  postcodePL: {
    type: "POSTCODE",
    source:
      "a Poczta Polska postcode, 2 digits, a dash and 3 digits, in region PL",
    region: "PL",
    finds: [
      "[[00-950]] Warszawa",
      "[[31-042]] Kraków",
      "ul. Marszałkowska 1, [[00-624]] Warszawa",
      "[[80-001]] Gdańsk",
      "[[50-370]] Wrocław",
      "([[61-701]])",
      "[[90-001]].",
      "[[00-950]] i [[02-797]]",
      "kod [[44-100]] Gliwice",
      "[[70-952]] Szczecin",
    ],
    ignores: [
      ["00950", "no dash"],
      ["00 950", "a space instead of a dash"],
      ["0-950", "1 digit before the dash"],
      ["000-950", "3 digits before the dash"],
      ["00-95", "2 digits after the dash"],
      ["00-9500", "4 digits after the dash"],
      ["a00-950", "inside a word"],
      ["1.00-950", "after a dot"],
      ["00-950x", "followed by a letter"],
      ["00-950-1", "followed by a dash"],
      ["1000-001", "a Portuguese layout"],
      ["94105-1234", "a ZIP+4"],
    ],
    adversarial: {
      "digit pairs and dashes": length => repeatTo("00-", length),
      "short tails": length => wholeUnits("00-95 ", length),
      "long tails": length => wholeUnits("00-9500 ", length),
      "dashes after 2 digits": length => `00${"-".repeat(length - 2)}`,
      "a long run of digits": length => "1".repeat(length),
    },
  },
  postcodeNL: {
    type: "POSTCODE",
    source:
      "a PostNL postcode, 4 digits not starting with 0 and 2 capitals, in region NL, unless the letters are a unit or not issued",
    region: "NL",
    finds: [
      "[[1012 AB]] Amsterdam",
      "[[1012AB]]",
      "[[3011 CK]] Rotterdam",
      "[[2511 BT]] Den Haag",
      "Postcode: [[9711 LM]]",
      "[[5611 AZ]] Eindhoven",
      "Damrak 1, [[1012 LG]] Amsterdam",
      "([[3511 AX]])",
      "[[6211 CD]].",
      "[[7511 JE]] Enschede",
      "[[1012 JS]] en [[1017 CT]]",
    ],
    ignores: [
      ["2024 AD", "a year and an era"],
      ["1000 KB", "a unit"],
      ["1012 SS", "SS is not issued"],
      ["0123 AB", "starts with 0"],
      ["1012 ab", "lower case"],
      ["101 AB", "3 digits"],
      ["10123 AB", "5 digits"],
      ["1012 ABC", "3 letters"],
      ["1012  AB", "two spaces"],
      ["1012-AB", "a dash"],
      ["a1012 AB", "inside a word"],
      ["1012 AB1", "followed by a digit"],
    ],
    adversarial: {
      "numbers and units": length => wholeUnits("1000 KB ", length),
      "capitals in a row": length => `1012 ${"A".repeat(length - 5)}`,
      "years and eras": length => wholeUnits("2024 AD ", length),
      "four digits in a row": length => repeatTo("1012", length),
      "codes with 3 letters": length => wholeUnits("1012 ABC ", length),
    },
  },
  postcodeUS: {
    type: "POSTCODE",
    source: "a USPS ZIP+4 code, 5 digits, a dash and 4 digits, in region US",
    region: "US",
    finds: [
      "[[94105-1234]]",
      "ship to [[10001-0001]]",
      "[[02108-4321]]",
      "my address ends in [[60614-2345]].",
      "([[30301-1111]])",
      "[[94105-1234]] and [[94107-5678]]",
      "[[73301-0001]] Austin",
      "ZIP+4 [[20500-0003]]",
      "[[99501-2222]]",
      "office [[33101-9999]], Miami",
    ],
    ignores: [
      ["94105", "a plain 5 digits"],
      ["94105-123", "a short tail"],
      ["94105-12345", "a long tail"],
      ["9410-1234", "4 digits before the dash"],
      ["94105 1234", "a space instead of a dash"],
      ["94105–1234", "an en dash"],
      ["a94105-1234", "inside a word"],
      ["1.94105-1234", "after a dot"],
      ["94105-1234x", "followed by a letter"],
      ["94105-1234-5", "followed by a dash"],
      ["00-950", "a Polish layout"],
      ["1000-001", "a Portuguese layout"],
    ],
    adversarial: {
      "digits and dashes": length => repeatTo("12345-", length),
      "short tails": length => wholeUnits("94105-123 ", length),
      "a long run of digits": length => "9".repeat(length),
      "dashes after 5 digits": length => `94105${"-".repeat(length - 5)}`,
      "plain ZIP codes": length => wholeUnits("94105 ", length),
    },
  },
  postcodeCued: {
    type: "POSTCODE",
    source:
      "4 or 5 digits, or a US ZIP+4, Dutch, Polish or Portuguese postcode, right after a postcode cue such as 'zip code', 'PLZ' or 'code postal' in one of 8 languages",
    finds: [
      "zip code [[94105]]",
      "ZIP: [[10001]]",
      "PLZ [[10115]] Berlin",
      "code postal [[75008]]",
      "CAP [[00184]] Roma",
      "Postleitzahl: [[80331]]",
      "postcode [[2000]]",
      "código postal [[28013]]",
      "C.P. [[06600]]",
      "CP [[28013]] Madrid",
      "postnummer [[11122]]",
      "codice postale [[20121]]",
      "zip#[[90210]]",
      "my zip code is [[94105]]",
      "zip [[94105-1234]]",
      "postcode [[1012 AB]] Amsterdam",
      "postcode [[1012AB]]",
      "kod pocztowy [[00-950]]",
      "código postal [[1000-001]] Lisboa",
    ],
    ignores: [
      ["order 12345", "no cue"],
      ["ZIP file 12345", "a word between the cue and the number"],
      ["price cap 5000", "a lower-case cap is an ordinary word"],
      ["CAPS 12345", "CAP inside a word"],
      ["HANDICAP 12345", "CAP at the end of a word"],
      ["zippy 12345", "zip inside a word"],
      ["zip code 123", "3 digits"],
      ["zip code 123456", "6 digits"],
      ["zip code 12345.6", "a decimal"],
      ["zip code 1234x", "followed by a letter"],
      ["zip code: v12345", "after a letter"],
      ["zip code - - - - 12345", "more than 6 separators"],
      ["94105-1234 is a ZIP+4", "no cue"],
      ["1012 AB Amsterdam", "no cue"],
      ["00-950 items", "no cue"],
      ["1000-001 is an id", "no cue"],
    ],
    adversarial: {
      "cues in a row": length => repeatTo("zip ", length),
      "a cue and separators": length => `zip${repeatTo(" :.=#-", length - 3)}`,
      "cues and short numbers": length => wholeUnits("zip 123 ", length),
      "cues and long numbers": length => wholeUnits("zip 123456 ", length),
      "numbers without a cue": length => wholeUnits("order 12345 ", length),
    },
  },
  zipAfterState: {
    type: "POSTCODE",
    source:
      "a 5-digit US ZIP code or ZIP+4 right after a comma and a USPS state abbreviation",
    finds: [
      "San Francisco, CA [[94105]]",
      "Houston, TX, [[77036]].",
      "Antioch, CA, [[94509]], USA",
      "Springfield, IL [[62704]]",
      "Austin, TX [[78701-1234]]",
      "New York,NY [[10001]]",
      "Portland, OR [[97201]]",
      "Boston, MA [[02108]]",
      "Honolulu, HI [[96813]]",
      "Washington, DC [[20500]]",
      "Miami, FL [[33101]] and Tampa, FL [[33602]]",
    ],
    ignores: [
      ["Seattle WA 98101", "no comma before the state"],
      ["my IN 12345 form", "no comma before the state"],
      ["Order ID 12345", "no state"],
      ["Paris, FR 75008", "FR is not a state"],
      ["Austin, TXX 78701", "not a state abbreviation"],
      ["Austin, tx 78701", "a lower-case state"],
      ["Austin, TX 7870", "4 digits"],
      ["Austin, TX 787011", "6 digits"],
      ["Austin, TX 78701-12", "a short ZIP+4 tail"],
      ["Austin, TX 78701abc", "followed by letters"],
      ["Austin, TX  78701", "two spaces"],
      ["Austin,  TX 78701", "two spaces after the comma"],
    ],
    adversarial: {
      "states and short numbers": length => wholeUnits(", TX 1234 ", length),
      "commas and states": length => repeatTo(", CA", length),
      "a state and a long run of digits": length =>
        `, CA ${"1".repeat(length - 5)}`,
      "states without a comma": length =>
        wholeUnits("Seattle WA 98101 ", length),
      "a state then spaces": length => `, CA${" ".repeat(length - 4)}`,
    },
  },
  postcodeCanada: {
    type: "POSTCODE",
    source:
      "a Canadian postal code in capitals, A1A 1A1 with the letters Canada Post allows in each position",
    finds: [
      "[[K1A 0B1]]",
      "[[M5V 3L9]] Toronto",
      "[[H2X 1Y4]]",
      "[[V6B 4Y8]]",
      "[[T2P-2M5]]",
      "[[K1A0B1]]",
      "Ottawa ON [[K2P 1L4]]",
      "([[R3C 4T3]])",
      "[[X0A 0H0]]",
      "[[B3H 1Z5]].",
      "[[E1C 4M3]]",
    ],
    ignores: [
      ["D1A 0B1", "D starts no Canadian postal code"],
      ["W1A 0B1", "W starts no Canadian postal code"],
      ["K1D 0B1", "D is not used"],
      ["K1A 0O1", "O is not used"],
      ["k1a 0b1", "lower case"],
      ["1KA 0B1", "starts with a digit"],
      ["K1A 0B", "no last digit"],
      ["K1A  0B1", "two spaces"],
      ["K1A.0B1", "a dot"],
      ["XK1A 0B1", "inside a word"],
      ["K1A 0B1X", "followed by a letter"],
      ["K1A 0B12", "followed by a digit"],
    ],
    adversarial: {
      "letter-digit pairs": length => repeatTo("K1", length),
      "half codes": length => wholeUnits("K1A ", length),
      "codes with a letter not used": length => wholeUnits("K1A 0O1 ", length),
      "dashes after a half code": length => `K1A${"-".repeat(length - 3)}`,
      "lower-case codes": length => wholeUnits("k1a 0b1 ", length),
    },
  },
  postcodeUK: {
    type: "POSTCODE",
    source:
      "a UK postcode in capitals, with the letters Royal Mail allows in each position",
    finds: [
      "[[SW1A 2AA]]",
      "ship to [[M1 1AE]]",
      "[[EC1A 1BB]] London",
      "postcode: [[B33 8TH]]",
      "[[CR2 6XH]]",
      "[[DN55 1PT]]",
      "[[W1A 0AX]]",
      "[[SW1A2AA]]",
      "[[GIR 0AA]]",
      "10 Downing Street, London [[SW1A 2AA]].",
      "([[LS1 4AP]])",
      "[[G2 3WT]]",
    ],
    ignores: [
      ["flight BA123", "a flight number"],
      ["room 4B", "no inward code"],
      ["sw1a 2aa", "lower case"],
      ["SW1A 2CA", "C is not used in the inward code"],
      ["QA1 2AB", "Q does not start an area"],
      ["AI1 2AB", "I is not a second area letter"],
      ["SW 2AA", "no district digit"],
      ["XSW1A 2AA", "inside a word"],
      ["SW1A 2AAB", "followed by a letter"],
      ["M1 1AE2", "followed by a digit"],
      ["SW1A  2AA", "two spaces"],
      ["SW1A-2AA", "a dash"],
      ["I bought an M2 1TB SSD", "a storage size"],
      ["an M2 2TB drive", "a storage size"],
    ],
    adversarial: {
      "outward codes glued together": length => repeatTo("SW1A", length),
      "outward codes only": length => wholeUnits("SW1A ", length),
      "inward codes with a letter not used": length =>
        wholeUnits("SW1A 2CA ", length),
      "capitals in a row": length => repeatTo("A", length),
      "digits and capitals": length => repeatTo("1A", length),
    },
  },
  poBox: {
    type: "PO_BOX",
    source:
      "a PO box keyword in one of 8 languages and the box number, as postal services write them",
    finds: [
      "[[P.O. Box 1234]], Springfield",
      "send it to [[PO Box 77]].",
      "[[POB 4521]]",
      "[[Post Office Box 9]]",
      "[[Postfach 12 34 56]]",
      "[[Boîte postale 54]]",
      "[[B.P. 1203]] Dakar",
      "[[Apartado de Correos 1234]]",
      "[[Apdo. 77]], Madrid",
      "[[Caixa Postal 1234]]",
      "[[Casella Postale 12]]",
      "[[Postbus 2500]]",
      "[[skrytka pocztowa 15]]",
      "[[PO Box #42]]",
      "[[Postfach Nr. 1234]]",
    ],
    ignores: [
      ["PO Box", "no number"],
      ["Postfach", "no number"],
      ["PO Box 1234567", "a box number of more than 6 digits"],
      ["the box 12", "no PO box keyword"],
      ["box 7 of the shipment", "no PO box keyword"],
      ["Xbox 360", "box inside a word"],
      ["inbox 42 messages", "box inside a word"],
      ["Dropbox 2", "box inside a word"],
      ["tipo box 5", "no PO box keyword"],
      ["PO number 4521", "a purchase order"],
      ["BP 2023 results", "a bare BP is also a company"],
      ["apartado 3 del contrato", "a bare apartado is also a section"],
      [
        "Numer dowodu osobistego: POB268787",
        "POB glued to digits is a Polish ID card number",
      ],
    ],
    adversarial: {
      "keywords in a row": length => repeatTo("PO Box ", length),
      "a keyword then spaces": length => `Postfach${" ".repeat(length - 8)}`,
      "a keyword and number signs": length =>
        `PO Box${repeatTo(" #", length - 6)}`,
      "partial keywords": length => repeatTo("P.O. Bo ", length),
      "keywords glued to digits": length => wholeUnits("POB268787 ", length),
    },
  },
  gpsPairSpace: {
    type: "GPS",
    source:
      "a latitude and a longitude in decimal degrees with at least 4 decimals each, on one line with spaces between",
    finds: [
      "at [[-62.315136 47.886046]] now",
      "[[48.8584 2.2945]]",
      "[[51.5074 -0.1278]]",
      "[[40.7128   -74.0060]]",
      "loc: [[35.6762 139.6503]]",
      "[[52.5200 13.4050]].",
      "[[-33.8688 151.2093]]",
      "([[37.7749 -122.4194]])",
      "[[0.0000 0.0000]]",
      "[[89.9999 179.9999]]",
      "[[1.290270\t103.851959]]",
    ],
    ignores: [
      ["95.1234 2.3456", "a latitude above 90"],
      ["45.1234 181.5000", "a longitude above 180"],
      ["181.5000 20.1234", "a three-digit latitude"],
      ["48.858 2.294", "fewer than 4 decimals"],
      ["48.8584 2.294", "a longitude with 3 decimals"],
      ["48.858 2.2945", "a latitude with 3 decimals"],
      ["0.1234\n0.5678", "two numbers on separate lines"],
      ["scores 12.3456 and 65.4321", "a word between"],
      ["v2.3456 7.8910", "after a letter"],
      ["48.8584 2.2945x", "followed by a letter"],
      ["48.8584 2.2945.1", "a version number after"],
    ],
    adversarial: {
      "a long decimal": length => `1.${"1".repeat(length - 2)}`,
      "a decimal then spaces": length => `48.8584${" ".repeat(length - 7)}`,
      "pairs with 3 decimals": length => wholeUnits("48.858 2.294 ", length),
      "pairs out of range": length => wholeUnits("95.1234 181.5000 ", length),
      "one number per line": length => wholeUnits("0.1234\n", length),
    },
  },
  gpsPairComma: {
    type: "GPS",
    source:
      "a latitude and a longitude in decimal degrees with at least 3 decimals each, joined by a comma, unless both are unsigned with exactly 3",
    finds: [
      "[[48.8584, 2.2945]]",
      "[[37.7749,-122.4194]]",
      "[[51.5074, -0.1278]]",
      "coords ([[35.6762, 139.6503]])",
      "home is [[52.5200, 13.4050]].",
      "[[-33.8688, 151.2093]]",
      "[[40.712, -74.006]]",
      "meet at [[48.858370 , 2.294481]] tonight",
      "[[0.0000, 0.000]]",
      "[[89.999, -179.999]]",
      "[[-1.500, 2.300]]",
      "[[-16.4197445,160.329054]]",
      "[[1.290270, 103.851959]]",
    ],
    ignores: [
      ["95.1234, 2.3456", "a latitude above 90"],
      ["45.1234, 181.5000", "a longitude above 180"],
      ["181.5000, 20.1234", "a three-digit latitude"],
      ["48.8, 2.2", "fewer than 3 decimals"],
      ["48.8584, 2.29", "a longitude with 2 decimals"],
      ["price 12.99, 14.99", "prices with 2 decimals"],
      ["1.5, 2.25, 3.125", "fewer than 3 decimals"],
      ["12.3456.7890, 1.234", "a version number"],
      ["48.8584, 2.2945.1", "a version number after"],
      ["v2.3456, 7.8910", "after a letter"],
      ["48.8584, 2.2945x", "followed by a letter"],
      ["48.858 2.294", "no comma"],
      ["1.500, 2.300", "may be thousands"],
      ["Preise: 12.500, 14.900 und 16.000 Euro", "may be thousands"],
      ["89.999, 179.999", "may be thousands"],
    ],
    adversarial: {
      "a long decimal": length => `1.${"1".repeat(length - 2)}`,
      "pairs joined by a semicolon": length =>
        wholeUnits("48.8584 ; 2.2945; ", length),
      "commas and spaces": length => `48.858${repeatTo(" , ", length - 6)}`,
      "pairs out of range": length => wholeUnits("95.1234, 2.3456; ", length),
      "pairs with 2 decimals": length => wholeUnits("48.85, 2.29 ", length),
    },
  },
  gpsLabeled: {
    type: "GPS",
    source:
      "a latitude of at most 90 and a longitude of at most 180, each after its label",
    finds: [
      "[[lat 48.8584 lon 2.2945]]",
      "[[Latitude: -16.4197445, Longitude: 160.329054]]",
      "[[lat: 40.7128 long: -74.0060]]",
      "[[lat=51.5074, lon=-0.1278]]",
      "[[lat: 37.7749, lng: -122.4194]]",
      "my home: [[latitude 35.6762 longitude 139.6503]]",
      "[[lat 52.52°, lon 13.405]]",
      "[[LAT 33.8688; LON 151.2093]]",
      "[[lat 0 lon 0]]",
      "[[lat 90 lon 180]]",
      "[[lat -90 lon -180]]",
      "[[lat 52.52 lon 13.405]].",
      "[[lat48.8584 lon2.2945]]",
    ],
    ignores: [
      ["lat 95.1 lon 2.3", "a latitude above 90"],
      ["lat 45 lon 181", "a longitude above 180"],
      ["lat 45 lon 1800", "a four-digit longitude"],
      ["lat 123 lon 45", "a latitude above 90"],
      ["lat 1.2 lon 3.4.5", "a version number"],
      ["latitude is high", "no number"],
      ["lat 48.8584", "no longitude"],
      ["flat 48.1 long 2.2", "lat inside a word"],
      ["lat 48.8584 lonely 2.2945", "lon inside a word"],
      ["lat 48.8584 and lon 2.2945", "a word between"],
      ["lat 48. lon 2", "a dot after the latitude"],
    ],
    adversarial: {
      "labels in a row": length => repeatTo("lat ", length),
      "a label and spaces": length => `lat${" ".repeat(length - 3)}`,
      "values out of range": length => wholeUnits("lat 95 lon 2 ", length),
      "separators after a latitude": length =>
        `lat 48${repeatTo(" ,;°", length - 6)}`,
      "a long decimal": length => `lat 1.${"1".repeat(length - 6)}`,
    },
  },
  phoneGB: {
    type: "PHONE",
    source:
      "the UK mobile layout, 07 and 9 more digits as 5-6 or 5-3-3 (Ofcom numbering plan), in region GB; the numbers are from Ofcom's range for TV and radio",
    region: "GB",
    finds: [
      "[[07700 900123]]",
      "[[07700900123]]",
      "[[07700-900123]]",
      "[[07700 900 123]]",
      "[[07700-900-777]]",
      "my mobile is [[07700 900982]]",
      "text me on [[07700 900321]]",
      "ring [[07700900555]] tomorrow",
      "([[07700 900111]])",
      "[[07700 900123]] or [[07700 900124]].",
      "[[07700 900 456]]!",
    ],
    ignores: [
      ["020 7946 0958", "a landline, not a mobile"],
      ["08700 900123", "does not start with 07"],
      ["0770 900123", "a four-digit prefix"],
      ["07700 90012", "5 digits after the prefix"],
      ["07700 9001234", "7 digits after the prefix"],
      ["07700 90 01 23", "pairs"],
      ["107700 900123", "inside a longer number"],
      ["a07700 900123", "inside a word"],
      ["07700 900123x", "followed by a letter"],
      ["07700.900123", "a dot separator"],
      ["07700  900123", "two spaces"],
      ["06 12 34 56 78", "a French layout"],
    ],
    adversarial: {
      "07 in a row": length => repeatTo("07", length),
      "a prefix and a long run of digits": length =>
        `07700${"9".repeat(length - 5)}`,
      "one digit short": length => wholeUnits("07700 90012 ", length),
      "dashes after a prefix": length => `07700${"-".repeat(length - 5)}`,
      "short groups": length => wholeUnits("07700 900 12 ", length),
    },
  },
  phoneIT: {
    type: "PHONE",
    source:
      "the Italian mobile layout, 3 and 2 digits, then 6 or 7 digits whole or in groups (AGCOM numbering plan), in region IT",
    region: "IT",
    finds: [
      "[[333 1234567]]",
      "[[333-1234567]]",
      "[[347 123456]]",
      "[[320 123 4567]]",
      "[[391 123 456]]",
      "[[388 1234567]]",
      "[[366-123-4567]]",
      "il mio cellulare è [[333 1234567]]",
      "scrivimi al [[349 7654321]]",
      "([[333 1234567]])",
      "[[333 1234567]] o [[340 7654321]].",
    ],
    ignores: [
      ["06 1234567", "a landline, not a mobile"],
      ["433 1234567", "does not start with 3"],
      ["33 1234567", "a two-digit prefix"],
      ["3331234567", "no separator after the prefix"],
      ["333 12345", "5 digits after the prefix"],
      ["333 12345678", "8 digits after the prefix"],
      ["333 123 45", "5 digits in groups"],
      ["1333 1234567", "inside a longer number"],
      ["a333 1234567", "inside a word"],
      ["333 1234567b", "followed by a letter"],
      ["333.1234567", "a dot separator"],
      ["333  1234567", "two spaces"],
    ],
    adversarial: {
      "a 3 and a long run of digits": length => `3${"3".repeat(length - 1)}`,
      "prefixes and short numbers": length => wholeUnits("333 12345 ", length),
      "two-digit groups": length => repeatTo("33 ", length),
      "dashes after a prefix": length => `333${"-".repeat(length - 3)}`,
      "short groups after a prefix": length =>
        wholeUnits("333 123 45 ", length),
    },
  },
  phonePL: {
    type: "PHONE",
    source:
      "the Polish mobile layout, a mobile prefix such as 50 or 60 and 7 more digits in groups 3-3-3 (UKE numbering plan), in region PL",
    region: "PL",
    finds: [
      "[[512 345 678]]",
      "[[512-345-678]]",
      "[[501 234 567]]",
      "[[600 123 456]]",
      "[[691 234 567]]",
      "[[781 234 567]]",
      "[[881 234 567]]",
      "[[451 234 567]]",
      "mój numer to [[530 123 456]]",
      "napisz na [[668 123 456]]!",
      "([[722 123 456]])",
      "[[512 345 678]] lub [[798 765 432]].",
    ],
    ignores: [
      ["123 456 789", "1 starts no mobile number"],
      ["220 123 456", "22 is a landline prefix"],
      ["555 123 456", "55 is not a mobile prefix"],
      ["512345678", "no separators"],
      ["512 345 67", "8 digits"],
      ["512 145 6789", "10 digits"],
      ["1512 345 678", "inside a longer number"],
      ["a512 345 678", "inside a word"],
      ["512 345 678b", "followed by a letter"],
      ["512.345.678", "dot separators"],
      ["512  345 678", "two spaces"],
      ["22 123 45 67", "a landline layout"],
    ],
    adversarial: {
      "a 5 and a long run of digits": length => `5${"1".repeat(length - 1)}`,
      "one digit short": length => wholeUnits("512 345 67 ", length),
      "numbers with a landline prefix": length =>
        wholeUnits("123 456 789, ", length),
      "prefixes in a row": length => repeatTo("51 ", length),
      "dashes after a prefix": length => `512${"-".repeat(length - 3)}`,
    },
  },
  phonePT: {
    type: "PHONE",
    source:
      "the Portuguese mobile layout, 91, 92, 93 or 96 and 7 more digits in groups 3-3-3 (ANACOM numbering plan), in region PT",
    region: "PT",
    finds: [
      "[[912 345 678]]",
      "[[912-345-678]]",
      "[[921 234 567]]",
      "[[931 234 567]]",
      "[[961 234 567]]",
      "[[925-111-222]]",
      "o meu telemóvel é [[912 345 678]]",
      "liga-me para o [[936 123 456]]",
      "([[912 345 678]])",
      "[[912 345 678]] ou [[962 345 678]]",
      "[[919 876 543]].",
    ],
    ignores: [
      ["942 345 678", "94 is not a mobile prefix"],
      ["212 345 678", "a landline, not a mobile"],
      ["912345678", "no separators"],
      ["912 345 67", "8 digits"],
      ["912 145 6789", "10 digits"],
      ["1912 345 678", "inside a longer number"],
      ["a912 345 678", "inside a word"],
      ["912 345 678b", "followed by a letter"],
      ["912.345.678", "dot separators"],
      ["912  345 678", "two spaces"],
      ["912 34 56 78", "pairs, as in Spain"],
      ["612 345 678", "a Spanish layout"],
    ],
    adversarial: {
      "a 9 and a long run of digits": length => `9${"1".repeat(length - 1)}`,
      "one digit short": length => wholeUnits("912 345 67 ", length),
      "prefixes in a row": length => repeatTo("91 ", length),
      "numbers with a wrong prefix": length =>
        wholeUnits("942 345 678 ", length),
      "dashes after a prefix": length => `912${"-".repeat(length - 3)}`,
    },
  },
  phoneES: {
    type: "PHONE",
    source:
      "the Spanish layout, 9 digits starting with 6 to 9 in groups 3-3-3 or 3-2-2-2 (CNMC numbering plan), in region ES, unless it is a toll-free number",
    region: "ES",
    finds: [
      "[[612 345 678]]",
      "[[612-345-678]]",
      "[[712 345 678]]",
      "[[912 345 678]]",
      "[[612 34 56 78]]",
      "[[933 12 34 56]]",
      "mi móvil es [[612 345 678]]",
      "escríbeme al [[699 123 456]]",
      "([[612 345 678]])",
      "[[612 345 678]] o [[623 456 789]]",
      "[[876 543 210]].",
    ],
    ignores: [
      ["900 100 200", "a toll-free number"],
      ["800 123 456", "a toll-free number"],
      ["512 345 678", "does not start with 6 to 9"],
      ["612345678", "no separators"],
      ["612 345 67", "8 digits"],
      ["612 145 6789", "10 digits"],
      ["612 34 56 7", "8 digits in pairs"],
      ["1612 345 678", "inside a longer number"],
      ["a612 345 678", "inside a word"],
      ["612 345 678b", "followed by a letter"],
      ["612.345.678", "dot separators"],
      ["612  345 678", "two spaces"],
      ["06 12 34 56 78", "a French layout"],
    ],
    adversarial: {
      "a digit and a long run of digits": length =>
        `6${"1".repeat(length - 1)}`,
      "one digit short": length => wholeUnits("612 345 67 ", length),
      "two-digit groups": length => repeatTo("61 ", length),
      "toll-free numbers": length => wholeUnits("900 100 200 ", length),
      "dashes after a group": length => `612${"-".repeat(length - 3)}`,
    },
  },
  phoneDE: {
    type: "PHONE",
    source:
      "the German mobile layout, a 015x, 016x or 017x prefix and 6 to 8 digits (Bundesnetzagentur numbering plan), in region DE",
    region: "DE",
    finds: [
      "[[0171 2345678]]",
      "[[01712345678]]",
      "[[0171/2345678]]",
      "[[0171-2345678]]",
      "[[0151 12345678]]",
      "[[0160 1234567]]",
      "[[0176 1234 5678]]",
      "[[0171 234 5678]]",
      "mein Handy: [[0171 2345678]]",
      "Ruf mich unter [[0157 12345678]] an",
      "([[0171 2345678]])",
      "[[0162 9876543]].",
    ],
    ignores: [
      ["030 1234567", "a landline, not a mobile"],
      ["0181 2345678", "not 015, 016 or 017"],
      ["0171 23456", "5 digits after the prefix"],
      ["0171 123456789", "9 digits after the prefix"],
      ["10171 2345678", "inside a longer number"],
      ["a0171 2345678", "inside a word"],
      ["0171 2345678x", "followed by a letter"],
      ["0171 2345678-0", "followed by a dash"],
      ["0171.2345678", "a dot separator"],
      ["0171  2345678", "two spaces"],
      ["06 12 34 56 78", "a French layout"],
    ],
    adversarial: {
      "01 in a row": length => repeatTo("01", length),
      "a prefix and a long run of digits": length =>
        `0171${"2".repeat(length - 4)}`,
      "prefixes and short numbers": length => wholeUnits("0171 23456 ", length),
      "slashes after a prefix": length => `0171${"/".repeat(length - 4)}`,
      "prefixes and two-digit groups": length => repeatTo("0171 23 ", length),
    },
  },
  phoneNL: {
    type: "PHONE",
    source:
      "the Dutch mobile layout, 06 and 8 digits (ACM numbering plan), in region NL",
    region: "NL",
    finds: [
      "[[06 12345678]]",
      "[[0612345678]]",
      "[[06-12345678]]",
      "[[06 12 34 56 78]]",
      "[[06-12 34 56 78]]",
      "[[06 1234 5678]]",
      "mijn nummer is [[06 12345678]]",
      "bel me op [[06-87654321]]!",
      "([[0612345678]])",
      "[[06 12345678]] of [[06 87654321]]",
      "[[06 98765432]].",
    ],
    ignores: [
      ["020 123 4567", "a landline, not a mobile"],
      ["05 12345678", "does not start with 06"],
      ["06 1234567", "7 digits after 06"],
      ["06 123456789", "9 digits after 06"],
      ["106 12345678", "inside a longer number"],
      ["a0612345678", "inside a word"],
      ["0612345678b", "followed by a letter"],
      ["0612345678-1", "followed by a dash"],
      ["06.12345678", "a dot separator"],
      ["06_12345678", "an underscore"],
      ["06  12345678", "two spaces"],
      ["0171 2345678", "a German layout"],
    ],
    adversarial: {
      "06 in a row": length => repeatTo("06", length),
      "06 and a long run of digits": length => `06${"1".repeat(length - 2)}`,
      "one digit short": length => wholeUnits("06 1234567 ", length),
      "pairs with a doubled space": length =>
        wholeUnits("06 12  34 56 78 ", length),
      "dashes after 06": length => `06${"-".repeat(length - 2)}`,
    },
  },
  phoneFR: {
    type: "PHONE",
    source:
      "the French national layout, 0 and 9 digits in pairs (ARCEP numbering plan), in region FR, unless it is a toll-free number",
    region: "FR",
    finds: [
      "[[06 12 34 56 78]]",
      "[[0612345678]]",
      "[[06.12.34.56.78]]",
      "[[07-12-34-56-78]]",
      "[[01 23 45 67 89]]",
      "[[04 91 12 34 56]]",
      "mon numéro : [[06 12 34 56 78]]",
      "Rappelle-moi au [[07 81 23 45 67]] stp",
      "([[06 12 34 56 78]])",
      "[[09 87 65 43 21]].",
      "[[06 12 34 56 78]] ou [[07 12 34 56 78]]",
    ],
    ignores: [
      ["08 00 12 34 56", "a toll-free number"],
      ["0800 12 34 56", "a toll-free number"],
      ["00 12 34 56 78", "0 then 0 starts no French number"],
      ["16 12 34 56 78", "does not start with 0"],
      ["06 12 34 56 7", "9 digits"],
      ["06 12 34 56 789", "11 digits"],
      ["a06 12 34 56 78", "inside a word"],
      ["06 12 34 56 78a", "followed by a letter"],
      ["06 12 34 56 78-9", "followed by a dash"],
      ["06_12_34_56_78", "underscores"],
      ["0171 2345678", "a German layout"],
      ["612 345 678", "a Spanish layout"],
    ],
    adversarial: {
      "zeros in a row": length => repeatTo("0", length),
      "a 0 and a long run of digits": length => `0${"6".repeat(length - 1)}`,
      "one digit short": length => wholeUnits("06 12 34 56 7 ", length),
      "doubled separators": length => repeatTo("06 .-", length),
      "toll-free numbers": length => wholeUnits("08 00 12 34 56 ", length),
    },
  },
  phoneCued: {
    type: "PHONE",
    source:
      "7 to 12 digits, or up to 15 after 00, next to a phone cue word in one of 8 languages, unless it is a toll-free number or a date",
    finds: [
      "call me on [[0612 345 678]]",
      "tel: [[020 7946 0958]]",
      "phone [[06 12 34 56 78]]",
      "WhatsApp [[0171 2345678]]",
      "appelle-moi au [[06 12 34 56 78]]",
      "mein Handy [[0171 2345678]]",
      "Bei Fragen erreichen Sie uns unter [[040 1234567]].",
      "moet ik [[(0357) 478774]] bellen?",
      "para entrar em contato? [[94 7644-5204]]",
      "Mijn telefoonnummer is [[(0808) 273054]].",
      "My new phone number is [[001-915-679-9022]].",
      "[[0612 345 678]] is my phone",
      "zadzwoń [[512 345 678]]",
      "chiama il [[333 1234567]]",
      "📞 [[030 901820]]",
    ],
    ignores: [
      ["call 1-800-280-4331", "a toll-free number"],
      ["call 001 800 280 4331", "a toll-free number after 00 1"],
      ["call 0044 800 123 4567", "a UK toll-free number after 00 44"],
      ["llama al 900 100 200", "a toll-free number"],
      ["telefon 0800 330 1000", "a toll-free number"],
      ["ligar para o 0800 727 0101", "a toll-free number"],
      ["tel 0808 157 0192", "a toll-free number"],
      ["order 12345678", "no phone cue"],
      ["call 911", "fewer than 7 digits"],
      ["call me at 12 34 56", "fewer than 7 digits"],
      ["phone 1234567890123", "more than 12 digits"],
      ["call me on 2024-01-15", "a date"],
      ["phone: on 12/03/1990", "a date"],
      ["tel 2024 10 30 14:30", "followed by a time"],
    ],
    adversarial: {
      "a cue and a long run of digits": length =>
        `call ${"1".repeat(length - 5)}`,
      "a cue then separators": length =>
        `call ${repeatTo("(-./ ", length - 5)}`,
      "cues and short numbers": length => wholeUnits("call 911 ", length),
      "dates after cues": length => wholeUnits("phone: on 12/03/1990 ", length),
      "toll-free numbers after cues": length =>
        wholeUnits("call 1-800-280-4331 ", length),
      "cue words without numbers": length =>
        repeatTo("call phone tel mobile ", length),
      "long numbers after cues": length =>
        wholeUnits("phone 1234567890123 ", length),
    },
  },
  phoneNorthAmerican: {
    type: "PHONE",
    source:
      "North American Numbering Plan NXX-NXX-XXXX, where N is 2 to 9, unless it is a toll-free number",
    finds: [
      "[[(415) 555-0134]]",
      "[[415-555-0134]]",
      "[[415.555.0134]]",
      "[[415 555 0134]]",
      "[[(415)555-0134]]",
      "call me at [[(212) 555-0199]] tonight",
      "office: [[617-555-0123]], ext 4",
      "[[604-555-0177]]",
      "My number is [[312.555.0110]].",
      "[[202-555-0187]] or [[202-555-0188]]",
      "Text [[713 555 0145]]",
      "[[1-415-555-0134]]",
      "call [[1 (212) 555-0199]]",
    ],
    ignores: [
      ["800-555-0123", "a toll-free number"],
      ["(888) 555-0100", "a toll-free number"],
      ["123-456-7890", "an area code cannot start with 1"],
      ["023-456-7890", "an area code cannot start with 0"],
      ["212-123-4567", "an exchange cannot start with 1"],
      ["415-555-01345", "a fifth digit at the end"],
      ["4415-555-0134", "inside a longer number"],
      ["SKU-415-555-0134", "after a dash"],
      ["415-555-0134-2", "followed by a dash"],
      ["415-555-0134abc", "followed by letters"],
      ["415_555_0134", "underscores"],
      ["11-415-555-0134", "a country code longer than 1"],
      ["1-800-555-0123", "a toll-free number"],
    ],
    adversarial: {
      "area codes in a row": length => repeatTo("415-", length),
      "one digit short": length => wholeUnits("415-555-013 ", length),
      "toll-free numbers": length => wholeUnits("800-555-0123 ", length),
      "parentheses around area codes": length => repeatTo("(415)", length),
      "three-digit groups": length => repeatTo("415 555 ", length),
    },
  },
  phoneInternational: {
    type: "PHONE",
    source:
      "'+' and a country code, 8 to 15 digits in all (ITU-T E.164), unless it is a toll-free number",
    finds: [
      "[[+31 6 12345678]]",
      "[[+1 (415) 555-0134]]",
      "reach [[+44 20 7946 0958]] today",
      "[[+49 30 901820]]",
      "[[+33 6 12 34 56 78]]",
      "WhatsApp: [[+34 612 345 678]]",
      "[[+48 512 345 678]].",
      "[[+39 312 345 6789]]",
      "call [[+351 912 345 678]]",
      "[[+1.415.555.0134]]",
      "([[+49 89 1234567]])",
      "[[+86 138 0013 8000]]",
      "[[+442079460958]]",
    ],
    ignores: [
      ["call +1 877 555 0123", "a toll-free number"],
      ["+1 800 280 4331", "a toll-free number"],
      ["+44 800 123 4567", "a UK toll-free number"],
      ["+34 900 100 200", "a Spanish toll-free number"],
      ["+49 800 1234567", "a German toll-free number"],
      ["+31 800 1234567", "a Dutch toll-free number"],
      ["+33 800 12 34 56", "a French toll-free number"],
      ["+39 800 123456", "an Italian toll-free number"],
      ["+48 800 123 456", "a Polish toll-free number"],
      ["+351 800 123 456", "a Portuguese toll-free number"],
      ["+1", "no number"],
      ["+12 34 56 7", "fewer than 8 digits"],
      ["+1234567890123456", "more than 15 digits"],
      ["temperature +12.5 / 13.7 today", "fewer than 8 digits"],
      ["a+49 30 901820", "a + inside a word"],
      ["++49 30 901820", "a doubled +"],
      ["+49 30 901820abc", "followed by letters"],
      ["score 3+4 5678 9012", "a + between numbers"],
      ["UTC+05:30", "a time zone"],
    ],
    adversarial: {
      "+ signs in a row": length => repeatTo("+1", length),
      "a + and a long run of digits": length => `+${"1".repeat(length - 1)}`,
      "separators after a +": length => `+1${repeatTo(" ()./-", length - 2)}`,
      "short international numbers": length =>
        wholeUnits("+12 34 56 7 ", length),
      "toll-free numbers": length => wholeUnits("+1 800 280 4331 ", length),
    },
  },
  platformAt: {
    type: "USERNAME",
    source:
      "an @handle with a letter in it right after a platform name such as Instagram or GitHub",
    finds: [
      "Instagram [[@paris.vibes]] photos of Paris",
      "twitter: [[@jsmith_42]]",
      "TikTok - [[@dance.queen]]",
      "on Threads [[@zuck_fan]]",
      "GitHub [[@octo-dev7]]",
      "Mastodon [[@anna_k]]",
      "Bluesky:[[@sky.walker]]",
      "Telegram [[@night_owl]]",
      "YouTube [[@cooking_with_ann]]",
      "Snap [[@ed99]]",
      // A trailing dot or dash is punctuation.
      "insta [[@kim.lee]].",
      "Twitch [[@gamer4life]]-",
    ],
    ignores: [
      ["Instagram @Override", "a Java annotation"],
      ["Facebook @media screen", "a CSS at-rule"],
      ["GitHub @angular/core", "a scoped package"],
      ["Instagram @a", "a single character"],
      [`Instagram @${"a".repeat(31)}`, "longer than 30 characters"],
      ["twitter @ 5pm", "no name after the @"],
      ["Instagrammer @kim", "the platform inside a word"],
      ["netflix @anna_k", "x at the end of a word"],
      ["Instagram stories @kim", "a word between the platform and the @"],
      ["telegram:: @anna", "two separators"],
      ["fb @@anna", "a doubled @"],
      ["3 x @2.99 each", "a price: no letter"],
      ["profile @2024", "no letter"],
      ["discord @everyone", "a mention of a whole server"],
      ["Discord @here", "a mention of everyone online"],
    ],
    adversarial: {
      "a platform then spaces": length => `twitter${" ".repeat(length - 7)}`,
      "platforms in a row": length => repeatTo("insta twitter x fb ", length),
      "a platform and a long handle-like run": length =>
        `twitter @${"a".repeat(length - 9)}`,
      "platforms before code words": length =>
        wholeUnits("GitHub @Override ", length),
      "separators after a platform": length =>
        `x${repeatTo(" - : -", length - 1)}`,
      "prices after x": length => wholeUnits("3 x @2.99 ", length),
    },
  },
  loginUser: {
    type: "USERNAME",
    source:
      "a handle that mixes a letter with an underscore or a digit, or follows an @, after a login cue such as 'username:' or 'log in as'",
    finds: [
      "username: [[firefox_fan99]] on Reddit",
      "Log in as [[admin_kyle]] to open Jira",
      "user [[mozilla_dev]] pushed to main",
      "Username [[pixel8pro]] bought a phone",
      "Steam id [[xX_Jordan23_Xx]] plays often",
      "Benutzername: [[max_mustermann]]",
      "my username is [[sam_k]]",
      "login: [[@jdoe]]",
      "signed in as [[kim_lee]].",
      "gamertag = [[NightOwl77]]",
      "nom d'utilisateur : [[lucie_m]]",
      "usuario es [[pedro_88]]",
      "gebruikersnaam is [[jan_dekker]]",
      "PSN ID: [[Sam-Plays-42]]",
      // A handle that starts like "is" or "as" keeps its first letters.
      "username [[isabel_99]]",
      "user [[asif_khan]]",
    ],
    ignores: [
      ["username: John", "no underscore or digit"],
      ["login page", "no underscore or digit"],
      ["user agent", "no underscore or digit"],
      ["login failed", "no underscore or digit"],
      ["the user 42 clicked", "no letter"],
      ["my user is 2024", "no letter"],
      ["enter your username", "no value"],
      ["username: ab", "shorter than 3 characters"],
      ["username: your_username", "a placeholder"],
      ["username: john_doe", "a placeholder"],
      ["username: test_user", "a placeholder"],
      ["username = get_user()", "code: a call"],
      ["username foo_bar=3", "code: an assignment"],
      ["user_id = 5", "user inside an identifier"],
      ["superuser abc_1", "user inside a word"],
      ["you need to handle err_timeout here", 'the verb "handle"'],
    ],
    adversarial: {
      "a cue then spaces": length => `username${" ".repeat(length - 8)}`,
      "cues in a row": length => repeatTo("user login nick ", length),
      "a cue then separators": length =>
        `username${repeatTo(": = : = ", length - 8)}`,
      "cues with placeholder values": length =>
        wholeUnits("username: your_username ", length),
      "a cue and a long run of underscores": length =>
        `username ${"_".repeat(length - 9)}`,
      "is and as after a cue": length =>
        `user ${repeatTo("is as is as ", length - 5)}`,
    },
  },
  homePath: {
    type: "USERNAME",
    source:
      "the account name in a macOS /Users/, Linux /home/ or Windows C:\\Users\\ home directory path",
    finds: [
      "/Users/[[jsmith]]/projects/app.py",
      "cat /home/[[maria]]/.ssh/id_rsa",
      "C:\\Users\\[[John]]\\Documents\\x.docx",
      "Error in /Users/[[anna.k]]/Library/Logs/app.log",
      "cd /home/[[dev-ops]]/src",
      'File "/home/[[pedro_88]]/venv/lib/python3.12/site.py", line 3',
      "D:\\Users\\[[Kim]]\\Desktop\\notes.txt",
      "open '/Users/[[lucie]]/Desktop/cv.pdf'",
      "(/home/[[jan]]/.bashrc)",
      "/Users/[[Ann]]/a and /Users/[[Bob]]/b",
      "path: /home/[[user42]]/",
      "C:\\Users\\[[Müller]]\\AppData",
      "c:\\users\\[[john]]\\docs",
      "/Users/[[jsmith]]",
      "cd C:\\Users\\[[anna]]",
      "my home is /home/[[anna]].",
      "C:\\Users\\[[John]] Smith\\Documents", // a gap: only the first word of a name with a space,
    ],
    ignores: [
      ["/Users/Shared/Documents", "a shared account"],
      ["/home/runner/work", "a CI account"],
      ["/home/ubuntu/app", "a cloud image's default account"],
      ["/home/admin/www", "an admin account"],
      ["C:\\Users\\Public\\Desktop", "a shared account"],
      ["C:\\Users\\Default\\NTUSER.DAT", "the default profile"],
      ["/Users/<username>/Library", "'<' cannot be in an account name"],
      ["/home/$USER/.config", "a shell variable"],
      ["C:\\Users\\%USERNAME%\\AppData", "a Windows variable"],
      ["/var/lib/docker/home/app/x", "/home inside a longer path"],
      ["see https://example.com/home/jsmith/page", "inside a URL"],
      ["see https://example.com/Users/jsmith/page", "inside a URL"],
      [
        "the files are under /Users/ and /home/ folders",
        "no account name after the folder",
      ],
    ],
    adversarial: {
      "a home prefix and a long name before a colon": length =>
        `/Users/${"a".repeat(length - 8)}:`,
      "home prefixes in a row": length => repeatTo("/home/", length),
      "Windows names before a colon": length =>
        wholeUnits("C:\\Users\\John: ", length),
      "shared accounts": length => wholeUnits("/Users/Shared/x ", length),
      "drive letters in a row": length => repeatTo("C:\\", length),
    },
  },
  discordTag: {
    type: "USERNAME",
    source:
      "Discord's legacy name#1234 tag within 60 characters after 'discord'",
    finds: [
      "my discord is [[coolcat#1234]]",
      "add me on discord: [[Ann_K#0420]]",
      "discord [[sam.w#9999]]",
      "Discord: [[xX_Gamer_Xx#0001]]",
      "my old discord tag was [[luna#4821]] before the change",
      "mein Discord ist [[max_m#1234]]",
      "mon discord c'est [[lucie#5678]]",
      "on Discord I am [[ab#0000]]",
      `discord: [[${"a".repeat(32)}#1234]]`,
      "my discord is [[coolcat#1234]].",
      "ping me on discord, [[kim.lee#3141]]!",
    ],
    ignores: [
      ["coolcat#1234 is a tag", "no cue"],
      ["see bug#1234 in the tracker", "no cue"],
      ["discord: coolcat#12345", "five digits"],
      ["discord: coolcat#123", "three digits"],
      ["discord: a#1234", "a single character before the #"],
      [`discord: ${"a".repeat(33)}#1234`, "longer than 32 characters"],
      ["discord: anna@cool#1234", "after an @"],
      ["discord: color #1234", "a space before the #"],
      ["discordant notes: coolcat#1234", "'discord' inside a word"],
      ["discord server: #general", "a channel"],
      ["add me night_owl#7777", "no 'discord' before it"],
      ["my github: see repo#1234", "an issue reference: no 'discord'"],
      [
        `I talked about discord a lot, ${"so ".repeat(16)}coolcat#1234`,
        "'discord' is more than 60 characters before",
      ],
      ["Our discord bot crashed, see issue#1234", "an issue number"],
      ["discord PR#4821 is merged", "a pull request number"],
    ],
    adversarial: {
      "a cue and a long name-like run": length =>
        `discord ${"a".repeat(length - 8)}`,
      "many tags with no cue": length => wholeUnits("coolcat#1234 ", length),
      "dots and underscores before short tags": length =>
        `discord ${repeatTo("._._._#123", length - 8)}`,
      "names too long for a tag": length =>
        `discord ${repeatTo(`${"a".repeat(40)}#1234 `, length - 8)}`,
      "five-digit tags after a cue": length =>
        `discord ${wholeUnits("coolcat#12345 ", length - 8)}`,
    },
  },
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
      // A path is not a password, but homePath finds the account in it.
      "I ran pwd /home/[[USERNAME: anna]]/project and it says permission denied",
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
