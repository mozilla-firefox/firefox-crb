// META: title=A streamed fetch body continues after BFCache restore
// META: timeout=long
// META: script=/common/dispatcher/dispatcher.js
// META: script=/common/utils.js
// META: script=/html/browsers/browsing-the-web/back-forward-cache/resources/rc-helper.js
// META: script=/html/browsers/browsing-the-web/remote-context-helper/resources/remote-context-helper.js

'use strict';

// The page reads a fetch body through a stream reader. Part of the body
// arrives before the page enters BFCache and the rest while it is cached.
// After restore the reader must get the rest of the body, complete and in
// order.
//
// Whether a chunk can be delivered before pageshow is deliberately not
// checked: restoring a document makes it fully active in one task and fires
// pageshow in another, so tasks held while it was cached may run in between.

const RESPONSE_URL =
    '/html/browsers/browsing-the-web/back-forward-cache/resources/large-deferred-response.py';
const BODY_SIZE = 32 * 1024;

function makeExpectedBody(size) {
  const base = 'abcdefghijklmnopqrstuvwxyz';
  return base.repeat(Math.floor(size / base.length)) +
         base.slice(0, size % base.length);
}

promise_test(async t => {
  const ids = {uuid: token(), done: token()};
  const rcHelper = new RemoteContextHelper();
  const rc1 = await rcHelper.addWindow(null, {features: 'noopener'});

  await rc1.executeScript((url, size, ids) => {
    window.received = [];

    let notifyFirstChunk;
    window.firstChunk = new Promise(resolve => { notifyFirstChunk = resolve; });
    window.bodyDone = (async () => {
      const response = await fetch(
          `${url}?uuid=${ids.uuid}&done=${ids.done}&size=${size}`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const {done, value} = await reader.read();
        if (done) {
          break;
        }
        received.push(decoder.decode(value, {stream: true}));
        notifyFirstChunk();
      }
      return received.join('');
    })();
  }, [RESPONSE_URL, BODY_SIZE, ids]);

  // The server sends the first 80 bytes straight away.
  await rc1.executeScript(() => firstChunk);

  await prepareForBFCache(rc1);
  const rc2 = await rc1.navigateToNew();
  await fetch(`${RESPONSE_URL}?uuid=${ids.uuid}&done=${ids.done}&release=1`)
      .then(r => r.text());
  await rc2.historyBack();
  await assertImplementsBFCacheOptional(rc1);

  const body = await rc1.executeScript(() => bodyDone);
  assert_equals(body.length, BODY_SIZE, 'the whole body is read');
  assert_equals(body, makeExpectedBody(BODY_SIZE), 'the body is read in order');
}, 'A fetch body read through a stream continues after BFCache restore');
