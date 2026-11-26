/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const PREF_HAS_SEEN_MEMORIES = "browser.smartwindow.memories.hasSeenMemories";

const { AssistantRoleOpts } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/ui/modules/ChatMessage.sys.mjs"
);

function emitAssistantReplyWithMemories(conversation, submitType) {
  conversation.lastSubmitType = submitType;
  const memories = [{ id: "memory-1", memory_summary: "User is vegan" }];
  conversation.addAssistantMessage(
    "text",
    "Hi",
    new AssistantRoleOpts(null, null, null, true, null, memories, [])
  );
  conversation.emit(
    "chat-conversation:message-update",
    conversation.messages.at(-1)
  );
}

describe("memories applied callout", () => {
  let win;
  let conversation;

  beforeEach(async () => {
    await SpecialPowers.pushPrefEnv({
      set: [[PREF_HAS_SEEN_MEMORIES, false]],
    });
    win = await openAIWindow();

    const browser = win.gBrowser.selectedBrowser;
    const aiWindow = await TestUtils.waitForCondition(
      () => browser.contentDocument?.querySelector("ai-window"),
      "Wait for ai-window element"
    );

    conversation = new ChatConversation({});
    conversation.addUserMessage("Pick up where I left off");
    aiWindow.openConversation(conversation);

    const chatBrowser = await getAichatBrowser(browser);
    await SpecialPowers.spawn(chatBrowser, [], async () => {
      await ContentTaskUtils.waitForCondition(
        () => content.document.querySelector("ai-chat-content"),
        "Wait for ai-chat-content so dispatched messages are delivered"
      );
    });
  });

  afterEach(async () => {
    await BrowserTestUtils.closeWindow(win);
    await SpecialPowers.popPrefEnv();
  });

  it("shows on the first reply that applies memories", async () => {
    emitAssistantReplyWithMemories(conversation, "enter");

    await TestUtils.waitForCondition(
      () => Services.prefs.getBoolPref(PREF_HAS_SEEN_MEMORIES),
      "A reply with memories shows the callout and consumes the pref"
    );
  });

  it("skips a resume reply and shows on the next reply", async () => {
    emitAssistantReplyWithMemories(conversation, "resume");
    Assert.ok(
      !Services.prefs.getBoolPref(PREF_HAS_SEEN_MEMORIES),
      "A resume reply with memories does not show or consume the callout"
    );

    conversation.addUserMessage("Tell me more");
    emitAssistantReplyWithMemories(conversation, "follow-up");
    await TestUtils.waitForCondition(
      () => Services.prefs.getBoolPref(PREF_HAS_SEEN_MEMORIES),
      "The next reply with memories shows the callout and consumes the pref"
    );
  });
});
