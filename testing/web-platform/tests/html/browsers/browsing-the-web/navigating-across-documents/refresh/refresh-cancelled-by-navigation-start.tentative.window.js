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
// The page refreshes one second after it has loaded.
const WAIT_PAST_REFRESH_MS = 2500;

promise_test(async t => {
  const frame = document.createElement('iframe');
  t.add_cleanup(() => frame.remove());
  await new Promise(resolve => {
    frame.addEventListener('load', resolve, {once: true});
    frame.src = REFRESHING_PAGE;
    document.body.append(frame);
  });
  const refreshingURL = frame.contentWindow.location.href;

  let loads = 0;
  frame.addEventListener('load', () => loads++);
  const navigation = heldRequest(t, 'no-content');
  frame.contentWindow.location.href = navigation.url;
  await navigation.waitForRequest();
  await navigation.release();

  await timeout(t, WAIT_PAST_REFRESH_MS);
  assert_equals(frame.contentWindow.location.href, refreshingURL,
                'the document that started the navigation is still displayed');
  assert_equals(loads, 0, 'the pending refresh does not happen');
}, 'Starting a navigation that does not commit cancels the pending refresh');
