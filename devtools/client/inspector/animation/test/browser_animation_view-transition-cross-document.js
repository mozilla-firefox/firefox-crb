/* Any copyright is dedicated to the Public Domain.
http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Test for cross document view transition.
const TEST_URL_START =
  URL_ROOT + "doc_view_transition_cross_document_start.html";
const TEST_URL_END = URL_ROOT + "doc_view_transition_cross_document_end.html";

const TEST_DATA = [
  "::view-transition-group(my-vt): my-vt-animation",
  "::view-transition-group(root): -ua-view-transition-group-anim-root",
  "::view-transition-new(my-vt): -ua-mix-blend-mode-plus-lighter",
  "::view-transition-new(my-vt): -ua-view-transition-fade-in",
  "::view-transition-new(root): -ua-mix-blend-mode-plus-lighter",
  "::view-transition-new(root): -ua-view-transition-fade-in",
  "::view-transition-old(my-vt): -ua-mix-blend-mode-plus-lighter",
  "::view-transition-old(my-vt): -ua-view-transition-fade-out",
  "::view-transition-old(root): -ua-mix-blend-mode-plus-lighter",
  "::view-transition-old(root): -ua-view-transition-fade-out",
  "h1: clr",
];

add_task(async function () {
  await pushPref("devtools.toolbox.footer.height", 600);
  await pushPref("devtools.toolsidebar-width.inspector", 600);
  await pushPref("devtools.inspector.three-pane-enabled", false);
  await addTab(TEST_URL_START);

  const { animationInspector, inspector, panel } =
    await openAnimationInspector();

  // Select the html node so we can see ::view-transition animations
  await selectNode("html", inspector);

  info("Navigating to a page to trigger the view transition");
  await navigateTo(TEST_URL_END, { waitForLoad: false });

  info("Waiting for expected animations to be displayed");
  await checkAllAnimations(panel, TEST_DATA);
  await clickOnTargetNodeByTargetText(
    animationInspector,
    panel,
    "::view-transition-group(my-vt)"
  );
  is(
    inspector.selection.nodeFront.displayName,
    "::view-transition-group(my-vt)",
    "Expected view transition pseudo element node was selected"
  );

  // we get all the view transition animations, even those on elements who are not children
  // of the currently selected node
  await checkAllAnimations(
    panel,
    TEST_DATA.filter(s => s.startsWith("::view-transition"))
  );

  info(
    "Stop the view transition and check that only the non-view-transition animation is left"
  );
  await SpecialPowers.spawn(gBrowser.selectedBrowser, [], async () => {
    content.document.activeViewTransition.skipTransition();
  });
  await checkAllAnimations(panel, [TEST_DATA.at(-1)]);
  is(
    inspector.selection.nodeFront.displayName,
    "html",
    "The html node is now selected since the ::view-transition elements were removed"
  );
});

async function checkAllAnimations(panel, expectedData) {
  await waitFor(
    () =>
      panel.querySelectorAll(".animation-list .animation-item").length ===
      expectedData.length,
    {
      toString() {
        return `Expected ${expectedData.length} animation items, got ${panel.querySelectorAll(".animation-list .animation-item").length}.`;
      },
    }
  );

  const displayed = [];
  for (let i = 0; i < expectedData.length; i++) {
    info(`Check item at index #${i}\n`);
    const animationItemEl = await findAnimationItemByIndex(panel, i);
    if (!animationItemEl) {
      ok(false, `Didn't find an animation at index #${i}`);
      continue;
    }
    const animationTargetEl = animationItemEl.querySelector(
      ".animation-list .animation-item .animation-target"
    );
    const animationNameEl = animationItemEl.querySelector(".animation-name");
    displayed.push(
      `${animationTargetEl.textContent}: ${animationNameEl.textContent}`
    );
  }
  displayed.sort();
  Assert.deepEqual(
    displayed,
    expectedData,
    "Got expected animation targets and names"
  );
}
