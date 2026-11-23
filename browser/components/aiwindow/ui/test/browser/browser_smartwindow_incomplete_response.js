/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

/**
 * A reply whose stream ends before the model finished shows the retryable
 * error instead of completing. The mock OpenAI server is used rather than
 * MockEngineManager so the `finish_reason` travels the real wire, pipeline and
 * engine.
 */

const PARTIAL_REPLY = "The first step is";

/**
 * Submits one chat turn against the mock server and waits for its
 * model_response event.
 *
 * @param {string|null} finishReason - Sent with the last streamed chunk.
 * @returns {Promise<object>} The turn's stored reply, rendered messages,
 *   error component strings, completion count and model_response event.
 */
async function runTurn(finishReason) {
  let result;
  await withServer(
    { streamChunks: [PARTIAL_REPLY], finishReason },
    async () => {
      Services.fog.testResetFOG();
      const win = await openAIWindow();
      try {
        const browser = win.gBrowser.selectedBrowser;
        const aiWindow = browser.contentDocument.querySelector("ai-window");
        let completions = 0;
        aiWindow.conversation.on(
          "chat-conversation:message-complete",
          () => completions++
        );

        await typeInSmartbar(browser, "How do I set up my router?");
        await submitSmartbar(browser);

        const [modelResponse] = await TestUtils.waitForCondition(
          () => Glean.smartWindow.modelResponse.testGetValue(),
          "Wait for the model_response event"
        );
        await TestUtils.waitForCondition(
          () => !aiWindow.isGenerating,
          "Wait for the turn to end"
        );

        const expectError = finishReason !== "stop";
        const aichatBrowser = await getAichatBrowser(browser);
        const rendered = await SpecialPowers.spawn(
          aichatBrowser,
          [expectError],
          async waitForError => {
            const contentEl = await ContentTaskUtils.waitForCondition(
              () => content.document.querySelector("ai-chat-content"),
              "Wait for ai-chat-content"
            );
            await contentEl.updateComplete;
            if (waitForError) {
              await ContentTaskUtils.waitForCondition(
                () =>
                  contentEl.shadowRoot.querySelector("chat-assistant-error"),
                "Wait for the error to render"
              );
            }
            const errorEl = contentEl.shadowRoot.querySelector(
              "chat-assistant-error"
            );
            await errorEl?.updateComplete;
            const assistantMessages = () =>
              Array.from(
                contentEl.shadowRoot.querySelectorAll("ai-chat-message"),
                el => el.wrappedJSObject || el
              ).filter(el => el.role === "assistant");
            if (!waitForError) {
              await ContentTaskUtils.waitForCondition(
                () => assistantMessages().some(el => el.complete),
                "Wait for the reply to be marked complete"
              );
            }
            return {
              assistantMessages: assistantMessages().map(el => ({
                text: el.message,
                complete: el.complete,
              })),
              errorHeader: errorEl?.shadowRoot
                ?.querySelector(".chat-assistant-error__header")
                ?.getAttribute("data-l10n-id"),
              errorButton: errorEl?.shadowRoot
                ?.querySelector(".chat-assistant-error__button")
                ?.getAttribute("data-l10n-id"),
            };
          }
        );

        result = {
          storedReply: aiWindow.conversation.messages.findLast(
            m => m.role === MESSAGE_ROLE.ASSISTANT && m.content?.type === "text"
          )?.content.body,
          rendered,
          completions,
          modelResponse,
        };
      } finally {
        await BrowserTestUtils.closeWindow(win);
      }
    }
  );
  return result;
}

add_task(async function test_cut_off_reply_shows_retryable_error() {
  for (const finishReason of ["length", null]) {
    const { storedReply, rendered, completions, modelResponse } =
      await runTurn(finishReason);

    Assert.equal(
      storedReply,
      PARTIAL_REPLY,
      `The partial reply is kept (finish_reason: ${finishReason})`
    );
    const shown = rendered.assistantMessages.find(
      message => message.text === PARTIAL_REPLY
    );
    Assert.ok(shown, "The partial reply stays on screen");
    Assert.ok(!shown.complete, "The partial reply is not shown as complete");
    Assert.equal(completions, 0, "The partial reply is not marked complete");
    Assert.equal(
      rendered.errorHeader,
      "smartwindow-assistant-error-generic-header",
      "The generic error is shown"
    );
    Assert.equal(
      rendered.errorButton,
      "smartwindow-retry-btn",
      "The error offers Retry"
    );
    Assert.equal(
      modelResponse.extra.error,
      "incompleteResponse",
      "model_response records the incomplete reply"
    );
  }
});

add_task(async function test_finished_reply_completes() {
  const { storedReply, rendered, completions, modelResponse } =
    await runTurn("stop");

  Assert.equal(storedReply, PARTIAL_REPLY, "The reply is stored");
  Assert.equal(completions, 1, "The reply is marked complete");
  Assert.ok(
    rendered.assistantMessages.find(message => message.text === PARTIAL_REPLY)
      ?.complete,
    "The reply is shown as complete"
  );
  Assert.equal(rendered.errorHeader, undefined, "No error is shown");
  Assert.ok(
    !modelResponse.extra.error,
    "model_response records no error for a finished reply"
  );
});
