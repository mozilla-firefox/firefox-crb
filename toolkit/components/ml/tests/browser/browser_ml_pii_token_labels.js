/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

/// <reference path="head.js" />

/**
 * Tests the moz-pii-token-labels task with a tiny random-weight model that has
 * the PII redactor's architecture, labels and tokenizer format (see
 * data/Mozilla/tiny-pii-redactor/main/README.md). Its labels are meaningless,
 * so these tests check piece offsets and how windows are stitched, not
 * predictions.
 */

const TINY_PII_OPTIONS = {
  taskName: "moz-pii-token-labels",
  modelId: "Mozilla/tiny-pii-redactor",
  tokenizerId: "Mozilla/tiny-pii-redactor",
  modelRevision: "main",
  modelHubUrlTemplate: "{model}/{revision}",
  dtype: "q4",
  // Regular test runs only have a mock of the wasm runtime.
  backend: "onnx-native",
};

const BIO_LABELS = new Set([
  "O",
  ...[
    "PERSON",
    "STREET_ADDRESS",
    "DOB",
    "ID_IN_CONTEXT",
    "SECRET_IN_CONTEXT",
    "USERNAME",
    "ORG",
    "PRODUCT",
    "LOCATION",
    "DATE",
    "PUBLIC_NAME",
  ].flatMap(label => [`B-${label}`, `I-${label}`]),
]);

// Must match PII_WINDOW_PIECES and PII_WINDOW_OVERLAP in ONNXPipeline.mjs.
const WINDOW_PIECES = 254;
const WINDOW_STEP = WINDOW_PIECES - 32;

/**
 * @param {(engine: object) => Promise<void>} run
 */
async function withTinyPiiEngine(run) {
  const { cleanup } = await setup();
  try {
    await run(await createEngine(TINY_PII_OPTIONS));
  } finally {
    await EngineProcess.destroyMLEngine();
    await cleanup();
  }
}

/**
 * @param {object} engine
 * @param {string} text
 * @returns {Promise<Array<{start: number, end: number, label: string}>>}
 */
async function labelPieces(engine, text) {
  const result = await engine.run({ args: [text] });
  return result.output;
}

add_task(async function test_piece_offsets() {
  // Offsets are UTF-16 code units. "▁" pieces that cover no text are dropped,
  // and characters missing from the vocabulary still get their own piece.
  const cases = [
    {
      text: "Call Jürgen Weiß at home",
      spans: [
        [0, 2],
        [2, 4],
        [5, 6],
        [6, 7],
        [7, 8],
        [8, 11],
        [12, 14],
        [14, 15],
        [15, 16],
        [17, 19],
        [20, 22],
        [22, 24],
      ],
    },
    {
      text: "Zażółć gęślą jaźń",
      spans: [
        [0, 2],
        [2, 3],
        [3, 4],
        [4, 5],
        [5, 6],
        [7, 8],
        [8, 9],
        [9, 10],
        [10, 11],
        [11, 12],
        [13, 15],
        [15, 17],
      ],
    },
    {
      text: "Hi 😀 東京",
      spans: [
        [0, 2],
        [3, 5],
        [6, 8],
      ],
    },
    {
      // NFKC turns "ﬁle…" (4 code units) into "file..." (7): its pieces are
      // scaled to fit the original word.
      text: "  the   ﬁle…  ",
      spans: [
        [2, 5],
        [8, 9],
        [9, 10],
        [10, 12],
      ],
    },
  ];

  await withTinyPiiEngine(async engine => {
    for (const { text, spans } of cases) {
      const pieces = await labelPieces(engine, text);
      Assert.deepEqual(
        pieces.map(({ start, end }) => [start, end]),
        spans,
        `Piece offsets for ${JSON.stringify(text)}`
      );
      for (const { label } of pieces) {
        Assert.ok(BIO_LABELS.has(label), `"${label}" is a model label`);
      }
    }
  });
});

add_task(async function test_empty_input() {
  await withTinyPiiEngine(async engine => {
    Assert.deepEqual(await labelPieces(engine, ""), [], "Empty text");
    Assert.deepEqual(await labelPieces(engine, " \n\t "), [], "Only spaces");
  });
});

add_task(async function test_rejects_non_string() {
  await withTinyPiiEngine(async engine => {
    await Assert.rejects(
      engine.run({ args: [42] }),
      /expects a string argument/,
      "A non-string argument is an error, not an empty result"
    );
  });
});

/**
 * "the" is a single piece, so "the ".repeat(n) is n pieces, and every full
 * window of it is the same model input as "the ".repeat(254) on its own. The
 * expected label of each piece is therefore known from two single-window runs:
 * one for a full window and one for the shorter last window. This checks the
 * window starts, the batching (6 windows run as 4 + 2), the padding of the
 * last window and which window wins in each overlap.
 */
add_task(async function test_long_input_windows() {
  const pieceCount = 1200;
  const windowStarts = [];
  for (let start = 0; ; start += WINDOW_STEP) {
    windowStarts.push(start);
    if (start + WINDOW_PIECES >= pieceCount) {
      break;
    }
  }
  const lastLength = pieceCount - windowStarts.at(-1);
  Assert.deepEqual(
    windowStarts,
    [0, 222, 444, 666, 888, 1110],
    "The input spans six windows"
  );

  await withTinyPiiEngine(async engine => {
    const fullWindow = (
      await labelPieces(engine, "the ".repeat(WINDOW_PIECES))
    ).map(piece => piece.label);
    const lastWindow = (
      await labelPieces(engine, "the ".repeat(lastLength))
    ).map(piece => piece.label);
    Assert.equal(fullWindow.length, WINDOW_PIECES, "One piece per word");
    Assert.equal(lastWindow.length, lastLength, "One piece per word");

    const expected = [];
    let disagreements = 0;
    for (let piece = 0; piece < pieceCount; piece++) {
      let best = null;
      const labels = new Set();
      for (const start of windowStarts) {
        const isLast = start === windowStarts.at(-1);
        const length = isLast ? lastLength : WINDOW_PIECES;
        const i = piece - start;
        if (i < 0 || i >= length) {
          continue;
        }
        const label = (isLast ? lastWindow : fullWindow)[i];
        labels.add(label);
        const margin = Math.min(i + 1, length - i);
        if (!best || margin > best.margin) {
          best = { margin, label };
        }
      }
      expected.push(best.label);
      if (labels.size > 1) {
        disagreements++;
      }
    }
    // With random weights the windows could agree on every overlapping piece,
    // and then any choice of window would pass the check below.
    Assert.greater(
      disagreements,
      0,
      `Overlapping windows disagree on ${disagreements} pieces, so the window choice is checked`
    );

    const pieces = await labelPieces(engine, "the ".repeat(pieceCount));
    Assert.deepEqual(
      pieces.map(({ start, end }) => [start, end]),
      Array.from({ length: pieceCount }, (_, i) => [i * 4, i * 4 + 3]),
      "Every word is one piece with its own offsets"
    );
    Assert.deepEqual(
      pieces.map(piece => piece.label),
      expected,
      "Each piece takes the label from the window where it is farthest from an edge"
    );
  });
});
