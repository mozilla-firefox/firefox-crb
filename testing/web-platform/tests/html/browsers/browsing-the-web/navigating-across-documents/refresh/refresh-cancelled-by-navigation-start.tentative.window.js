// META: title=Starting a navigation cancels the document's pending refresh
// META: timeout=long
// META: script=/common/utils.js
// META: script=/html/browsers/browsing-the-web/navigating-across-documents/resources/pending-navigation-helpers.js

'use strict';

// Starting a navigation aborts the active document, and with it any refresh
// the document has pending. That holds even if the navigation never commits,
// so the document stays displayed but no longer refreshes.
//
// Tentative: see https://github.com/whatwg/html/issues/4489.

const REFRESHING_PAGE = 'resources/meta-refresh-delayed.html';

promise_test(async t => {
  const frame = await withIframe(t, REFRESHING_PAGE);
  const refreshingURL = frame.contentWindow.location.href;

  let loads = 0;
  frame.addEventListener('load', () => loads++);
  frame.contentWindow.location.href =
      serverEndpoint('immediate', '', 'no-content');

  // A frame that loads the same page later refreshes later, so once it has,
  // |frame| would have refreshed too.
  const control = await withIframe(t, REFRESHING_PAGE);
  await new Promise(resolve =>
      control.addEventListener('load', resolve, {once: true}));

  assert_equals(frame.contentWindow.location.href, refreshingURL,
                'the document that started the navigation is still displayed');
  assert_equals(loads, 0, 'the pending refresh does not happen');
}, 'Starting a navigation that does not commit cancels the pending refresh');
