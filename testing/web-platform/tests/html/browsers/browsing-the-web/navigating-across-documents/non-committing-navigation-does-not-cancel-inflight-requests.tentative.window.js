// META: title=Non-committing navigations do not cancel in-flight requests
// META: timeout=long
// META: script=/common/utils.js
// META: script=/html/browsers/browsing-the-web/navigating-across-documents/resources/pending-navigation-helpers.js

'use strict';

// A navigation that never commits -- an HTTP 204, or a response with
// Content-Disposition: attachment -- leaves the document that started it on
// screen. Its in-flight requests must survive and complete normally.
//
// Unlike the back-forward-cache tests for the same behaviour, this drives an
// iframe directly, so the document that must not be replaced can be observed
// from the outside rather than inferred.
//
// Tentative: https://html.spec.whatwg.org/#navigate step 24.3 currently aborts
// the active document before the navigation's fetch has even begun, which
// cancels them. See https://github.com/whatwg/html/issues/4489.

const BLANK = '/common/blank.html';

function withIframe(t) {
  const iframe = document.createElement('iframe');
  t.add_cleanup(() => iframe.remove());
  document.body.append(iframe);
  return new Promise(resolve => {
    iframe.addEventListener('load', () => resolve(iframe), {once: true});
    iframe.src = BLANK;
  });
}

// Navigates |iframe| to a held response of |kind| that does not commit. The
// browser gives no signal once it has dropped such a navigation, so wait a
// little after the response was sent, otherwise the in-flight request could
// complete before the navigation is dropped and the test pass vacuously.
async function navigateWithoutCommitting(t, iframe, kind) {
  const navigation = heldRequest(t, kind);
  iframe.contentWindow.location.href = navigation.url;
  await navigation.waitForRequest();
  await navigation.release();
  await timeout(t, 500);
  assert_equals(iframe.contentWindow.location.pathname, BLANK,
                'the iframe should still be showing the original document');
}

promise_test(async t => {
  const iframe = await withIframe(t);
  const bodyRequest = heldRequest(t, 'script');
  const body =
      iframe.contentWindow.fetch(bodyRequest.url).then(response => response.text());
  await bodyRequest.waitForRequest();

  await navigateWithoutCommitting(t, iframe, 'no-content');

  await bodyRequest.release();
  assert_equals(await body, SCRIPT_BODY, 'fetch() should resolve with the complete body');
}, 'In-flight fetch() survives an HTTP 204 navigation');

promise_test(async t => {
  const iframe = await withIframe(t);
  const child = iframe.contentDocument.createElement('iframe');
  await new Promise(resolve => {
    child.addEventListener('load', resolve, {once: true});
    child.src = BLANK;
    iframe.contentDocument.body.append(child);
  });
  const bodyRequest = heldRequest(t, 'script');
  const body =
      child.contentWindow.fetch(bodyRequest.url).then(response => response.text());
  await bodyRequest.waitForRequest();

  await navigateWithoutCommitting(t, iframe, 'no-content');
  assert_true(child.isConnected, 'the child iframe should still be in the document');

  await bodyRequest.release();
  assert_equals(await body, SCRIPT_BODY, 'fetch() should resolve with the complete body');
}, 'In-flight fetch() in a child iframe survives an HTTP 204 navigation of its parent');

promise_test(async t => {
  const iframe = await withIframe(t);
  const bodyRequest = heldRequest(t, 'script');
  const events = [];
  const xhr = new iframe.contentWindow.XMLHttpRequest();
  const done = new Promise((resolve, reject) => {
    for (const name of ['loadstart', 'abort', 'error', 'load', 'loadend']) {
      xhr.addEventListener(name, () => events.push(name));
    }
    xhr.addEventListener('load', () => resolve(xhr.responseText));
    xhr.addEventListener('error', () => reject(new Error('XHR error')));
    xhr.addEventListener('abort', () => reject(new Error('XHR abort')));
  });
  xhr.open('GET', bodyRequest.url);
  xhr.send();
  await bodyRequest.waitForRequest();

  await navigateWithoutCommitting(t, iframe, 'attachment');
  assert_false(events.includes('abort'), 'XHR should not have been aborted');
  assert_false(events.includes('error'), 'XHR should not have errored');

  await bodyRequest.release();
  assert_equals(await done, SCRIPT_BODY, 'XHR should complete with the full body');
}, 'In-flight XMLHttpRequest survives a Content-Disposition: attachment navigation');
