/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { PromptTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/PromptTestUtils.sys.mjs"
);

const AUTH_URL =
  getRootDirectory(gTestPath).replace(
    "chrome://mochitests/content",
    "https://example.org"
  ) + "auth-route.sjs";

const COMMON_DIALOG_MIN_EM = 29;

async function checkDialogWidth(dialog, name) {
  let dialogWin = dialog.ui.prompt;
  let frame = dialogWin.frameElement;
  await frame._dialogReady;
  let root = dialogWin.document.documentElement;
  let frameWidth = frame.getBoundingClientRect().width;
  let rootWidth = root.getBoundingClientRect().width;
  let minWidth =
    parseFloat(dialogWin.getComputedStyle(root).fontSize) *
    COMMON_DIALOG_MIN_EM;

  Assert.equal(
    rootWidth,
    frameWidth,
    `${name}: the dialog document fills its frame`
  );
  Assert.greaterOrEqual(
    frameWidth,
    minWidth,
    `${name}: the dialog frame is at least ${COMMON_DIALOG_MIN_EM}em wide`
  );
}

add_task(async function test_http_auth_prompt_width() {
  SimpleTest.registerCurrentTaskCleanupFunction(
    () =>
      new Promise(resolve =>
        Services.clearData.deleteData(
          Ci.nsIClearDataService.CLEAR_AUTH_CACHE,
          resolve
        )
      )
  );

  await BrowserTestUtils.withNewTab("about:blank", async browser => {
    let promptPromise = PromptTestUtils.waitForPrompt(browser, {
      modalType: Services.prompt.MODAL_TYPE_TAB,
      promptType: "promptUserAndPass",
    });
    BrowserTestUtils.startLoadingURIString(browser, AUTH_URL);
    let dialog = await promptPromise;

    await checkDialogWidth(dialog, "HTTP auth prompt");

    await PromptTestUtils.handlePrompt(dialog, { buttonNumClick: 1 });
  });
});

add_task(async function test_content_alert_width() {
  await BrowserTestUtils.withNewTab("https://example.com", async browser => {
    let promptPromise = PromptTestUtils.waitForPrompt(browser, {
      modalType: Services.prompt.MODAL_TYPE_CONTENT,
      promptType: "alert",
    });
    let alertDone = SpecialPowers.spawn(browser, [], () =>
      content.eval("alert('Test')")
    );
    let dialog = await promptPromise;

    await checkDialogWidth(dialog, "content alert");

    await PromptTestUtils.handlePrompt(dialog);
    await alertDone;
  });
});
