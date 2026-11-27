/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

requestLongerTimeout(2);

/**
 * This test ensures that form data collection respects the privacy level as
 * set by the user.
 */
add_task(async function test_formdata() {
  const URL =
    "http://mochi.test:8888/browser/browser/components/" +
    "sessionstore/test/browser_formdata_sample.html";

  const OUTER_VALUE = "browser_formdata_" + Math.random();
  const INNER_VALUE = "browser_formdata_" + Math.random();

  // Creates a tab, loads a page with some form fields,
  // modifies their values and closes the tab.
  async function createAndRemoveTab() {
    // Create a new tab.
    let tab = BrowserTestUtils.addTab(gBrowser, URL);
    let browser = tab.linkedBrowser;
    await promiseBrowserLoaded(browser);

    // Modify form data.
    await setPropertyOfFormField(browser, "#txt", "value", OUTER_VALUE);
    await setPropertyOfFormField(
      browser.browsingContext.children[0],
      "#txt",
      "value",
      INNER_VALUE
    );

    // Remove the tab.
    await promiseRemoveTabAndSessionState(tab);
  }

  await createAndRemoveTab();
  let [
    {
      state: { formdata },
    },
  ] = ss.getClosedTabDataForWindow(window);
  is(formdata.id.txt, OUTER_VALUE, "outer value is correct");
  is(formdata.children[0].id.txt, INNER_VALUE, "inner value is correct");

  // Disable saving data for encrypted sites.
  Services.prefs.setIntPref("browser.sessionstore.privacy_level", 1);

  await createAndRemoveTab();
  [
    {
      state: { formdata },
    },
  ] = ss.getClosedTabDataForWindow(window);
  is(formdata.id.txt, OUTER_VALUE, "outer value is correct");
  ok(!formdata.children, "inner value was *not* stored");

  // Disable saving data for any site.
  Services.prefs.setIntPref("browser.sessionstore.privacy_level", 2);

  await createAndRemoveTab();
  [
    {
      state: { formdata },
    },
  ] = ss.getClosedTabDataForWindow(window);
  ok(!formdata, "form data has *not* been stored");

  // Restore the default privacy level.
  Services.prefs.clearUserPref("browser.sessionstore.privacy_level");
});

/**
 * This test ensures that a malicious website can't trick us into restoring
 * form data into a wrong website and that we always check the stored URL
 * before doing so.
 */
add_task(async function test_url_check() {
  const URL = "data:text/html;charset=utf-8,<input id=input>";
  const VALUE = "value-" + Math.random();

  // Create a tab with an iframe containing an input field.
  let tab = BrowserTestUtils.addTab(gBrowser, URL);
  let browser = tab.linkedBrowser;
  await promiseBrowserLoaded(browser);

  // Restore a tab state with a given form data url.
  async function restoreStateWithURL(url) {
    let state = {
      entries: [{ url: URL, triggeringPrincipal_base64 }],
      formdata: { id: { input: VALUE } },
    };

    if (url) {
      state.formdata.url = url;
    }

    await promiseTabState(tab, state);
    return getPropertyOfFormField(browser, "#input", "value");
  }

  // Check that the form value is restored with the correct URL.
  is(await restoreStateWithURL(URL), VALUE, "form data restored");

  // Check that the form value is *not* restored with the wrong URL.
  is(await restoreStateWithURL(URL + "?"), "", "form data not restored");
  is(await restoreStateWithURL(), "", "form data not restored");

  // Cleanup.
  gBrowser.removeTab(tab);
});

/**
 * This test ensures that collecting form data works as expected when having
 * nested frame sets.
 */
