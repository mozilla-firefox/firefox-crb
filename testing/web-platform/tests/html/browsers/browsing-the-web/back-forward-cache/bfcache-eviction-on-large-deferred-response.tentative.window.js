// META: title=BFCache evicts page when deferred response exceeds buffer limit
// META: timeout=long
// META: script=/common/dispatcher/dispatcher.js
// META: script=/common/utils.js
// META: script=/html/browsers/browsing-the-web/back-forward-cache/resources/rc-helper.js
// META: script=/html/browsers/browsing-the-web/remote-context-helper/resources/remote-context-helper.js

'use strict';

// Browsers may evict a BFCached page whose deferred responses exceed an
// implementation-defined buffer limit (typically ~1 MB).  Use a body safely
// above that to trigger eviction and a small one to stay below the threshold.
const exceededBufferSize = 2 * 1024 * 1024;
const belowBufferSizeMax = 1024 * 8;

promise_test(async t => {
  const uuid = token();
  const doneUuid = token();
  const rcHelper = new RemoteContextHelper();
  const rc1 = await rcHelper.addWindow(null, {features: 'noopener'});

  // Start a fetch whose response is held by the server until we release it.
  await rc1.executeScript((id, doneId, size) => {
    window.fetchResult = fetch(
      `/html/browsers/browsing-the-web/back-forward-cache/resources/large-deferred-response.py?uuid=${id}&done=${doneId}&size=${size}`
    ).then(r => r.text());
  }, [uuid, doneUuid, belowBufferSizeMax]);

  // Navigate away — the page enters BFCache, the fetch becomes deferred.
  await prepareForBFCache(rc1);
  const rc2 = await rc1.navigateToNew();

  // Signal the server to send the remaining response bytes.
  await (await fetch(
    `/html/browsers/browsing-the-web/back-forward-cache/resources/large-deferred-response.py?uuid=${uuid}&done=${doneUuid}&release=1`
  )).text();

  // Navigate back. The response fits within the buffer limit so the page
  // should still be in BFCache.
  await rc2.historyBack();
  await assertImplementsBFCacheOptional(rc1);

  const deferredFetchResult = await rc1.executeScript(async () => {
    if (window.fetchResult) {
      const text = await window.fetchResult;
      return text.length;
    }
    return undefined;
  }, []);
  assert_equals(deferredFetchResult, belowBufferSizeMax);
}, 'Page is not evicted when requests do not exceed max buffer threshold');

promise_test(async t => {
  const uuid = token();
  const doneUuid = token();
  const rcHelper = new RemoteContextHelper();
  const rc1 = await rcHelper.addWindow(null, {features: 'noopener'});

  // Start a fetch whose response is held by the server until we release it.
  await rc1.executeScript((id, doneId, size) => {
    window.fetchResult = fetch(
      `/html/browsers/browsing-the-web/back-forward-cache/resources/large-deferred-response.py?uuid=${id}&done=${doneId}&size=${size}`
    ).then(r => r.text());
  }, [uuid, doneUuid, exceededBufferSize]);

  // Navigate away — the page enters BFCache, the fetch becomes deferred.
  await prepareForBFCache(rc1);
  const rc2 = await rc1.navigateToNew();

  // Signal the server to send the remaining response bytes.
  await (await fetch(
    `/html/browsers/browsing-the-web/back-forward-cache/resources/large-deferred-response.py?uuid=${uuid}&done=${doneUuid}&release=1`
  )).text();

  // Navigate back. The deferred response exceeded the buffer limit so the
  // page should have been evicted from BFCache.
  await rc2.historyBack();
  const deferredFetchResult = await rc1.executeScript(async () => {
    if (window.fetchResult) {
      const text = await window.fetchResult;
      return text.length;
    }
    return undefined;
  }, []);
  assert_equals(deferredFetchResult, undefined);
  await assertNotRestoredFromBFCache(rc1);
}, 'Page is evicted from BFCache when deferred response exceeds buffer limit')
