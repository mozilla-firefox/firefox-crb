/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

// Tests that a page load doesn't replace the address bar value while the user
// is editing it, and that a load into a focused address bar keeps the value
// selected.

"use strict";

const START_URL = "https://example.org/";
const LOADED_URL = "https://example.com/";
const SLOW_URL =
  getRootDirectory(gTestPath).replace(
    "chrome://mochitests/content",
    "https://example.com"
  ) + "slow-page.sjs";

async function loadInContent(browser, url) {
  let loaded = BrowserTestUtils.browserLoaded(browser, false, url);
  await SpecialPowers.spawn(browser, [url], u => {
    content.location.href = u;
  });
  await loaded;
}

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [["browser.urlbar.stickyEdit.featureGate", true]],
  });
});

function isFooterVisible(browser) {
  let footer = gBrowser.getPanel(browser).querySelector("address-footer");
  return !!footer && BrowserTestUtils.isVisible(footer);
}

function assertLocationApplied() {
  Assert.equal(gURLBar.untrimmedValue, LOADED_URL, "The loaded URL is shown");
  Assert.equal(
    gURLBar.getAttribute("pageproxystate"),
    "valid",
    "The page proxy state is valid"
  );
}

add_task(async function focused() {
  await BrowserTestUtils.withNewTab(START_URL, async browser => {
    gURLBar.focus();
    gURLBar.select();

    await loadInContent(browser, LOADED_URL);

    Assert.equal(gURLBar.untrimmedValue, LOADED_URL, "The loaded URL is shown");
    Assert.equal(
      gURLBar.getAttribute("pageproxystate"),
      "valid",
      "The page proxy state is valid"
    );
    Assert.equal(gURLBar.selectionStart, 0, "The value is selected");
    Assert.equal(
      gURLBar.selectionEnd,
      gURLBar.value.length,
      "The value is selected"
    );

    EventUtils.sendString("typed");
    Assert.equal(gURLBar.value, "typed", "Typing replaces the value");
  });
});

add_task(async function typed() {
  await BrowserTestUtils.withNewTab(START_URL, async browser => {
    gURLBar.focus();
    gURLBar.select();
    EventUtils.sendString("typed");

    await loadInContent(browser, LOADED_URL);

    Assert.equal(gURLBar.value, "typed", "The typed value is kept");
    Assert.equal(
      gBrowser.urlbarOverrideValue,
      "typed",
      "The typed value is kept for the tab"
    );
    Assert.ok(gURLBar.focused, "The address bar is still focused");
    Assert.equal(
      gURLBar.getAttribute("pageproxystate"),
      "invalid",
      "The page proxy state is invalid"
    );

    let footer = gBrowser.getPanel(browser).querySelector("address-footer");
    Assert.ok(BrowserTestUtils.isVisible(footer), "The footer is visible");
    Assert.equal(
      footer.uriElement.textContent,
      "example.com",
      "The footer shows the page address"
    );
    Assert.ok(
      BrowserTestUtils.isHidden(footer.menuButtonElement),
      "The split view menu button is hidden"
    );

    gURLBar.blur();
    Assert.ok(BrowserTestUtils.isHidden(footer), "Blurring hides the footer");
    assertLocationApplied();
    Assert.equal(
      gBrowser.urlbarOverrideValue,
      null,
      "The typed value is dropped"
    );
  });
});

add_task(async function notEdited() {
  await BrowserTestUtils.withNewTab(START_URL, async browser => {
    gURLBar.focus();
    await loadInContent(browser, LOADED_URL);
    assertLocationApplied();
    Assert.ok(!isFooterVisible(browser), "The footer is hidden");
  });
});

add_task(async function refocused() {
  await BrowserTestUtils.withNewTab(START_URL, async browser => {
    gURLBar.focus();
    gURLBar.select();
    EventUtils.sendString("typed");
    gURLBar.blur();
    gURLBar.focus();

    await loadInContent(browser, LOADED_URL);

    Assert.equal(gURLBar.value, "typed", "The typed value is kept");
    Assert.ok(isFooterVisible(browser), "The footer is visible");
  });
});

add_task(async function autofilled() {
  await PlacesTestUtils.addVisits({
    uri: LOADED_URL,
    transition: PlacesUtils.history.TRANSITION_TYPED,
  });
  await PlacesFrecencyRecalculator.recalculateAnyOutdatedFrecencies();
  await BrowserTestUtils.withNewTab(START_URL, async browser => {
    gURLBar.focus();
    await UrlbarTestUtils.promiseAutocompleteResultPopup({
      window,
      value: "example.c",
      fireInputEvent: true,
    });
    Assert.equal(gURLBar.value, "example.com/", "The value is autofilled");

    await loadInContent(browser, LOADED_URL);

    Assert.equal(
      gBrowser.urlbarOverrideValue,
      "example.c",
      "The typed value without the autofill is kept for the tab"
    );
    Assert.ok(isFooterVisible(browser), "The footer is visible");
  });
  await PlacesUtils.history.clear();
});

