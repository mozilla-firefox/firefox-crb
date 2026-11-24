// META: title=Deferred XHR reports progress events after BFCache restore
// META: timeout=long
// META: script=/common/dispatcher/dispatcher.js
// META: script=/common/utils.js
// META: script=/html/browsers/browsing-the-web/back-forward-cache/resources/rc-helper.js
// META: script=/html/browsers/browsing-the-web/remote-context-helper/resources/remote-context-helper.js

'use strict';

function kilobytes(n) {
  return n * 1024;
}

const BODY_SIZE = kilobytes(32);
const RESPONSE_URL =
  '/html/browsers/browsing-the-web/back-forward-cache/resources/large-deferred-response.py';

promise_test(async t => {
  const uuid = token();
  const doneUuid = token();
  const rcHelper = new RemoteContextHelper();
  const rc1 = await rcHelper.addWindow(null, {features: 'noopener'});

  // The server sends 80 bytes immediately, then holds the rest until a
  // release request arrives.  The release request blocks until the server
  // has finished writing all the data, so awaiting it guarantees the bytes
  // were delivered to the network stack.
  await rc1.executeScript((id, doneId, size, url) => {
    window.progressEvents = [];
    window.loadEvent = null;
    window.loadendEvent = null;
    window.newEvents = new EventTarget();
    window.pageHidden = false;
    window.pageShown = false;
    // This should never flip to true, it means something ran between pagehide and pageshow.
    window.progressDuringBFCache = false;

    window.addEventListener('pagehide', (e) => {
      if (e.persisted) {
        window.pageHidden = true;
      }
    });
    window.addEventListener('pageshow', (e) => {
      if (e.persisted) {
        window.pageShown = true;
      }
    });

    window.xhrResult = new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', `${url}?uuid=${id}&done=${doneId}&size=${size}`);
      xhr.onprogress = (e) => {
        if (window.pageHidden && !window.pageShown) {
          window.progressDuringBFCache = true;
        }
        window.progressEvents.push({
          loaded: e.loaded,
          total: e.total,
          lengthComputable: e.lengthComputable,
        });
        window.newEvents.dispatchEvent(new Event("new"));
      };
      xhr.onload = (e) => {
        window.loadEvent = {loaded: e.loaded, total: e.total, lengthComputable: e.lengthComputable};
        resolve(xhr.responseText);
      };
      xhr.onloadend = (e) => {
        window.loadendEvent = {loaded: e.loaded, total: e.total, lengthComputable: e.lengthComputable};
      };
      xhr.onerror = () => reject(new Error('XHR failed'));
      xhr.onabort = () => reject(new Error('XHR aborted'));
      xhr.send();
    });
  }, [uuid, doneUuid, BODY_SIZE, RESPONSE_URL]);

  // Wait for at least one progress event from the initial bytes.
  await prepareForBFCache(rc1);
  const eventCount = await rc1.executeScript(() => {
    return new Promise((resolve) => {
      if (window.progressEvents.length > 0) {
        resolve(window.progressEvents.length);
      } else {
        window.newEvents.addEventListener("new", () => resolve(window.progressEvents.length), { once: true });
      }
    });
  });

  // Navigate away — page enters BFCache.
  const rc2 = await rc1.navigateToNew();

  // Release the held response.  The server sends the remaining bytes and
  // this fetch does not resolve until all data has been written, so we
  // know data was delivered while the page was in BFCache.
  await (await fetch(
    `${RESPONSE_URL}?uuid=${uuid}&done=${doneUuid}&release=1`
  )).text();

  // Navigate back.
  await rc2.historyBack();
  await assertImplementsBFCacheOptional(rc1);

  // Wait for the XHR to complete.
  await rc1.executeScript(() => window.xhrResult);

  // No progress events should have been dispatched while the page was in
  // BFCache (between pagehide and pageshow).
  const progressDuringBFCache = await rc1.executeScript(
    () => window.progressDuringBFCache);
  assert_false(progressDuringBFCache,
    'No progress events should fire while the page is in BFCache');

  // Collect progress events recorded in the page.
  const events = await rc1.executeScript(() => window.progressEvents);

  assert_greater_than(events.length, eventCount,
    'Should have received at least one progress event post restore');

  // Every event must have lengthComputable true (Content-Length is set).
  for (const e of events) {
    assert_true(e.lengthComputable, 'lengthComputable should be true');
    assert_equals(e.total, BODY_SIZE, 'total should match Content-Length');
  }

  // loaded values must be monotonically non-decreasing.
  for (let i = 1; i < events.length; i++) {
    assert_greater_than_equal(events[i].loaded, events[i - 1].loaded,
      `loaded should be non-decreasing (event ${i})`);
  }

  // The last progress event should report all bytes loaded.
  const last = events[events.length - 1];
  assert_equals(last.loaded, BODY_SIZE,
    'Final progress event should report all bytes loaded');

  // Per XHR spec, load and loadend events must report final progress values.
  const loadEvent = await rc1.executeScript(() => window.loadEvent);
  assert_equals(loadEvent.loaded, BODY_SIZE,
    'load event should report all bytes loaded');
  assert_equals(loadEvent.total, BODY_SIZE,
    'load event total should match Content-Length');
  assert_true(loadEvent.lengthComputable,
    'load event lengthComputable should be true');

  const loadendEvent = await rc1.executeScript(() => window.loadendEvent);
  assert_equals(loadendEvent.loaded, BODY_SIZE,
    'loadend event should report all bytes loaded');
  assert_equals(loadendEvent.total, BODY_SIZE,
    'loadend event total should match Content-Length');
  assert_true(loadendEvent.lengthComputable,
    'loadend event lengthComputable should be true');
}, 'Deferred XHR fires progress events with sensible values after BFCache restore');