add_task(async function test_nested() {
  const URL =
    "data:text/html;charset=utf-8," +
    "<iframe src='data:text/html;charset=utf-8,<input/>'/>";

  const FORM_DATA = {
    children: [
      {
        url: "data:text/html;charset=utf-8,<input/>",
        xpath: { "/xhtml:html/xhtml:body/xhtml:input": "m" },
      },
    ],
  };

  // Create a tab with an iframe containing an input field.
  let tab = (gBrowser.selectedTab = BrowserTestUtils.addTab(gBrowser, URL));
  let browser = tab.linkedBrowser;
  await promiseBrowserLoaded(browser, false /* don't ignore subframes */);

  const iframe = await SpecialPowers.spawn(browser, [], () => {
    return content.document.querySelector("iframe").browsingContext;
  });
  await SpecialPowers.spawn(iframe, [], async () => {
    const input = content.document.querySelector("input");
    const focusPromise = new Promise(resolve => {
      input.addEventListener("focus", resolve, { once: true });
    });
    input.focus();
    await focusPromise;
  });

  // Modify the input field's value.
  await BrowserTestUtils.synthesizeKey("m", {}, browser);

  // Remove the tab and check that we stored form data correctly.
  await promiseRemoveTabAndSessionState(tab);
  let [
    {
      state: { formdata },
    },
  ] = ss.getClosedTabDataForWindow(window);
  is(
    JSON.stringify(formdata),
    JSON.stringify(FORM_DATA),
    "formdata for iframe stored correctly"
  );

  // Restore the closed tab.
  tab = ss.undoCloseTab(window, 0);
  browser = tab.linkedBrowser;
  await promiseTabRestored(tab);

  // Check that the input field has the right value.
  await TabStateFlusher.flush(browser);
  ({ formdata } = JSON.parse(ss.getTabState(tab)));
  is(
    JSON.stringify(formdata),
    JSON.stringify(FORM_DATA),
    "formdata for iframe restored correctly"
  );

  // Cleanup.
  gBrowser.removeTab(tab);
});

/**
 * This test ensures that collecting form data for documents with
 * designMode=on works as expected.
 */
add_task(async function test_design_mode() {
  const URL =
    "data:text/html;charset=utf-8,<h1>mozilla</h1>" +
    "<script>document.designMode='on'</script>";

  // Load a tab with an editable document.
  let tab = (gBrowser.selectedTab = BrowserTestUtils.addTab(gBrowser, URL));
  let browser = tab.linkedBrowser;
  await promiseBrowserLoaded(browser);

  // Modify the document content.
  await BrowserTestUtils.synthesizeKey("m", {}, browser);

  // Close and restore the tab.
  await promiseRemoveTabAndSessionState(tab);
  tab = ss.undoCloseTab(window, 0);
  browser = tab.linkedBrowser;
  await promiseTabRestored(tab);

  // Check that the innerHTML value was restored.
  let html = await getPropertyOfFormField(browser, "body", "innerHTML");
  let expected = "<h1>mmozilla</h1><script>document.designMode='on'</script>";
  is(html, expected, "editable document has been restored correctly");

  // Close and restore the tab.
  await promiseRemoveTabAndSessionState(tab);
  tab = ss.undoCloseTab(window, 0);
  browser = tab.linkedBrowser;
  await promiseTabRestored(tab);

  // Check that the innerHTML value was restored.
  html = await getPropertyOfFormField(browser, "body", "innerHTML");
  expected = "<h1>mmozilla</h1><script>document.designMode='on'</script>";
  is(html, expected, "editable document has been restored correctly");

  // Cleanup.
  gBrowser.removeTab(tab);
});

/**
 * This test ensures that restoring an unmodified editable document
 * (designMode=on) does not replace its content with a re-parsed copy of its
 * serialized innerHTML. That would lose state that innerHTML can't round-trip,
 * such as an element that script moved into an SVG element, or a shadow root.
 */
add_task(async function test_design_mode_unmodified() {
  const URL =
    "data:text/html;charset=utf-8,<div id='host'></div>" +
    "<h6 id='b'></h6><svg><marker id='c'></marker></svg>" +
    "<script>document.getElementById('c').appendChild(" +
    "document.getElementById('b'));" +
    "document.getElementById('host').attachShadow({mode:'open'})" +
    ".innerHTML='<p>shadow</p>';" +
    "document.designMode='on'</script>";

  async function checkDOM(browser, msg) {
    let result = await SpecialPowers.spawn(browser, [], () => {
      let doc = content.document;
      return {
        parent: doc.getElementById("b").parentNode.id,
        shadow: !!doc.getElementById("host").shadowRoot,
      };
    });
    is(result.parent, "c", `h6 is still inside the SVG marker ${msg}`);
    ok(result.shadow, `shadow root still exists ${msg}`);
  }

  let tab = (gBrowser.selectedTab = BrowserTestUtils.addTab(gBrowser, URL));
  let browser = tab.linkedBrowser;
  await promiseBrowserLoaded(browser);
  await checkDOM(browser, "after initial load");

  // Close and restore the tab without modifying the document.
  await promiseRemoveTabAndSessionState(tab);
  tab = ss.undoCloseTab(window, 0);
  browser = tab.linkedBrowser;
  await promiseTabRestored(tab);
  await checkDOM(browser, "after restoring the tab");

  // Cleanup.
  gBrowser.removeTab(tab);
});
