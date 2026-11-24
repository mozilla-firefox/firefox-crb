/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

/** @type {import("../MLTestUtils.sys.mjs")} */
const { MLTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/MLTestUtils.sys.mjs"
);

add_task(async function test_mock_llm_engine_run() {
  const engine = new MLTestUtils.MockLLMEngine();

  const resultPromise = engine.run({
    args: [
      { role: "system", content: "You are a test assistant." },
      { role: "user", content: "What is up?" },
    ],
  });

  const [requestId] = engine.getNextRequest();
  engine.respond(requestId, "Hello there.");

  const { finalOutput } = await resultPromise;

  Assert.equal(finalOutput, "Hello there.");
  Assert.equal(engine.runRequests.size, 0, "No run requests remain.");
});

add_task(async function test_mock_llm_engine_wait_for_run_request() {
  const engine = new MLTestUtils.MockLLMEngine();
  const requestAvailable = engine.waitForRunRequest();

  const resultPromise = engine.run({ args: [] });
  await requestAvailable;

  const [requestId] = engine.getNextRequest();
  engine.respond(requestId, "Done.");
  await resultPromise;
});

add_task(async function test_mock_llm_engine_run_with_generator() {
  const engine = new MLTestUtils.MockLLMEngine();

  const fullText = MLTestUtils.gatherText(
    engine.runWithGenerator({
      args: [
        { role: "system", content: "You are a test assistant." },
        { role: "user", content: "What is up?" },
      ],
    })
  );

  const [requestId] = engine.getNextRequest();

  engine.respond(requestId, "Hello there.");

  Assert.equal(await fullText, "Hello there.");
  Assert.equal(engine.runRequests.size, 0, "No run requests remain.");
});

add_task(async function test_mock_llm_engine_with_tool_calls() {
  const engine = new MLTestUtils.MockLLMEngine();

  const generator = engine.runWithGenerator({
    args: [
      { role: "system", content: "You have access to tools." },
      { role: "user", content: "Search for news" },
    ],
  });

  const chunksPromise = MLTestUtils.gatherChunks(generator);
  const [requestId] = engine.getNextRequest();

  engine.respond(requestId, [
    {
      text: "",
      tokens: null,
      isPrompt: false,
      toolCalls: [
        {
          id: "call_1",
          function: {
            name: "search_news",
            arguments: ["Firefox", "2026"],
          },
        },
      ],
    },
  ]);

  const chunks = await chunksPromise;

  Assert.equal(chunks.length, 1, "Should have one chunk");
  Assert.equal(chunks[0].toolCalls.length, 1, "Should have one tool call");
  Assert.equal(chunks[0].toolCalls[0].id, "call_1");
  Assert.equal(chunks[0].toolCalls[0].function.name, "search_news");
  Assert.deepEqual(chunks[0].toolCalls[0].function.arguments, [
    "Firefox",
    "2026",
  ]);
});

add_task(async function test_mock_llm_engine_openai_finish_reason() {
  const usage = { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 };
  const cases = [
    {
      response: [{ text: "Hi.", usage }],
      expected: { finishReason: "stop", usage },
    },
    {
      response: [{ text: "", toolCalls: [{ id: "call_1", function: {} }] }],
      expected: { finishReason: "tool_calls" },
    },
  ];
  for (const { response, expected } of cases) {
    const engine = new MLTestUtils.MockLLMEngine({ backend: "openai" });
    const chunksPromise = MLTestUtils.gatherChunks(
      engine.runWithGenerator({ args: [] })
    );
    const [requestId] = engine.getNextRequest();
    engine.respond(requestId, response);
    const chunks = await chunksPromise;

    Assert.equal(
      chunks.length,
      response.length + 1,
      "The OpenAI backend ends the stream with a final chunk"
    );
    Assert.equal(chunks.at(-1).finishReason, expected.finishReason);
    Assert.deepEqual(
      chunks.at(-1).usage,
      expected.usage,
      "The final chunk carries the last usage"
    );
  }

  const cutOff = new MLTestUtils.MockLLMEngine({ backend: "openai" });
  const cutOffChunks = MLTestUtils.gatherChunks(
    cutOff.runWithGenerator({ args: [] })
  );
  const [cutOffId] = cutOff.getNextRequest();
  cutOff.respond(cutOffId, [{ text: "Hi", finishReason: null }]);
  Assert.equal(
    (await cutOffChunks).length,
    1,
    "A mocked finishReason replaces the final chunk"
  );
});

add_task(async function test_mock_llm_engine_with_chunked_tool_calls() {
  const engine = new MLTestUtils.MockLLMEngine();

  const chunks = [];
  const generator = engine.runWithGenerator({
    args: [
      { role: "system", content: "You have access to tools." },
      { role: "user", content: "Get the weather" },
    ],
  });

  const collectionPromise = (async () => {
    for await (const chunk of generator) {
      chunks.push(chunk);
    }
  })();

  const [requestId] = engine.getNextRequest();

  engine.respond(requestId, [
    {
      text: "",
      tokens: null,
      isPrompt: false,
      toolCalls: [
        {
          id: "call_1",
          function: {
            name: "get_wea",
            arguments: ["San"],
          },
        },
      ],
    },
    {
      text: "",
      tokens: null,
      isPrompt: false,
      toolCalls: [
        {
          id: "call_1",
          function: {
            name: "get_weather",
            arguments: ["San Francisco"],
          },
        },
      ],
    },
  ]);

  await collectionPromise;

  Assert.equal(chunks.length, 2, "Should have two chunks");
  Assert.equal(
    chunks[1].toolCalls[0].function.name,
    "get_weather",
    "Final chunk should have complete function name"
  );
  Assert.deepEqual(
    chunks[1].toolCalls[0].function.arguments,
    ["San Francisco"],
    "Final chunk should have complete arguments"
  );
});
