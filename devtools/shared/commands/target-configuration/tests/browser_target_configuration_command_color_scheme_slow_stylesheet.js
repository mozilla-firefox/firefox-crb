/* Any copyright is dedicated to the Public Domain.
 http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Test that the color scheme simulation applies to a remote iframe as soon as
// it loads, even when a slow stylesheet delays the layout of its embedder.
const TEST_DOCUMENT = "target_configuration_test_doc.sjs";

add_task(async function () {
  const tab = await addTab(URL_ROOT_COM_SSL + TEST_DOCUMENT);

  const commands = await CommandsFactory.forTab(tab);
  await commands.targetCommand.startListening();
  await commands.targetConfigurationCommand.updateConfiguration({
    colorSchemeSimulation: "dark",
  });

  info("Load a page with a slow stylesheet and a remote iframe");
  const onPageLoaded = BrowserTestUtils.browserLoaded(
    gBrowser.selectedBrowser,
    /* includeSubFrames */ true
  );
  BrowserTestUtils.startLoadingURIString(
    gBrowser.selectedBrowser,
    URL_ROOT_COM_SSL + TEST_DOCUMENT + "?slowStylesheet=true"
  );
  await onPageLoaded;

  const iframeBC = await SpecialPowers.spawn(
    gBrowser.selectedBrowser,
    [],
    () => content.document.querySelector("iframe").browsingContext
  );

  is(
    await SpecialPowers.spawn(
      iframeBC,
      [],
      () => content.wrappedJSObject.initialMatchesPrefersDarkColorScheme
    ),
    true,
    "The dark mode simulation was enabled in the remote iframe when it loaded"
  );

  await commands.destroy();
});
