// META: title=BFCache still works after a navigation that did not commit
// META: timeout=long
// META: script=/common/dispatcher/dispatcher.js
// META: script=/common/utils.js
// META: script=/html/browsers/browsing-the-web/back-forward-cache/resources/rc-helper.js
// META: script=/html/browsers/browsing-the-web/navigating-across-documents/resources/pending-navigation-helpers.js
// META: script=/html/browsers/browsing-the-web/remote-context-helper/resources/remote-context-helper.js

'use strict';

// Leaving a document untouched across a navigation that does not commit must
// not leave it in a state where a later, real navigation can no longer cache
// it. This is the regression test for the bookkeeping that the non-committing
// path has to unwind.
//
// Tentative: see https://github.com/whatwg/html/issues/4489.

promise_test(async t => {
  const rcHelper = new RemoteContextHelper();
  const rc1 = await rcHelper.addWindow(null, {features: 'noopener'});

  const bodyUuid = token();

  await rc1.executeScript(() => {
    window.__documentIsOriginal = true;
  });

  // An in-flight request, held open by the server, so the page has something
  // outstanding when it is cached.
  const delayedResponse =
      '/html/browsers/browsing-the-web/back-forward-cache/resources/delayed-response.py';
  await rc1.executeScript((url) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url);
    xhr.send();
  }, [`${delayedResponse}?uuid=${bodyUuid}&size=1024`]);
  t.add_cleanup(() => fetch(`${delayedResponse}?uuid=${bodyUuid}&release=1`));

  // A navigation that does not commit.
  const navigation = heldRequest(t, 'no-content');
  await rc1.executeScript((url) => {
    window.location.href = url;
  }, [navigation.url]);
  await navigation.waitForRequest();
  await navigation.release();
  assert_true(await rc1.executeScript(() => window.__documentIsOriginal),
              'the document that started the navigation should still be active');

  // Now navigate for real; the page should still be BFCache-eligible.
  await assertBFCacheEligibility(rc1, /*shouldRestoreFromBFCache=*/ true);
}, 'A page is still BFCache-eligible after a navigation that did not commit');
