// META: title=BFCache works with in-flight image load
// META: timeout=long
// META: script=/common/dispatcher/dispatcher.js
// META: script=/common/utils.js
// META: script=/html/browsers/browsing-the-web/back-forward-cache/resources/rc-helper.js
// META: script=/html/browsers/browsing-the-web/remote-context-helper/resources/remote-context-helper.js

'use strict';

promise_test(async t => {
  const uuid = token();
  const rcHelper = new RemoteContextHelper();
  const rc1 = await rcHelper.addWindow(null, {features: 'noopener'});

  // Add an <img> whose server response is held until we release it.
  await rc1.executeScript(id => {
    const img = document.createElement('img');
    img.src = `/html/browsers/browsing-the-web/back-forward-cache/resources/delayed-image.py?uuid=${id}`;
    document.body.appendChild(img);
  }, [uuid]);

  // Navigate away and back — the page should be restored from BFCache
  // even though the image request is still in flight.
  await assertBFCacheEligibility(rc1, /*shouldRestoreFromBFCache=*/ true);

  // Release the image so the server doesn't hang.
  await fetch(`/html/browsers/browsing-the-web/back-forward-cache/resources/delayed-image.py?uuid=${uuid}&release=1`);
}, 'Page with in-flight image load is eligible for BFCache');

promise_test(async () => {
  const uuid = token();
  const rcHelper = new RemoteContextHelper();
  const rc1 = await rcHelper.addWindow(null, {features: 'noopener'});

  // Add an <img> whose server response is held until we release it.
  await rc1.executeScript(id => {
    const img = document.createElement('img');
    img.src = `/html/browsers/browsing-the-web/back-forward-cache/resources/delayed-image.py?uuid=${id}`;
    document.body.appendChild(img);
  }, [uuid]);

  // Navigate away and back through BFCache.
  await prepareForBFCache(rc1);
  const rc2 = await rc1.navigateToNew();
  await rc2.historyBack();
  await assertImplementsBFCacheOptional(rc1);

  // Release the image response.
  await fetch(`/html/browsers/browsing-the-web/back-forward-cache/resources/delayed-image.py?uuid=${uuid}&release=1`);

  // Verify the image loaded successfully after restore.
  const loaded = await rc1.executeScript(() => {
    return new Promise((resolve, reject) => {
      const img = document.querySelector('img');
      if (img.complete && img.naturalWidth > 0) {
        resolve(true);
        return;
      }
      img.onload = () => resolve(true);
      img.onerror = () => reject(new Error('Image failed to load'));
    });
  });

  assert_true(loaded, 'Image should load after BFCache restore');
}, 'In-flight image completes after BFCache restore');
