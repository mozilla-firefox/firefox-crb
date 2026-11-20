/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

/**
 * Tests the PII rules through detectRules, and how overlapping spans are
 * settled.
 */

const { detectRules, resolveOverlaps, EVIDENCE, RULES } =
  ChromeUtils.importESModule(
    "chrome://global/content/ml/pii/rules/PIIRules.sys.mjs"
  );
const { RULE_CASES } = ChromeUtils.importESModule(
  "chrome://mochitests/content/browser/toolkit/components/ml/tests/browser/data/pii/rule_cases.sys.mjs"
);

// Text lengths to time the rules at. The longest the redactor accepts in one
// call is not decided yet.
const LENGTHS = [2000, 10000, 32000];

const MARKER = new RegExp(
  [
    "\\[\\[",
    // An optional type such as "PHONE: ".
    "(?:(?<type>[A-Z_]+): )?",
    // The expected value, up to the first closing brackets.
    "(?<value>.+?)",
    "\\]\\]",
  ].join(""),
  "g"
);

/**
 * Reads the "[[value]]" and "[[TYPE: value]]" markers out of a fixture.
 *
 * @param {string} marked
 * @param {string} type - The type of a marker that names none.
 * @returns {{text: string, spans: {start: number, end: number, type: string}[]}}
 *   The text without markers, and the marked spans in it.
 */
function parseMarked(marked, type) {
  let text = "";
  const spans = [];
  let last = 0;
  for (const match of marked.matchAll(MARKER)) {
    text += marked.slice(last, match.index);
    const start = text.length;
    text += match.groups.value;
    spans.push({ start, end: text.length, type: match.groups.type ?? type });
    last = match.index + match[0].length;
  }
  return { text: text + marked.slice(last), spans };
}

/**
 * @param {number} start
 * @param {number} end
 * @param {string} type
 * @param {number} evidence
 */
function span(start, end, type, evidence) {
  return { start, end, type, evidence };
}

/**
 * @param {string} extent - Where the span sits: a space for each offset
 *   before it, then its name for each offset it covers. "    bbbb" is "b"
 *   from offset 4 to 8.
 * @param {number} evidence
 */
function spanFrom(extent, evidence) {
  const start = extent.search(/\S/);
  return span(start, extent.length, extent[start], evidence);
}

add_task(function test_span_from() {
  const { FORMAT, CHECKSUM } = EVIDENCE;
  const cases = [
    { extent: "aaaa", evidence: FORMAT, expected: span(0, 4, "a", FORMAT) },
    {
      extent: "    bbbb",
      evidence: CHECKSUM,
      expected: span(4, 8, "b", CHECKSUM),
    },
    {
      extent: "         c",
      evidence: FORMAT,
      expected: span(9, 10, "c", FORMAT),
    },
  ];
  for (const { extent, evidence, expected } of cases) {
    Assert.deepEqual(
      spanFrom(extent, evidence),
      expected,
      JSON.stringify(extent)
    );
  }
});

add_task(function test_parse_marked() {
  const cases = [
    { marked: "no marker", text: "no marker", spans: [] },
    {
      marked: "iban [[DE89]] thanks",
      text: "iban DE89 thanks",
      spans: [{ start: 5, end: 9, type: "IBAN" }],
    },
    {
      marked: "call [[PHONE: +49 170]] or [[DE89]]",
      text: "call +49 170 or DE89",
      spans: [
        { start: 5, end: 12, type: "PHONE" },
        { start: 16, end: 20, type: "IBAN" },
      ],
    },
    {
      marked: "😀 [[DE89]]",
      text: "😀 DE89",
      spans: [{ start: 3, end: 7, type: "IBAN" }],
    },
  ];
  for (const { marked, text, spans } of cases) {
    Assert.deepEqual(parseMarked(marked, "IBAN"), { text, spans }, marked);
  }
});

