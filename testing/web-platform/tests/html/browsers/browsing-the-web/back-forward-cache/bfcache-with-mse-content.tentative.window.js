// META: title=BFCache works with MSE content
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
      const mediaSource = new MediaSource();
      const video = document.createElement('video');
      video.src = URL.createObjectURL(mediaSource);
      document.body.appendChild(video);

      mediaSource.addEventListener('sourceopen', () => {
        const mime = 'video/mp4; codecs="mp4a.40.2,avc1.4d400d"';
        if (!MediaSource.isTypeSupported(mime)) {
          reject(new Error(mime + ' is not supported'));
          return;
        }
        const sourceBuffer = mediaSource.addSourceBuffer(mime);

        fetch('/media-source/mp4/test.mp4').then(r => r.arrayBuffer()).then(buf => {
          sourceBuffer.appendBuffer(buf);
          sourceBuffer.addEventListener('updateend', () => {
            mediaSource.endOfStream();
            resolve();
          }, {once: true});
        }, reject);
      }, {once: true});
    });
  });

  await assertBFCacheEligibility(rc1, /*shouldRestoreFromBFCache=*/ true);
}, 'Page with MSE content is eligible for BFCache');
