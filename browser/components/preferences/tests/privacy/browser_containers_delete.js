/* Any copyright is dedicated to the Public Domain.
 * https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const DELETE_BUTTON = 0;
const CANCEL_BUTTON = 1;

registerCleanupFunction(() => ContextualIdentityService.resetDefault());

async function openContainersPane() {
  await openPreferencesViaOpenPreferencesAPI("containers", { leaveOpen: true });
  let win = gBrowser.contentWindow;
  let control = await settingControlRenders("containers-list", win);
  let boxGroup = control.controlEl;
  await boxGroup.updateComplete;
  return { win, boxGroup, prefsTab: gBrowser.selectedTab };
}

async function clickDelete(win, boxGroup, userContextId) {
  let selector = `moz-box-item[value="${userContextId}"]`;
  await BrowserTestUtils.waitForMutationCondition(
    boxGroup,
    { childList: true, subtree: true, attributes: true },
    () => boxGroup.querySelector(selector)
  );
  let item = boxGroup.querySelector(selector);
  let button = item.querySelector("moz-button[action=remove]");
  button.scrollIntoView();
  EventUtils.synthesizeMouseAtCenter(button, {}, win);
}

async function deleteViaPrompt(
  win,
  boxGroup,
  userContextId,
  buttonNumClick,
  whilePromptOpen
) {
  let promptPromise = PromptTestUtils.waitForPrompt(gBrowser.selectedBrowser, {
    modalType: Services.prompt.MODAL_TYPE_CONTENT,
  });
  await clickDelete(win, boxGroup, userContextId);
  let dialog = await promptPromise;
  let { title, text, defaultButtonNum } = dialog.args;
  await whilePromptOpen?.();
  await PromptTestUtils.handlePrompt(dialog, { buttonNumClick });
  return { title, text, defaultButtonNum };
}

add_task(async function test_cancel_keeps_container() {
  let { userContextId } = ContextualIdentityService.create(
    "Travel",
    "briefcase",
    "blue"
  );
  let { win, boxGroup, prefsTab } = await openContainersPane();

  let { title, text, defaultButtonNum } = await deleteViaPrompt(
    win,
    boxGroup,
    userContextId,
    CANCEL_BUTTON
  );
  is(defaultButtonNum, CANCEL_BUTTON, "Cancel is the default button");
  let [expectedTitle, expectedText] = await win.document.l10n.formatValues([
    { id: "containers-delete-alert-title", args: { name: "Travel" } },
    { id: "containers-delete-alert-msg" },
  ]);
  is(title, expectedTitle, "The prompt names the container");
  is(text, expectedText, "The prompt uses the message without tabs");

  ok(
    ContextualIdentityService.getPublicIdentityFromId(userContextId),
    "Cancelling keeps the container"
  );

  ContextualIdentityService.remove(userContextId);
  BrowserTestUtils.removeTab(prefsTab);
});

add_task(async function test_delete_without_tabs() {
  let { userContextId } = ContextualIdentityService.create(
    "Travel",
    "briefcase",
    "blue"
  );
  let { win, boxGroup, prefsTab } = await openContainersPane();

  let deleted = TestUtils.topicObserved("contextual-identity-deleted");
  await deleteViaPrompt(win, boxGroup, userContextId, DELETE_BUTTON);
  await deleted;

  ok(
    !ContextualIdentityService.getPublicIdentityFromId(userContextId),
    "The container is deleted"
  );

  BrowserTestUtils.removeTab(prefsTab);
});

add_task(async function test_delete_closes_tabs_opened_during_prompt() {
  let { userContextId } = ContextualIdentityService.create(
    "Travel",
    "briefcase",
    "blue"
  );
  let { win, boxGroup, prefsTab } = await openContainersPane();

  let containerTab;
  let deleted = TestUtils.topicObserved("contextual-identity-deleted");
  await deleteViaPrompt(
    win,
    boxGroup,
    userContextId,
    DELETE_BUTTON,
    async () => {
      containerTab = BrowserTestUtils.addTab(gBrowser, "https://example.com/", {
        userContextId,
      });
      await BrowserTestUtils.browserLoaded(containerTab.linkedBrowser);
    }
  );
  await deleted;

  ok(
    !containerTab.isConnected,
    "A tab opened in the container while the prompt was shown is closed"
  );

  BrowserTestUtils.removeTab(prefsTab);
});

add_task(async function test_delete_closes_container_tabs() {
  let { userContextId } = ContextualIdentityService.create(
    "Travel",
    "briefcase",
    "blue"
  );
  let containerTabs = [];
  for (let i = 0; i < 2; i++) {
    let tab = BrowserTestUtils.addTab(gBrowser, "https://example.com/", {
      userContextId,
    });
    await BrowserTestUtils.browserLoaded(tab.linkedBrowser);
    containerTabs.push(tab);
  }
  let { win, boxGroup, prefsTab } = await openContainersPane();

  let deleted = TestUtils.topicObserved("contextual-identity-deleted");
  let { text } = await deleteViaPrompt(
    win,
    boxGroup,
    userContextId,
    DELETE_BUTTON
  );
  await deleted;

  let expectedText = await win.document.l10n.formatValue(
    "containers-delete-alert-msg-with-tabs",
    { tabCount: 2 }
  );
  is(text, expectedText, "The prompt mentions the open tabs");

  ok(
    containerTabs.every(tab => !tab.isConnected),
    "The container tabs are closed"
  );
  is(
    ContextualIdentityService.countContainerTabs(userContextId),
    0,
    "No tabs are left in the container"
  );
  ok(
    !ContextualIdentityService.getPublicIdentityFromId(userContextId),
    "The container is deleted"
  );

  BrowserTestUtils.removeTab(prefsTab);
});
