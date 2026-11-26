/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

/**
 * Ensures that hovering and pressing toolbar and sidebar buttons only animates
 * properties that don't need a reflow.
 */

const ICON = "chrome://browser/skin/forward.svg";

add_setup(async function () {
  await gBrowserInit.idleTasksFinished.promise;
  await SpecialPowers.pushPrefEnv({
    set: [
      ["ui.prefersReducedMotion", 0],
      ["ui.tooltip.delay_ms", 100000],
    ],
  });
});

function createToolbarButton(badged) {
  let button = document.createXULElement("toolbarbutton");
  button.id = "test-reflow-button";
  button.className = "toolbarbutton-1 chromeclass-toolbar-additional";
  button.setAttribute("label", "Test");
  button.style.listStyleImage = `url(${ICON})`;
  if (badged) {
    button.setAttribute("badged", "true");
  }
  document.getElementById("nav-bar-customization-target").append(button);
  registerCleanupFunction(() => button.remove());
  return button;
}

function waitForFrames() {
  return new Promise(resolve =>
    requestAnimationFrame(() => requestAnimationFrame(resolve))
  );
}

/**
 * Waits for the transitions running on some elements to finish.
 *
 * @param {Element[]} elements
 * @returns {Promise<number>} The number of transitions waited for.
 */
async function waitForTransitions(elements) {
  for (let element of elements) {
    getComputedStyle(element).scale;
  }
  let animations = elements.flatMap(element =>
    element.getAnimations({ subtree: true })
  );
  await Promise.all(animations.map(a => a.finished));
  return animations.length;
}

/**
 * Counts the reflows of the browser window while the mouse hovers, presses,
 * releases and leaves a button. Unrelated work elsewhere in the window can
 * reflow during a run, so this retries and returns the lowest count; a button
 * whose own transitions reflow does so on every run.
 *
 * @param {Element} button The element to hover and press.
 * @param {Element} icon The visible icon, which should shrink while pressed.
 * @param {Element[]} transitioned The elements whose subtree transitions to
 *   wait for.
 * @returns {Promise<number>}
 */
async function countReflowsDuringPress(button, icon, transitioned) {
  let fewest = Infinity;
  for (let attempt = 0; attempt < 3 && fewest > 0; attempt++) {
    let reflows = await countReflowsDuringOnePress(button, icon, transitioned);
    if (reflows) {
      info(`Saw ${reflows} reflows on attempt ${attempt + 1}`);
    }
    fewest = Math.min(fewest, reflows);
  }
  return fewest;
}

async function countReflowsDuringOnePress(button, icon, transitioned) {
  let buttonRect = button.getBoundingClientRect();
  let x = buttonRect.left + buttonRect.width / 2;
  let y = buttonRect.top + buttonRect.height / 2;
  let urlbarRect = gURLBar.getBoundingClientRect();
  let outsideX = urlbarRect.left + 10;
  let outsideY = urlbarRect.top + urlbarRect.height / 2;

  EventUtils.synthesizeMouseAtPoint(outsideX, outsideY, { type: "mousemove" });
  await waitForTransitions(transitioned);
  await window.promiseDocumentFlushed(() => {});

  let reflows = 0;
  let observer = {
    reflow: () => reflows++,
    reflowInterruptible: () => reflows++,
    QueryInterface: ChromeUtils.generateQI([
      "nsIReflowObserver",
      "nsISupportsWeakReference",
    ]),
  };
  window.docShell.addWeakReflowObserver(observer);
  try {
    EventUtils.synthesizeMouseAtPoint(x, y, { type: "mousemove" });
    await waitForTransitions(transitioned);
    ok(button.matches(":hover"), "Button is hovered");

    EventUtils.synthesizeMouseAtPoint(x, y, { type: "mousedown" });
    ok(button.matches(":hover:active"), "Button is pressed");
    Assert.greater(
      await waitForTransitions(transitioned),
      0,
      "Pressing the button starts a transition"
    );
    is(getComputedStyle(icon).scale, "0.95", "The pressed icon shrinks");

    // Release outside the button so that it doesn't get clicked.
    EventUtils.synthesizeMouseAtPoint(outsideX, outsideY, {
      type: "mousemove",
    });
    EventUtils.synthesizeMouseAtPoint(outsideX, outsideY, { type: "mouseup" });
    await waitForTransitions(transitioned);

    await waitForFrames();
  } finally {
    window.docShell.removeWeakReflowObserver(observer);
  }
  return reflows;
}

add_task(async function test_toolbarbutton() {
  let button = createToolbarButton(false);
  await waitForFrames();
  let icon = button.querySelector(":scope > .toolbarbutton-icon");
  is(
    await countReflowsDuringPress(button, icon, [button]),
    0,
    "Pressing a toolbar button doesn't reflow"
  );

  // A badge notification can mark the button as badged after it has built its
  // children, which leaves its icon without a badge stack.
  button.setAttribute("badged", "true");
  isnot(
    getComputedStyle(button, "::before").content,
    "none",
    "A plain button keeps its background box once marked as badged"
  );
  button.remove();
});

add_task(async function test_badged_toolbarbutton() {
  let button = createToolbarButton(true);
  await waitForFrames();
  let stack = button.querySelector(".toolbarbutton-badge-stack");
  ok(stack, "Button has a badge stack");
  let icon = stack.querySelector(".toolbarbutton-icon");
  is(
    await countReflowsDuringPress(button, icon, [button]),
    0,
    "Pressing a badged toolbar button doesn't reflow"
  );

  button.removeAttribute("badged");
  is(
    getComputedStyle(button, "::before").content,
    "none",
    "A badged button gets no background box once its badge is removed"
  );
  button.remove();
});