add_task(async function sameDocument() {
  await BrowserTestUtils.withNewTab(START_URL, async browser => {
    gURLBar.focus();
    gURLBar.select();
    EventUtils.sendString("typed");

    let pushedURL = START_URL + "pushed";
    let locationChanged = BrowserTestUtils.waitForLocationChange(
      gBrowser,
      pushedURL
    );
    await SpecialPowers.spawn(browser, [pushedURL], url => {
      content.history.pushState(null, "", url);
    });
    await locationChanged;

    Assert.equal(gURLBar.value, "typed", "The typed value is kept");
    Assert.ok(!isFooterVisible(browser), "The footer is hidden");
  });
});

add_task(async function enterKeyLoad() {
  await BrowserTestUtils.withNewTab(START_URL, async browser => {
    gURLBar.focus();
    gURLBar.select();
    EventUtils.sendString(LOADED_URL);

    // Focus moves to the page only on keyup, so the load commits while the
    // address bar is still focused.
    let loaded = BrowserTestUtils.browserLoaded(browser, false, LOADED_URL);
    EventUtils.synthesizeKey("KEY_Enter", { type: "keydown" });
    await loaded;

    assertLocationApplied();
    Assert.ok(!isFooterVisible(browser), "The footer is hidden");
    EventUtils.synthesizeKey("KEY_Enter", { type: "keyup" });
  });
});

add_task(async function typedThenSwitchedTabs() {
  await BrowserTestUtils.withNewTab(START_URL, async browser => {
    let tab = gBrowser.selectedTab;
    gURLBar.focus();
    gURLBar.select();
    EventUtils.sendString("typed");

    let otherTab = await BrowserTestUtils.openNewForegroundTab(gBrowser);
    gURLBar.focus();
    await BrowserTestUtils.switchTab(gBrowser, tab);
    Assert.equal(gURLBar.value, "typed", "The typed value is restored");
    Assert.ok(gURLBar.focused, "The address bar is focused");
    gURLBar.view.close();

    await loadInContent(browser, LOADED_URL);

    Assert.equal(gURLBar.value, "typed", "The typed value is kept");
    Assert.ok(isFooterVisible(browser), "The footer is visible");
    BrowserTestUtils.removeTab(otherTab);
  });
});

add_task(async function loadedThenSwitchedTabs() {
  await BrowserTestUtils.withNewTab(START_URL, async browser => {
    let tab = gBrowser.selectedTab;
    let otherTab = BrowserTestUtils.addTab(gBrowser, START_URL);
    await BrowserTestUtils.browserLoaded(otherTab.linkedBrowser);
    gURLBar.focus();
    gURLBar.select();
    EventUtils.sendString("typed");
    await loadInContent(browser, LOADED_URL);
    gURLBar.view.close();

    await BrowserTestUtils.switchTab(gBrowser, otherTab);
    Assert.ok(
      !isFooterVisible(otherTab.linkedBrowser),
      "The other tab has no footer"
    );
    await BrowserTestUtils.switchTab(gBrowser, tab);

    Assert.equal(gURLBar.value, "typed", "The typed value is restored");
    Assert.ok(gURLBar.focused, "The address bar is focused");
    Assert.ok(isFooterVisible(browser), "The footer is visible");

    gURLBar.blur();
    Assert.ok(!isFooterVisible(browser), "Blurring hides the footer");
    assertLocationApplied();
    BrowserTestUtils.removeTab(otherTab);
  });
});

add_task(async function typedThenReverted() {
  await BrowserTestUtils.withNewTab(START_URL, async browser => {
    gURLBar.focus();
    gURLBar.select();
    EventUtils.sendString("typed");

    await loadInContent(browser, LOADED_URL);
    gURLBar.handleRevert();

    Assert.equal(
      gURLBar.untrimmedValue,
      LOADED_URL,
      "Reverting shows the loaded URL"
    );
    Assert.equal(
      gURLBar.getAttribute("pageproxystate"),
      "valid",
      "The page proxy state is valid"
    );
  });
});

add_task(async function typedWhileLoadingFromAddressBar() {
  await BrowserTestUtils.withNewTab(START_URL, async browser => {
    let loaded = BrowserTestUtils.browserLoaded(browser, false, SLOW_URL);
    gURLBar.focus();
    gURLBar.value = SLOW_URL;
    EventUtils.synthesizeKey("KEY_Enter");
    await TestUtils.waitForCondition(
      () => !gURLBar.focused,
      "Wait for focus to move to the page"
    );

    gURLBar.focus();
    gURLBar.select();
    EventUtils.sendString("typed");
    await loaded;

    Assert.equal(gURLBar.value, "typed", "The typed value is kept");
    Assert.ok(gURLBar.focused, "The address bar is still focused");
    Assert.ok(isFooterVisible(browser), "The footer is visible");
  });
});

