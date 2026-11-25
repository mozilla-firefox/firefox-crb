/* Any copyright is dedicated to the Public Domain.
http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Test for cross document view transition.
const TEST_URL_START =
  URL_ROOT + "doc_view_transition_cross_document_start.html";
const TEST_URL_END = URL_ROOT + "doc_view_transition_cross_document_end.html";

const TEST_DATA = [
  {
    expectedTargetLabel: "::view-transition-group(my-vt)",
    expectedAnimationNameLabel: "my-vt-animation",
  },
  {
    expectedTargetLabel: "::view-transition-group(root)",
    expectedAnimationNameLabel: "-ua-view-transition-group-anim-root",
  },
  {
    expectedTargetLabel: "::view-transition-old(my-vt)",
    expectedAnimationNameLabel: "-ua-view-transition-fade-out",
  },
  {
    expectedTargetLabel: "::view-transition-old(my-vt)",
    expectedAnimationNameLabel: "-ua-mix-blend-mode-plus-lighter",
  },
  {
    expectedTargetLabel: "::view-transition-old(root)",
    expectedAnimationNameLabel: "-ua-view-transition-fade-out",
  },
  {
    expectedTargetLabel: "::view-transition-old(root)",
    expectedAnimationNameLabel: "-ua-mix-blend-mode-plus-lighter",
  },
  {
    expectedTargetLabel: "::view-transition-new(my-vt)",
    expectedAnimationNameLabel: "-ua-view-transition-fade-in",
  },
  {
    expectedTargetLabel: "::view-transition-new(my-vt)",
    expectedAnimationNameLabel: "-ua-mix-blend-mode-plus-lighter",
  },
  {
    expectedTargetLabel: "::view-transition-new(root)",
    expectedAnimationNameLabel: "-ua-view-transition-fade-in",
  },
  {
    expectedTargetLabel: "::view-transition-new(root)",
    expectedAnimationNameLabel: "-ua-mix-blend-mode-plus-lighter",
  },
];

add_task(async function () {
  await addTab(TEST_URL_START);

  const { animationInspector, inspector, panel } =
    await openAnimationInspector();

  // Select the html node so we can see ::view-transition animations
  await selectNode("html", inspector);

  info("Navigating to a page to trigger the view transition");
  await navigateTo(TEST_URL_END, { waitForLoad: false });

  info("Waiting for expected animations to be displayed");
  try {
    await waitFor(
      () =>
        panel.querySelectorAll(".animation-list .animation-item").length ===
        TEST_DATA.length
    );
    ok(
      true,
      `Got expectedCount of animation item should be ${TEST_DATA.length}`
    );
  } catch (e) {
    ok(
      false,
      `Didn't get expected number of animations. Got ${panel.querySelectorAll(".animation-list .animation-item").length} expected ${TEST_DATA.length}`
    );
  }

  info("Checking content of each animation item");
  for (let i = 0; i < TEST_DATA.length; i++) {
    await checkAnimationItemAtIndex(panel, i, TEST_DATA[i]);
  }

  await clickOnTargetNodeByTargetText(
    animationInspector,
    panel,
    "::view-transition-group(my-vt)"
  );

  // we get all the view transition animations, even those on elements who are not children
  // of the currently selected node
  const expectedTargets = TEST_DATA.map(item => item.expectedTargetLabel);
  await waitFor(() =>
    [
      ...panel.querySelectorAll(
        ".animation-list .animation-item .animation-target .attrName"
      ),
    ]
      .map(attrNameEl => attrNameEl.textContent)
      .every((targetElText, index) => targetElText === expectedTargets[index])
  );

  is(
    inspector.selection.nodeFront.displayName,
    "::view-transition-group(my-vt)",
    "Expected view transition pseudo element node was selected"
  );

  info("Select <html> to reset the animation list");
  await selectNode("html", inspector);
  // wait for all the animations to be displayed again
  await waitFor(
    () =>
      panel.querySelectorAll(".animation-list .animation-item").length ===
      TEST_DATA.length
  );

  info(
    "Stop the view transition and check that related animations are removed"
  );
  await SpecialPowers.spawn(gBrowser.selectedBrowser, [], async () => {
    content.document.activeViewTransition.skipTransition();
  });

  await waitFor(
    () => panel.querySelectorAll(".animation-list .animation-item").length === 0
  );
  ok(
    true,
    `Got expectedCount of animation item after stopping the view transition`
  );
});

async function checkAnimationItemAtIndex(panel, index, testData) {
  info(`Checking pseudo element for animation at index #${index}`);
  const animationItemEl = await findAnimationItemByIndex(panel, index);

  if (!animationItemEl) {
    ok(false, `Didn't find an animation at index #${index}`);
    return;
  }

  info("Checking text content of animation target");
  const animationTargetEl = animationItemEl.querySelector(
    ".animation-list .animation-item .animation-target"
  );
  is(
    animationTargetEl.textContent,
    testData.expectedTargetLabel,
    `Got expected target for animation at index #${index}`
  );

  info("Checking text content of animation name");
  const animationNameEl = animationItemEl.querySelector(".animation-name");
  is(
    animationNameEl.textContent,
    testData.expectedAnimationNameLabel,
    `Got expected animation name for animation at index #${index}`
  );
}
