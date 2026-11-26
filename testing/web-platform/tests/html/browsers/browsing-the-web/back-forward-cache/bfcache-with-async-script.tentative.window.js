// META: title=BFCache works with in-flight async script
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
    const script = document.createElement('script');
    script.src =
      '/html/browsers/browsing-the-web/back-forward-cache/resources/slow.py?delayBeforeBody=60000';
    script.async = true;
    document.head.appendChild(script);
  });

  await assertBFCacheEligibility(rc1, /*shouldRestoreFromBFCache=*/ true);
}, 'Page with in-flight async script is eligible for BFCache');
