// META: title=BFCache works with open EventSource connection
// META: timeout=long
// META: script=/common/dispatcher/dispatcher.js
// META: script=/common/utils.js
// META: script=/html/browsers/browsing-the-web/back-forward-cache/resources/rc-helper.js
// META: script=/html/browsers/browsing-the-web/remote-context-helper/resources/remote-context-helper.js

'use strict';

promise_test(async () => {
  const rcHelper = new RemoteContextHelper();
  const rc1 = await rcHelper.addWindow(null, {features: 'noopener'});

  // Open an EventSource and wait for it to connect.
  await rc1.executeScript(() => {
    return new Promise((resolve, reject) => {
      const es = new EventSource('/eventsource/resources/message2.py');
      es.onopen = () => resolve();
      es.onerror = () => reject(new Error('EventSource connection failed'));
    });
  });

  await assertBFCacheEligibility(rc1, /*shouldRestoreFromBFCache=*/ true);
}, 'Page with open EventSource is eligible for BFCache');

promise_test(async () => {
  const rcHelper = new RemoteContextHelper();
  const rc1 = await rcHelper.addWindow(null, {features: 'noopener'});

  // Open an EventSource, wait for connection, then record how many
  // messages we've seen so we can detect new ones after restore.
  await rc1.executeScript(() => {
    return new Promise((resolve, reject) => {
      window.esMessageCount = 0;
      window.es = new EventSource('/eventsource/resources/message2.py');
      window.es.onopen = () => resolve();
      window.es.onerror = () => reject(new Error('EventSource connection failed'));
      window.es.onmessage = () => { window.esMessageCount++; };
    });
  });

  // Navigate away and back through BFCache.
  await prepareForBFCache(rc1);
  const rc2 = await rc1.navigateToNew();
  await rc2.historyBack();
  await assertImplementsBFCacheOptional(rc1);

  // Record the message count right after restore, then wait for at least
  // one new message (i.e. the EventSource reconnected).
  const countAfterRestore = await rc1.executeScript(() => {
    return window.esMessageCount;
  });

  await rc1.executeScript((baseline) => {
    if (window.esMessageCount > baseline) {
      return Promise.resolve();
    }
    return new Promise(resolve => {
      window.es.addEventListener('message', function handler() {
        if (window.esMessageCount > baseline) {
          window.es.removeEventListener('message', handler);
          resolve();
        }
      });
    });
  }, [countAfterRestore]);
}, 'EventSource produces events after BFCache restore');
