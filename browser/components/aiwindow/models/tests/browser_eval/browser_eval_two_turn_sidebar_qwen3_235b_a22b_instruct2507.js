/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

requestLongerTimeout(5);

const evalMetadata = {
  owner: "Smart Window",
  name: "Smart Window Two-Turn Sidebar Eval - qwen3-235b-a22b-instruct-2507",
  description:
    "Submits two related prompts through the Smart Window sidebar about the current page, using MLPA via qwen3-235b-a22b-instruct-2507, and uses LLMaaJ to evaluate the conversation.",
  test: "mochitest",
  options: {
    default: {
      manifest: "eval.toml",
      manifest_flavor: "browser-chrome",
      evaluations: {
        LlmJudge: { shouldAlert: false },
      },
      perfherder: true,
    },
  },
};

ChromeUtils.defineESModuleGetters(this, {
  AIWindow:
    "moz-src:///browser/components/aiwindow/ui/modules/AIWindow.sys.mjs",
  AIWindowUI:
    "moz-src:///browser/components/aiwindow/ui/modules/AIWindowUI.sys.mjs",
  AIWindowTestUtils: "resource://testing-common/AIWindowTestUtils.sys.mjs",
  AuthProvider:
    "moz-src:///browser/components/aiwindow/models/AuthProvider.sys.mjs",
  MLTestUtils: "resource://testing-common/MLTestUtils.sys.mjs",
  sinon: "resource://testing-common/Sinon.sys.mjs",
});

const { getMlpaStageConfig } = ChromeUtils.importESModule(
  "chrome://mochitests/content/browser/browser/components/aiwindow/models/tests/browser_eval/tests/mlpa_stage.sys.mjs"
);
const {
  basicQualityEvalPrompt,
  basicQualityEvalResponseFormat,
  basicQualityEvalConfig,
} = ChromeUtils.importESModule(
  "chrome://mochitests/content/browser/browser/components/aiwindow/models/tests/browser_eval/prompts/basic_quality.sys.mjs"
);

AIWindowTestUtils.init(this, window);

const MODEL = "qwen3-235b-a22b-instruct-2507-maas";
const PAGE_URL =
  "https://example.com/browser/browser/components/aiwindow/models/tests/browser_eval/pages/mylocalweather.html";
const TURNS = [
  "What's the weather like today?",
  "Do I need an umbrella tomorrow?",
];
const RESPONSE_TIMEOUT_TRIES = 180;

async function openSidebarOnPage(win, url) {
  const tabBrowser = win.gBrowser.selectedBrowser;
  const loaded = BrowserTestUtils.browserLoaded(tabBrowser, {
    wantLoad: url,
  });
  BrowserTestUtils.startLoadingURIString(tabBrowser, url);
  await loaded;

  if (!AIWindowUI.isSidebarOpen(win)) {
    AIWindowUI.toggleSidebar(win);
  }
  const sidebarBrowser = win.document.getElementById("ai-window-browser");
  await TestUtils.waitForCondition(
    () =>
      sidebarBrowser.contentDocument &&
      sidebarBrowser.contentDocument.querySelector("ai-window:defined"),
    "Wait for the sidebar ai-window to load"
  );
  return sidebarBrowser;
}

async function submitChatTurn(sidebarBrowser, prompt, turnNumber) {
  info(`Turn ${turnNumber}: ${prompt}`);
  await AIWindowTestUtils.typeInSmartbar(sidebarBrowser, prompt);
  await AIWindowTestUtils.selectExplicitSmartbarAction(sidebarBrowser, "chat");
  await AIWindowTestUtils.waitForSmartbarAction(sidebarBrowser, "chat");
  await AIWindowTestUtils.submitSmartbar(sidebarBrowser);
  await TestUtils.waitForCondition(
    () =>
      (Glean.smartWindow.modelResponse.testGetValue() || []).length >=
      turnNumber,
    `Wait for the turn ${turnNumber} model response`,
    1000,
    RESPONSE_TIMEOUT_TRIES
  );
}

add_task(async function test_two_turn_sidebar_qwen3_235b_a22b_instruct2507() {
  const { fxaToken: token, prefs: mlpaStagePrefs } = getMlpaStageConfig();

  const restoreRemoteSettings = await stubRemoteSettings();
  await SpecialPowers.pushPrefEnv({
    set: [
      ["browser.smartwindow.enabled", true],
      ["browser.smartwindow.firstrun.hasCompleted", true],
      ...mlpaStagePrefs,
      ["browser.smartwindow.model", MODEL],
      ["sidebar.notification.badge.aichat", false],
      ["browser.newtab.preload", false],
      ["browser.search.suggest.enabled", false],
      ["browser.urlbar.suggest.searches", false],
    ],
    clear: [
      "nimbus.migrations.after-remote-settings-update",
      "browser.ml.chat.onboarding.config",
      "browser.ml.chat.nimbus",
    ],
  });

  const sb = sinon.createSandbox();
  sb.stub(AuthProvider, "getToken").resolves(token);
  sb.stub(AuthProvider, "maybeSignIn").resolves(true);
  Services.fog.testResetFOG();

  let win;
  registerCleanupFunction(async () => {
    if (win) {
      await BrowserTestUtils.closeWindow(win);
    }
    sb.restore();
    await SpecialPowers.popPrefEnv();
    await restoreRemoteSettings();
  });

  win = await AIWindowTestUtils.openReadyAIWindow();
  const sidebarBrowser = await openSidebarOnPage(win, PAGE_URL);

  for (const [index, prompt] of TURNS.entries()) {
    await submitChatTurn(sidebarBrowser, prompt, index + 1);
  }

  for (const response of Glean.smartWindow.modelResponse.testGetValue()) {
    Assert.equal(response.extra.error, "", "Model response has no error");
  }

  const chatIds = new Set(
    Glean.smartWindow.chatSubmit.testGetValue().map(e => e.extra.chat_id)
  );
  Assert.equal(chatIds.size, 1, "Both turns share the same chat_id");
  const [chatId] = chatIds;

  let messages;
  await TestUtils.waitForCondition(async () => {
    const conversation = await AIWindow.chatStore.findConversationById(chatId);
    messages = conversation
      ? conversation.getMessagesInChatCompletionsFormat()
      : [];
    return (
      messages.filter(msg => msg.role === "assistant" && msg.content).length >=
      TURNS.length
    );
  }, "Wait for both assistant responses to be stored");

  const finalAssistant = messages.findLast(msg => msg.role === "assistant");
  const finalResponse = (finalAssistant && finalAssistant.content) || "";
  const toolCalls = messages
    .filter(msg => msg.tool_calls)
    .flatMap(msg => msg.tool_calls);

  MLTestUtils.reportEvalData({
    messages: renderPrompt(basicQualityEvalPrompt, {
      model_response: finalResponse,
      model_tool_calls: JSON.stringify(toolCalls, null, 2),
      conversation_history: JSON.stringify(messages, null, 2),
      query: TURNS.at(-1),
      current_url: PAGE_URL,
    }),
    response_format: basicQualityEvalResponseFormat,
    eval_config: basicQualityEvalConfig,
  });
});
