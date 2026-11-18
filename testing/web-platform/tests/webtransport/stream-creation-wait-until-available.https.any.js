// META: global=window,worker
// META: script=/common/get-host-info.sub.js
// META: script=resources/webtransport-test-helpers.sub.js
// META: timeout=long

// Test that waitUntilAvailable option controls behavior when stream quota is exhausted

promise_test(async t => {
  const wt = new WebTransport(webtransport_url('echo.py'));
  t.add_cleanup(() => wt.close());
  await wt.ready;

  // Create a bidirectional stream with waitUntilAvailable set to true
  const stream = await wt.createBidirectionalStream({ waitUntilAvailable: true });
  assert_not_equals(stream, null);

  // Close the stream
  const writer = stream.writable.getWriter();
  await writer.close();
}, 'first createBidirectionalStream should succeed asap even with waitUntilAvailable=true');

promise_test(async t => {
  const wt = new WebTransport(webtransport_url('echo.py'));
  t.add_cleanup(() => wt.close());
  await wt.ready;

  // Create a unidirectional stream with waitUntilAvailable set to true
  const stream = await wt.createUnidirectionalStream({ waitUntilAvailable: true });
  assert_not_equals(stream, null);

  // Close the stream
  const writer = stream.getWriter();
  await writer.close();
}, 'createUnidirectionalStream with waitUntilAvailable=true should succeed when quota available');

// NOTE: Bidirectional stream quota exhaustion tests are not included here because
// the aioquic-based test server (echo.py) dynamically sends MAX_STREAMS frames to
// increase the bidirectional stream limit as streams are created. This is standard
// QUIC flow control behavior, but it makes reliable testing of quota exhaustion
// impossible for bidirectional streams. The server's quota management responds to
// bidirectional stream handshaking and increases limits faster than tests can
// exhaust them. Unidirectional streams exhibit more predictable quota behavior
// and can be reliably tested below.

promise_test(async t => {
  const wt = new WebTransport(webtransport_url('echo.py'));
  t.add_cleanup(() => wt.close());
  await wt.ready;

  // Create streams until we hit the quota limit
  const streams = [];
  let quotaExhausted = false;

  // Create initial streams to exhaust quota
  // Typical implementations have limits of 100-128, choose a number well over that
  for (let i = 0; i < 400; i++) {
    try {
      const stream = await wt.createUnidirectionalStream();
      streams.push(stream);
    } catch (e) {
      // Should get QuotaExceededError when quota is exhausted.
      // Note: assert_throws_quotaexceedederror() requires the QuotaExceededError
      // interface (requested/quota), which Firefox does not implement yet, so
      // check the name directly.
      assert_equals(e.name, 'QuotaExceededError');
      quotaExhausted = true;
      break;
    }
  }
  assert_true(quotaExhausted, 'Should have exhausted stream quota with waitUntilAvailable = false (default)');

  // Test that waitUntilAvailable=true queues the request and resolves when quota becomes available
  const waitingStreamPromise = wt.createUnidirectionalStream({ waitUntilAvailable: true });
  try {
    await wt.createUnidirectionalStream(); // Not waitUntilAvailable=true!
    assert_unreached('Expected createUnidirectionalStream to fail when quota exhausted');
  } catch (e) {
    assert_equals(e.name, 'QuotaExceededError', 'creating stream rejected properly when blocked');
  }

  let promiseSettled = false;
  waitingStreamPromise.finally(() => promiseSettled = true);
  // .finally() callbacks run as a microtask, so checking promiseSettled
  // synchronously would pass trivially even if the promise had already
  // settled. Flush past a task boundary before checking.
  await new Promise(resolve => step_timeout(resolve, 0));
  assert_false(promiseSettled, 'Promise should be pending while quota is exhausted');

  // Close streams to free up quota
  await Promise.all(streams.map(stream => stream.close()));

  // The waiting stream should now succeed
  const waitingStream = await waitingStreamPromise;
  assert_not_equals(waitingStream, null, 'Waiting stream should resolve after quota becomes available');

  // Clean up
  await waitingStream.close();
}, 'createUnidirectionalStream with waitUntilAvailable=true queues request when quota exhausted');
