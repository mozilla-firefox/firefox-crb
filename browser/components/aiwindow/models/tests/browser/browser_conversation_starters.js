/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { generateConversationStartersSidebar } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/models/ConversationSuggestions.sys.mjs"
);
const { PURPOSES } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/models/Utils.sys.mjs"
);
const { MockEngineManager } = ChromeUtils.importESModule(
  "resource://testing-common/AIWindowTestUtils.sys.mjs"
);

const TABS = [{ url: "https://example.com", title: "Example Domain" }];
const RETRY_AFTER_SECONDS = 60;
const BLOCKED_UNTIL_PREF =
  "browser.smartwindow.conversationStarters.blockedUntil";

function rateLimited(retryAfter) {
  return Object.assign(new Error("429"), { status: 429, retryAfter });
}

add_task(async function test_convo_starter_generation_with_mock_server() {
  const { server, port } = startMockOpenAI({
    streamChunks: ["suggestion 1\nsuggestion 2"],
  });
  await SpecialPowers.pushPrefEnv({
    set: [["browser.smartwindow.endpoint", `http://localhost:${port}/v1`]],
  });

  try {
    const tabs = [
      {
        url: "https://example.com",
        title: "Example Domain",
      },
    ];
    const generated = await generateConversationStartersSidebar(tabs, 2, true);
    Assert.deepEqual(
      generated,
      [
        { text: "suggestion 1", type: "chat" },
        { text: "suggestion 2", type: "chat" },
      ],
      "Should return two suggestions"
    );
  } finally {
    await SpecialPowers.popPrefEnv();
    await stopMockOpenAI(server);
  }
});

add_task(async function test_starters_wait_for_retry_after() {
  const mockEngineManager = new MockEngineManager();
  try {
    await SpecialPowers.pushPrefEnv({ clear: [[BLOCKED_UNTIL_PREF]] });
    const controller = new AbortController();
    const aborted = generateConversationStartersSidebar(
      TABS,
      2,
      false,
      null,
      controller.signal
    );
    const { reject } = await mockEngineManager.captureRequest({
      purpose: PURPOSES.CONVERSATION_STARTERS_SIDEBAR,
    });
    // The request still reaches the service.
    controller.abort();
    Assert.deepEqual(await aborted, [], "The aborted call has no starters");
    const blocked = TestUtils.waitForPrefChange(BLOCKED_UNTIL_PREF);
    const rejectedAt = Date.now();
    reject(rateLimited(String(RETRY_AFTER_SECONDS)));
    await blocked;
    const blockedUntil = Services.prefs.getStringPref(BLOCKED_UNTIL_PREF);
    Assert.ok(
      Number(blockedUntil) >= rejectedAt + RETRY_AFTER_SECONDS * 1000 &&
        Number(blockedUntil) <= Date.now() + RETRY_AFTER_SECONDS * 1000,
      "Starters are blocked for Retry-After"
    );
    Assert.equal(
      openAIEngine._createEngine.lastCall.args[0].maxRetries,
      0,
      "The client doesn't retry the request itself"
    );

    const engineCount = openAIEngine._createEngine.callCount;
    Assert.deepEqual(
      await generateConversationStartersSidebar(TABS, 2),
      [],
      "Blocked starters have no results"
    );
    Assert.equal(
      openAIEngine._createEngine.callCount,
      engineCount,
      "No request is sent within Retry-After"
    );

    await SpecialPowers.pushPrefEnv({
      set: [
        ["browser.smartwindow.firstrun.modelChoice", "0"],
        ["browser.smartwindow.customEndpoint", "http://localhost:0/v1"],
      ],
    });
    const custom = generateConversationStartersSidebar(TABS, 2);
    const { reject: rejectCustom } = await mockEngineManager.captureRequest({
      purpose: PURPOSES.CONVERSATION_STARTERS_SIDEBAR,
    });
    rejectCustom(rateLimited(String(2 * RETRY_AFTER_SECONDS)));
    await custom;
    Assert.equal(
      Services.prefs.getStringPref(BLOCKED_UNTIL_PREF),
      blockedUntil,
      "A custom endpoint’s 429 doesn’t block MLPA"
    );
    await SpecialPowers.popPrefEnv();

    Services.prefs.setStringPref(BLOCKED_UNTIL_PREF, String(Date.now() - 1));
    const retried = generateConversationStartersSidebar(TABS, 2);
    await mockEngineManager.respondTo({
      purpose: PURPOSES.CONVERSATION_STARTERS_SIDEBAR,
      response: "suggestion 1\nsuggestion 2",
    });
    Assert.deepEqual(
      await retried,
      [
        { text: "suggestion 1", type: "chat" },
        { text: "suggestion 2", type: "chat" },
      ],
      "Starters are requested again after Retry-After"
    );
  } finally {
    await mockEngineManager.rejectAllRequests();
    mockEngineManager.cleanupMocks();
    await SpecialPowers.popPrefEnv();
  }
});
