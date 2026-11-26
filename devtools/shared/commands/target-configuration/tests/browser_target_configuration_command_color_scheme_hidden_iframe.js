/* Any copyright is dedicated to the Public Domain.
 http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Test that the color scheme simulation applies to a remote iframe as soon as
// it loads, even before its embedder element is laid out.
const TEST_URI =
  URL_ROOT_COM_SSL + "target_configuration_test_doc.sjs?hiddenIframe=true";

add_task(async function () {
  const tab = await addTab(
    URL_ROOT_COM_SSL + "target_configuration_test_doc.sjs"
  );

  const commands = await CommandsFactory.forTab(tab);
  await commands.targetCommand.startListening();
  await commands.targetConfigurationCommand.updateConfiguration({
    colorSchemeSimulation: "dark",
  });

  info("Load a page with a hidden remote iframe");
  const onPageLoaded = BrowserTestUtils.browserLoaded(
    gBrowser.selectedBrowser,
    /* includeSubFrames */ true
  );
  BrowserTestUtils.startLoadingURIString(gBrowser.selectedBrowser, TEST_URI);
  await onPageLoaded;

  const iframeBC = await SpecialPowers.spawn(
    gBrowser.selectedBrowser,
    [],
    () => content.document.querySelector("iframe").browsingContext
  );
  ok(iframeBC.currentWindowGlobal?.isProcessRoot, "The iframe is remote");

  is(
    await SpecialPowers.spawn(
      iframeBC,
      [],
      () => content.wrappedJSObject.initialMatchesPrefersDarkColorScheme
    ),
    true,
    "The dark mode simulation was enabled in the hidden remote iframe when it loaded"
  );
  is(
    await SpecialPowers.spawn(
      iframeBC,
      [],
      () => content.matchMedia("(prefers-color-scheme: dark)").matches
    ),
    true,
    "The dark mode simulation is enabled in the hidden remote iframe"
  );

  await commands.destroy();
});
