// META: title=Deferred XHR completes after BFCache restore
// META: timeout=long
// META: script=/common/dispatcher/dispatcher.js
// META: script=/common/utils.js
// META: script=/html/browsers/browsing-the-web/back-forward-cache/resources/rc-helper.js
// META: script=/html/browsers/browsing-the-web/remote-context-helper/resources/remote-context-helper.js

'use strict';

function kilobytes(n) {
  return n * 1024;
}

// The server sends 64 KiB of repeating a-z ASCII.
function makeExpectedBody(size) {
  const base = 'abcdefghijklmnopqrstuvwxyz';
  return base.repeat(Math.floor(size / base.length)) +
         base.slice(0, size % base.length);
}

const BODY_SIZE = kilobytes(32);

promise_test(async t => {
  const uuid = token();
  const rcHelper = new RemoteContextHelper();
  const rc1 = await rcHelper.addWindow(null, {features: 'noopener'});

  // Start an XHR whose response is held by the server until we release it.
  await rc1.executeScript((id, size) => {
    window.xhrResult = new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', `/html/browsers/browsing-the-web/back-forward-cache/resources/delayed-response.py?uuid=${id}&size=${size}`);
      xhr.onload = () => resolve(xhr.responseText);
      xhr.onerror = () => reject(new Error('XHR failed'));
      xhr.onabort = () => reject(new Error('XHR aborted'));
      xhr.send();
    });
  }, [uuid, BODY_SIZE]);

  // Navigate away and back through BFCache.
  await prepareForBFCache(rc1);
  const rc2 = await rc1.navigateToNew();
  await rc2.historyBack();
  await assertImplementsBFCacheOptional(rc1);

  // Signal the server to complete the response (simulating lag).
  await fetch(`/html/browsers/browsing-the-web/back-forward-cache/resources/delayed-response.py?uuid=${uuid}&release=1`);

  // Assert that request completed and also contains the exact contents expected.
  const result = await rc1.executeScript(() => window.xhrResult);
  const expected = makeExpectedBody(BODY_SIZE);
  assert_equals(result.length, expected.length, 'Response length');
  assert_equals(result, expected, 'Response body');
}, 'Deferred XHR completes with full body after BFCache restore');