add_task(async function setURIWithoutURI() {
  await BrowserTestUtils.withNewTab(START_URL, async browser => {
    gURLBar.focus();
    gURLBar.select();
    EventUtils.sendString("typed");
    gURLBar.setURI();
    Assert.equal(gURLBar.value, "typed", "The typed value is kept");

    await loadInContent(browser, LOADED_URL);

    Assert.equal(gURLBar.value, "typed", "The typed value is kept");
    Assert.ok(isFooterVisible(browser), "The footer is visible");
  });
});

add_task(async function focusLeftWithResultMenuOpen() {
  await PlacesTestUtils.addVisits("https://example.net/menu");
  await BrowserTestUtils.withNewTab(START_URL, async browser => {
    gURLBar.focus();
    await UrlbarTestUtils.promiseAutocompleteResultPopup({
      window,
      value: "menu",
      fireInputEvent: true,
    });
    await UrlbarTestUtils.openResultMenu(window, { resultIndex: 1 });
    await loadInContent(browser, LOADED_URL);
    Assert.ok(isFooterVisible(browser), "The footer is visible");

    let hidden = BrowserTestUtils.waitForEvent(
      gURLBar.view.resultMenu,
      "hidden"
    );
    gBrowser.selectedBrowser.focus();
    await hidden;

    Assert.ok(!gURLBar.focused, "The address bar isn't focused");
    Assert.ok(!isFooterVisible(browser), "The footer is hidden");
    assertLocationApplied();
  });
  await PlacesUtils.history.clear();
});

add_task(async function searchModeSwitcher() {
  await BrowserTestUtils.withNewTab(START_URL, async browser => {
    gURLBar.focus();
    gURLBar.select();
    EventUtils.sendString("typed");
    await loadInContent(browser, LOADED_URL);

    await UrlbarTestUtils.activateSearchModeSwitcherItem(
      window,
      ".search-button-bookmarks"
    );

    Assert.equal(gURLBar.value, "typed", "The typed value is kept");
    Assert.ok(isFooterVisible(browser), "The footer is visible");
  });
});

add_task(async function emptiedThenSwitchedTabs() {
  await BrowserTestUtils.withNewTab(START_URL, async browser => {
    let tab = gBrowser.selectedTab;
    let otherTab = BrowserTestUtils.addTab(gBrowser, START_URL);
    await BrowserTestUtils.browserLoaded(otherTab.linkedBrowser);
    gURLBar.focus();
    gURLBar.select();
    EventUtils.synthesizeKey("KEY_Backspace");
    await loadInContent(browser, LOADED_URL);
    Assert.ok(isFooterVisible(browser), "The footer is visible");
    gURLBar.view.close();

    await BrowserTestUtils.switchTab(gBrowser, otherTab);
    await BrowserTestUtils.switchTab(gBrowser, tab);

    assertLocationApplied();
    Assert.ok(!isFooterVisible(browser), "The footer is hidden");
    BrowserTestUtils.removeTab(otherTab);
  });
});

add_task(async function programmaticTypedValue() {
  await BrowserTestUtils.withNewTab(START_URL, async browser => {
    gBrowser.urlbarOverrideValue = "programmatic";
    gURLBar.setURI();
    gURLBar.focus();

    await loadInContent(browser, LOADED_URL);

    assertLocationApplied();
    Assert.ok(!isFooterVisible(browser), "The footer is hidden");
  });
});

add_task(async function refocusedAfterEnter() {
  await BrowserTestUtils.withNewTab(START_URL, async browser => {
    let loaded = BrowserTestUtils.browserLoaded(browser, false, SLOW_URL);
    gURLBar.focus();
    gURLBar.select();
    EventUtils.sendString(SLOW_URL);
    EventUtils.synthesizeKey("KEY_Enter");
    await TestUtils.waitForCondition(
      () => !gURLBar.focused,
      "Wait for focus to move to the page"
    );

    gURLBar.focus();
    await loaded;

    Assert.equal(gURLBar.untrimmedValue, SLOW_URL, "The loaded URL is shown");
    Assert.ok(!isFooterVisible(browser), "The footer is hidden");
  });
});

add_task(async function focusMovedToAddressBarButton() {
  await BrowserTestUtils.withNewTab(START_URL, async browser => {
    gURLBar.focus();
    gURLBar.select();
    EventUtils.sendString("typed");
    await loadInContent(browser, LOADED_URL);
    gURLBar.view.close();
    Assert.ok(isFooterVisible(browser), "The footer is visible");

    let button = gURLBar.querySelector(".urlbar-go-button");
    button.setAttribute("tabindex", "-1");
    button.focus();
    Assert.equal(document.activeElement, button, "The button is focused");

    Assert.ok(!isFooterVisible(browser), "The footer is hidden");
    assertLocationApplied();
    button.removeAttribute("tabindex");
  });
});
