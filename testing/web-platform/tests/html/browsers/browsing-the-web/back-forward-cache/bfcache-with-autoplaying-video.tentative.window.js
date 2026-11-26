// META: title=BFCache works with autoplaying video
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
    return new Promise((resolve, reject) => {
      const video = document.createElement('video');
      video.muted = true;
      video.autoplay = true;
      video.src = '/media/white.mp4';
      video.onplaying = () => resolve();
      video.onerror = () => reject(new Error('Video playback failed'));
      document.body.appendChild(video);
    });
  });

  await assertBFCacheEligibility(rc1, /*shouldRestoreFromBFCache=*/ true);
}, 'Page with autoplaying video is eligible for BFCache');

promise_test(async t => {
  const rcHelper = new RemoteContextHelper();
  const rc1 = await rcHelper.addWindow(null, {features: 'noopener'});

  await rc1.executeScript(() => {
    return new Promise((resolve, reject) => {
      const video = document.createElement('video');
      video.muted = true;
      video.autoplay = true;
      video.src = '/media/white.mp4';
      video.onerror = () => reject(new Error('Video playback failed'));
      document.body.appendChild(video);

      video.addEventListener('timeupdate', function handler() {
        if (video.currentTime > 0.2) {
          video.removeEventListener('timeupdate', handler);
          window.__timeBeforeBFCache = video.currentTime;
          resolve();
        }
      });
    });
  });

  await prepareForBFCache(rc1);
  const rc2 = await rc1.navigateToNew();
  await rc2.historyBack();
  await assertImplementsBFCacheOptional(rc1);

  const result = await rc1.executeScript(() => {
    const video = document.querySelector('video');
    return {
      currentTime: video.currentTime,
      timeBeforeBFCache: window.__timeBeforeBFCache,
      paused: video.paused
    };
  });

  assert_greater_than_equal(result.currentTime, result.timeBeforeBFCache,
      'currentTime should be at or beyond where it was before BFCache');
}, 'Video currentTime is preserved after BFCache restore');