add_task(async function test_moz_button_toolbar() {
  let button = document.createElement("moz-button");
  button.type = "toolbar";
  button.iconSrc = ICON;
  button.title = "Test";
  document.getElementById("nav-bar-customization-target").append(button);
  registerCleanupFunction(() => button.remove());
  await button.updateComplete;
  await waitForFrames();
  let icon = button.shadowRoot.querySelector("img");
  is(
    await countReflowsDuringPress(button, icon, [button.buttonEl, icon]),
    0,
    "Pressing a toolbar moz-button doesn't reflow"
  );
  button.remove();
});

add_task(async function test_sidebar_button() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["sidebar.revamp", true],
      ["sidebar.verticalTabs", true],
      ["sidebar.visibility", "always-show"],
    ],
  });
  let sidebarMain = SidebarController.sidebarMain;
  await sidebarMain.updateComplete;
  let button;
  await TestUtils.waitForCondition(() => {
    button = sidebarMain.shadowRoot.querySelector(".actions-list > moz-button");
    return button && BrowserTestUtils.isVisible(button);
  }, "Wait for a sidebar button to be visible");
  await button.updateComplete;
  await waitForFrames();
  let icon = button.shadowRoot.querySelector("img");
  is(
    await countReflowsDuringPress(button, icon, [button.buttonEl, icon]),
    0,
    "Pressing a sidebar button doesn't reflow"
  );
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_downloads_button() {
  await SpecialPowers.pushPrefEnv({
    set: [["browser.download.autohideButton", false]],
  });
  // Pressing the button opens the downloads panel, whose reflows aren't the
  // ones this test is about.
  let { sinon } = ChromeUtils.importESModule(
    "resource://testing-common/Sinon.sys.mjs"
  );
  let showPanel = sinon.stub(DownloadsPanel, "showPanel");
  registerCleanupFunction(() => showPanel.restore());
  let button = document.getElementById("downloads-button");
  await TestUtils.waitForCondition(
    () => BrowserTestUtils.isVisible(button),
    "Wait for the downloads button to be visible"
  );
  await waitForFrames();
  let anchor = document.getElementById("downloads-indicator-anchor");
  is(
    await countReflowsDuringPress(button, anchor, [button]),
    0,
    "Pressing the downloads button doesn't reflow"
  );

  button.setAttribute("progress", "true");
  registerCleanupFunction(() => button.removeAttribute("progress"));
  await waitForFrames();
  let progress = document.getElementById("downloads-indicator-progress-outer");
  ok(BrowserTestUtils.isVisible(progress), "The progress ring is visible");
  is(
    await countReflowsDuringPress(button, progress, [button]),
    0,
    "Pressing the downloads button during a download doesn't reflow"
  );
  button.removeAttribute("progress");
  showPanel.restore();
});

add_task(async function test_back_button_hold() {
  let tab = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    "https://example.com/?first"
  );
  BrowserTestUtils.startLoadingURIString(
    tab.linkedBrowser,
    "https://example.com/?second"
  );
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser);
  let button = document.getElementById("back-button");
  await TestUtils.waitForCondition(
    () => !button.disabled,
    "Wait for the back button to be enabled"
  );
  let icon = button.querySelector(":scope > .toolbarbutton-icon");

  // Holding the button opens its history menu, which clears :active.
  EventUtils.synthesizeMouseAtCenter(button, { type: "mousemove" });
  let shown = BrowserTestUtils.waitForPopupEvent(button.menupopup, "shown");
  EventUtils.synthesizeMouseAtCenter(button, { type: "mousedown" });
  await shown;
  await waitForTransitions([button]);
  is(
    getComputedStyle(icon).scale,
    "0.95",
    "The icon stays shrunk once the held button opens its menu"
  );

  EventUtils.synthesizeMouseAtCenter(gURLBar.inputField, { type: "mouseup" });
  ok(!button.hasAttribute("held"), "Releasing the mouse releases the button");

  let hidden = BrowserTestUtils.waitForPopupEvent(button.menupopup, "hidden");
  button.menupopup.hidePopup();
  await hidden;
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_rtl_press() {
  await SpecialPowers.pushPrefEnv({ set: [["intl.l10n.pseudo", "bidi"]] });
  await TestUtils.waitForCondition(
    () => document.documentElement.matches(":-moz-locale-dir(rtl)"),
    "Wait for the window to switch to RTL"
  );
  // The main menu icon is mirrored in RTL, which must not stop it shrinking.
  let button = document.getElementById("PanelUI-menu-button");
  let icon = button.querySelector(
    ".toolbarbutton-badge-stack > .toolbarbutton-icon"
  );
  InspectorUtils.addPseudoClassLock(button, ":hover");
  InspectorUtils.addPseudoClassLock(button, ":active");
  await waitForTransitions([button]);
  let style = getComputedStyle(icon);
  is(style.scale, "0.95", "The mirrored icon shrinks when pressed");
  is(
    style.transform,
    "matrix(-1, 0, 0, 1, 0, 0)",
    "The pressed icon stays mirrored"
  );
  InspectorUtils.removePseudoClassLock(button, ":active");
  InspectorUtils.removePseudoClassLock(button, ":hover");
  await SpecialPowers.popPrefEnv();
  await TestUtils.waitForCondition(
    () => !document.documentElement.matches(":-moz-locale-dir(rtl)"),
    "Wait for the window to switch back to LTR"
  );
});
