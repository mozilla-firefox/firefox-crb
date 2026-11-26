// META: title=BFCache works with in-flight XHR
// META: timeout=long
// META: script=/common/dispatcher/dispatcher.js
// META: script=/common/utils.js
// META: script=/html/browsers/browsing-the-web/back-forward-cache/resources/rc-helper.js
// META: script=/html/browsers/browsing-the-web/remote-context-helper/resources/remote-context-helper.js

'use strict';

promise_test(async t => {
  const rcHelper = new RemoteContextHelper();
  const rc1 = await rcHelper.addWindow(null, {features: 'noopener'});

  await rc1.executeScript(() => {
    return new Promise(resolve => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET',
        '/html/browsers/browsing-the-web/back-forward-cache/resources/slow.py?delayBeforeBody=60000');
      xhr.onloadstart = () => resolve();
      xhr.send();
    });
  });

  await assertBFCacheEligibility(rc1, /*shouldRestoreFromBFCache=*/ true);
}, 'Page with in-flight XHR is eligible for BFCache');
