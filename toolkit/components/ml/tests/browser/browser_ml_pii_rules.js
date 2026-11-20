/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

/**
 * Tests the PII rules through detectRules, and how overlapping spans are
 * settled.
 */

const { detectRules, resolveOverlaps, EVIDENCE } = ChromeUtils.importESModule(
  "chrome://global/content/ml/pii/rules/PIIRules.sys.mjs"
);

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