add_task(function test_resolve_overlaps() {
  const { FORMAT, CHECKSUM } = EVIDENCE;
  const cases = [
    {
      name: "nothing in, nothing out",
      candidates: [],
      expected: [],
    },
    {
      name: "separate spans are all kept, sorted by start",
      candidates: [
        ["          bbbb", FORMAT],
        ["aaaa", FORMAT],
      ],
      expected: [
        ["aaaa", FORMAT],
        ["          bbbb", FORMAT],
      ],
    },
    {
      name: "touching spans do not overlap",
      candidates: [
        ["aaaa", FORMAT],
        ["    bbbb", FORMAT],
      ],
      expected: [
        ["aaaa", FORMAT],
        ["    bbbb", FORMAT],
      ],
    },
    {
      name: "stronger evidence wins, even when shorter",
      candidates: [
        ["aaaaaaaaaaaaaaaaaaaa", FORMAT],
        ["    bbbb", CHECKSUM],
      ],
      expected: [["    bbbb", CHECKSUM]],
    },
    {
      name: "same evidence: the longer span wins",
      candidates: [
        ["    aaaa", FORMAT],
        ["bbbbbbbbbb", FORMAT],
      ],
      expected: [["bbbbbbbbbb", FORMAT]],
    },
    {
      name: "same evidence and length: the earlier span wins",
      candidates: [
        ["  bbbb", FORMAT],
        ["aaaa", FORMAT],
      ],
      expected: [["aaaa", FORMAT]],
    },
    {
      name: "a weak span bridging two strong ones is dropped",
      candidates: [
        ["aaaa", CHECKSUM],
        ["   bbbbbb", FORMAT],
        ["        cccc", CHECKSUM],
      ],
      expected: [
        ["aaaa", CHECKSUM],
        ["        cccc", CHECKSUM],
      ],
    },
    {
      name: "a dropped span does not block its other neighbor",
      candidates: [
        ["aaaaaa", CHECKSUM],
        ["    bbbbbb", FORMAT],
        ["        cccc", FORMAT],
      ],
      expected: [
        ["aaaaaa", CHECKSUM],
        ["        cccc", FORMAT],
      ],
    },
  ];
  for (const { name, candidates, expected } of cases) {
    Assert.deepEqual(
      resolveOverlaps(candidates.map(item => spanFrom(...item))),
      expected.map(item => spanFrom(...item)),
      name
    );
  }

  // An empty span has no character to draw, so it is written with offsets.
  Assert.deepEqual(
    resolveOverlaps([
      span(5, 5, "a", CHECKSUM),
      spanFrom("bbbbbbbbbb", FORMAT),
    ]),
    [spanFrom("bbbbbbbbbb", FORMAT)],
    "an empty span is dropped"
  );
});

add_task(function test_empty_and_invalid_input() {
  Assert.deepEqual(detectRules(""), [], "Empty text");
  Assert.deepEqual(detectRules(" \n\t "), [], "Only spaces");
  Assert.throws(
    () => detectRules(42),
    /expects a string/,
    "A non-string is an error, not an empty result"
  );
});

add_task(function test_finds() {
  for (const [name, cases] of Object.entries(RULE_CASES)) {
    for (const marked of cases.finds) {
      const { text, spans } = parseMarked(marked, cases.type);
      const found = detectRules(text).map(({ start, end, type }) => ({
        start,
        end,
        type,
      }));
      Assert.deepEqual(found, spans, `${name} finds ${marked}`);
    }
  }
});

add_task(function test_ignores() {
  for (const [name, cases] of Object.entries(RULE_CASES)) {
    for (const [text, reason] of cases.ignores) {
      Assert.deepEqual(
        detectRules(text),
        [],
        `${name} ignores ${JSON.stringify(text)}: ${reason}`
      );
    }
  }
});

/**
 * Inputs built to make backtracking patterns slow, at each length the
 * redactor may be given. The timings are logged for each rule's commit
 * message and for triage.
 */
add_task(function test_adversarial_inputs() {
  for (const length of LENGTHS) {
    for (const [name, cases] of Object.entries(RULE_CASES)) {
      for (const [input, build] of Object.entries(cases.adversarial)) {
        const text = build(length);
        const start = ChromeUtils.now();
        const spans = detectRules(text);
        const ms = (ChromeUtils.now() - start).toFixed(2);
        info(`${name}, ${input}, ${text.length} characters: ${ms} ms`);
        Assert.deepEqual(spans, [], `${name} finds nothing in ${input}`);
      }
    }
  }
});

/**
 * Logs how long the rules take on ordinary chat text that contains each
 * rule's finds, at each length, for each rule's commit message. It only runs
 * locally: it asserts nothing, and timing in CI belongs in a perftest.
 */
add_task(
  { skip_if: () => !!Services.env.get("MOZ_AUTOMATION") },
  function test_log_chat_timings() {
    const prose =
      "Hi! I'm planning a trip with a friend next month and need help with " +
      "the budget, a packing list and where to stay. ";
    const runs = 10;
    for (const [name, cases] of Object.entries(RULE_CASES)) {
      const finds = cases.finds.map(marked => parseMarked(marked).text);
      const unit = `${prose}${finds.join(" ")} `;
      for (const length of LENGTHS) {
        const text = unit
          .repeat(Math.ceil(length / unit.length))
          .slice(0, length);
        const times = [];
        for (let i = 0; i < runs; i++) {
          const start = ChromeUtils.now();
          detectRules(text);
          times.push(ChromeUtils.now() - start);
        }
        times.sort((a, b) => a - b);
        const median = times[runs >> 1].toFixed(2);
        info(`${name}, chat text, ${length} characters: median ${median} ms`);
      }
    }
    Assert.ok(true, "Chat timings are logged, not asserted");
  }
);

add_task(function test_every_rule_has_enough_cases() {
  Assert.deepEqual(
    Object.keys(RULE_CASES).sort(),
    RULES.map(rule => rule.name).sort(),
    "Every rule has one block of test cases, and every block a rule"
  );
  for (const rule of RULES) {
    const cases = RULE_CASES[rule.name];
    Assert.equal(cases?.type, rule.type, `${rule.name} cases test its type`);
    Assert.greaterOrEqual(cases?.finds.length ?? 0, 10, `${rule.name} finds`);
    Assert.greaterOrEqual(
      cases?.ignores.length ?? 0,
      10,
      `${rule.name} ignores`
    );
  }
});
