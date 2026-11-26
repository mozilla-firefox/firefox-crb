// META: title=XHR timeout elapsing while in BFCache fires after restore
// META: timeout=long
// META: script=/common/dispatcher/dispatcher.js
// META: script=/common/utils.js
// META: script=/html/browsers/browsing-the-web/back-forward-cache/resources/rc-helper.js
// META: script=/html/browsers/browsing-the-web/remote-context-helper/resources/remote-context-helper.js

'use strict';

const RESPONSE_URL =
  '/html/browsers/browsing-the-web/back-forward-cache/resources/delayed-response.py';
const TIMEOUT_AFTER_PAGEHIDE_MS = 500;

promise_test(async t => {
  const uuid = token();
  t.add_cleanup(() => fetch(`${RESPONSE_URL}?uuid=${uuid}&release=1`));

  const rcHelper = new RemoteContextHelper();
  const rc1 = await rcHelper.addWindow(null, {features: 'noopener'});

  // The server sends the headers and half the body, then holds the rest
  // until released, which this test only does in cleanup. The timeout is set
  // from pagehide so that it can only elapse once the page is in BFCache.
  await rc1.executeScript((id, url, timeoutAfterPagehide) => {
    window.xhrEvents = [];
    window.pageHidden = false;
    window.pageShown = false;

    const xhr = new XMLHttpRequest();
    let sentAt;
    window.addEventListener('pagehide', e => {
      if (e.persisted) {
        window.pageHidden = true;
        xhr.timeout =
          Math.ceil(performance.now() - sentAt) + timeoutAfterPagehide;
      }
    });
    window.addEventListener('pageshow', e => {
      if (e.persisted) {
        window.pageShown = true;
      }
    });

    window.xhrDone = new Promise(resolve => {
      const record = e => {
        const phase = !window.pageHidden ? 'before-pagehide' :
                      !window.pageShown  ? 'in-bfcache' :
                                           'after-pageshow';
        window.xhrEvents.push({type: e.type, readyState: xhr.readyState, phase});
      };
      for (const type of ['readystatechange', 'load', 'error', 'abort',
                          'timeout']) {
        xhr.addEventListener(type, record);
      }
      xhr.addEventListener('loadend', e => {
        record(e);
        resolve();
      });
    });

    xhr.open('GET', `${url}?uuid=${id}&size=65536`);
    xhr.send();
    sentAt = performance.now();
  }, [uuid, RESPONSE_URL, TIMEOUT_AFTER_PAGEHIDE_MS]);

  await prepareForBFCache(rc1);
  const rc2 = await rc1.navigateToNew();

  // Stay away well past the timeout.
  await new Promise(resolve =>
    t.step_timeout(resolve, TIMEOUT_AFTER_PAGEHIDE_MS * 6));

  await rc2.historyBack();
  await assertImplementsBFCacheOptional(rc1);

  await rc1.executeScript(() => window.xhrDone);
  const events = await rc1.executeScript(() => window.xhrEvents);

  const inBFCache = events.filter(e => e.phase === 'in-bfcache');
  assert_array_equals(inBFCache.map(e => e.type), [],
    'No XHR events should fire while the page is in BFCache');

  const afterPageshow = events.filter(e => e.phase === 'after-pageshow');
  assert_array_equals(afterPageshow.map(e => e.type),
    ['readystatechange', 'timeout', 'loadend'],
    'The timeout should be reported after pageshow');
  assert_equals(afterPageshow[0].readyState, XMLHttpRequest.DONE,
    'readyState should be DONE after the timeout');
}, 'XHR timeout elapsing while in BFCache is reported after restore');
