// META: title=BFCache reconnects to EventSource upon restore
// META: timeout=long
// META: script=/common/dispatcher/dispatcher.js
// META: script=/common/utils.js
// META: script=/html/browsers/browsing-the-web/back-forward-cache/resources/rc-helper.js
// META: script=/html/browsers/browsing-the-web/remote-context-helper/resources/remote-context-helper.js

'use strict';

promise_test(async () => {
  const uuid = token();
  const rcHelper = new RemoteContextHelper();
  const rc1 = await rcHelper.addWindow(null, {features: 'noopener'});

  // Open an EventSource, wait for the first message, record its
  // connectionId so we can compare after restore.
  await rc1.executeScript((id) => {
    window.esEvents = [];
    window.esErrors = [];
    window.pageHidden = false;
    window.pageShown = false;
    window.errorDuringBFCache = false;

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

    window.es = new EventSource(`/html/browsers/browsing-the-web/back-forward-cache/resources/eventsource.py?uuid=${id}`);
    return new Promise((resolve, reject) => {
      window.es.onmessage = (e) => {
        window.esEvents.push(e.data);
        if (window.esEvents.length >= 1) {
          resolve();
        }
      };
      window.es.onerror = () => {
        window.esErrors.push({
          duringBFCache: window.pageHidden && !window.pageShown,
          afterRestore: window.pageShown === true,
          readyState: window.es.readyState,
        });
        if (window.pageHidden && !window.pageShown) {
          window.errorDuringBFCache = true;
        }
        if (window.es.readyState === EventSource.CLOSED) {
          reject(new Error('EventSource connection failed'));
        }
      };
    });
  }, [uuid]);

  // Navigate away and back through BFCache.
  await prepareForBFCache(rc1);
  const rc2 = await rc1.navigateToNew();
  await rc2.historyBack();
  await assertImplementsBFCacheOptional(rc1);

  // No error events should have fired while the page was in BFCache.
  const errorDuringBFCache = await rc1.executeScript(
    () => window.errorDuringBFCache);
  assert_false(errorDuringBFCache,
    'EventSource error events must not fire while the page is in BFCache');

  // Wait for 10 new messages to arrive after restore.
  await rc1.executeScript(() => {
    const target = window.esEvents.length + 10;
    if (window.esEvents.length >= target) {
      return Promise.resolve();
    }
    return new Promise(resolve => {
      window.es.addEventListener('message', () => {
        if (window.esEvents.length >= target) {
          resolve();
        }
      });
    });
  });

  // The reconnection should have produced at least one error event (the
  // EventSource spec fires an error when the connection is lost, with
  // readyState CONNECTING, before it retries).  Verify:
  //   - every error fired after restore (not during BFCache),
  //   - readyState was CONNECTING (0), indicating a reconnect rather than
  //     a permanent failure.
  const errors = await rc1.executeScript(() => window.esErrors);
  assert_greater_than(errors.length, 0,
    'EventSource should have fired at least one error event during reconnection');
  for (const err of errors) {
    assert_false(err.duringBFCache,
      'Error events must not fire while the page is in BFCache');
    assert_equals(err.readyState, 0 /* CONNECTING */,
      'Error readyState should be CONNECTING (reconnecting), not CLOSED');
    assert_true(err.afterRestore,
      'Error event should fire after BFCache restore, not before entering');
  }

  // Every event has "connectionId=N", extract the IDs.
  const connectionIds = await rc1.executeScript(() => {
    return window.esEvents.map(
      d => parseInt(d.match(/connectionId=(\d+)/)[1]));
  });

  const firstId = connectionIds[0];
  const lastId = connectionIds[connectionIds.length - 1];
  assert_greater_than(lastId, firstId,
    'EventSource should report new connectionID after restore, since it reconnected.');
}, 'EventSource reconnects and produces events after BFCache restore');
