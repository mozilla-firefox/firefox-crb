// META: global=window,worker
// META: script=/common/get-host-info.sub.js
// META: script=resources/webtransport-test-helpers.sub.js

// Advanced tests for WebTransportWriter atomicWrite and commit.
//
// QUIC streams are byte-oriented: atomicWrite() is atomic with respect to flow
// control only, and does not preserve chunk boundaries for the receiver.
// commit() has no effect a test can observe, so these tests only check that it
// does not disturb the stream.

function flatten_u8(chunks, total = 0) {
  if (!total) for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

async function first(stream) {
  for await (const chunk of stream.values({ preventCancel: true })) return chunk;
}

promise_test(async t => {
  const wt = new WebTransport(webtransport_url('echo.py'));
  await wt.ready;

  const stream = await wt.createBidirectionalStream();
  const writer = stream.writable.getWriter();

  const data1 = new Uint8Array([1, 2, 3]);
  const data2 = new Uint8Array([4, 5, 6]);
  const data3 = new Uint8Array([7, 8, 9]);

  // Queue multiple atomic writes
  // All should complete successfully
  await Promise.all([writer.atomicWrite(data1),
                     writer.atomicWrite(data2),
                     writer.atomicWrite(data3)]);
  await writer.close();

  const received = flatten_u8(await read_stream(stream.readable));

  // All data should be received in correct order
  const expected = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert_array_equals(received, expected, 'all data should be received in order');
}, 'Multiple concurrent atomicWrite calls complete successfully');

promise_test(async t => {
  const wt = new WebTransport(webtransport_url('echo.py'));
  await wt.ready;

  const stream = await wt.createUnidirectionalStream();
  const writer = stream.getWriter();

  // An empty Uint8Array is a valid BufferSource per spec; atomicWrite must
  // resolve rather than reject.
  const emptyData = new Uint8Array(0);
  await writer.atomicWrite(emptyData);

  await writer.close();
}, 'atomicWrite() accepts empty ArrayBuffer');

promise_test(async t => {
  const wt = new WebTransport(webtransport_url('echo.py'));
  await wt.ready;

  const stream = await wt.createUnidirectionalStream();
  const writer = stream.getWriter();

  // Test atomicWrite followed by regular write
  const atomicData = new Uint8Array([1, 2, 3, 4, 5]);
  const regularData = new Uint8Array([6, 7, 8, 9, 10]);

  await Promise.all([
    writer.atomicWrite(atomicData),
    writer.write(regularData),
    writer.close()
  ]);

  const recv_stream = await first(wt.incomingUnidirectionalStreams);

  const total = flatten_u8(await read_stream(recv_stream));

  assert_equals(total.length, atomicData.length + regularData.length,
                'should receive all data');
}, 'atomicWrite followed by regular write preserves all data');

promise_test(async t => {
  const wt = new WebTransport(webtransport_url('echo.py'));
  await wt.ready;

  const stream = await wt.createBidirectionalStream();
  const writer = stream.writable.getWriter();

  // Interleaved atomic and regular writes arrive in order.
  const data1 = new Uint8Array([1, 2]);
  const data2 = new Uint8Array([3, 4]);
  const data3 = new Uint8Array([5, 6]);
  const data4 = new Uint8Array([7, 8]);

  await Promise.all([
    writer.write(data1),
    writer.atomicWrite(data2).then(() => writer.commit()),
    writer.write(data3),
    writer.write(data4),
    writer.close()
  ]);

  const reply = await read_stream(stream.readable);
  assert_array_equals(flatten_u8(reply), [1, 2, 3, 4, 5, 6, 7, 8],
                      'all data should be received in order');
}, 'Interleaved write, atomicWrite, and commit deliver all data in order');

promise_test(async t => {
  const wt = new WebTransport(webtransport_url('echo.py'));
  await wt.ready;

  const stream = await wt.createUnidirectionalStream();
  const writer = stream.getWriter();

  // Release the lock
  writer.releaseLock();

  // atomicWrite on released writer should throw
  const data = new Uint8Array([1, 2, 3]);
  await promise_rejects_js(t, TypeError,
                           writer.atomicWrite(data),
                           'atomicWrite on released writer should throw');
}, 'atomicWrite fails on released writer');

promise_test(async t => {
  const wt = new WebTransport(webtransport_url('echo.py'));
  t.add_cleanup(() => wt.close());
  await wt.ready;

  const stream = await wt.createUnidirectionalStream();
  const writer = stream.getWriter();

  const data = new Uint8Array([1, 2, 3]);

  // Queue several atomic writes without awaiting so they are pending
  const writes = [];
  for (let i = 0; i < 5; i++) {
    writes.push(writer.atomicWrite(data));
  }

  // Abort with an explicit reason; per spec all pending write requests
  // (including atomicWrite requests) must be rejected with that reason.
  const reason = new DOMException('test abort', 'AbortError');
  await writer.abort(reason);

  // ALL pending atomicWrite promises must be rejected, not just some
  const results = await Promise.allSettled(writes);
  for (const [i, result] of results.entries()) {
    assert_equals(result.status, 'rejected',
      `atomicWrite[${i}] should be rejected`);
    assert_equals(result.reason, reason,
      `atomicWrite[${i}] should be rejected with the abort reason`);
  }
}, 'abort() rejects all pending atomicWrite requests with the abort reason');

// Test that atomicWrite() respects WritableStream backpressure
promise_test(async t => {
  const wt = new WebTransport(webtransport_url('echo.py'));
  await wt.ready;

  const stream = await wt.createUnidirectionalStream();
  const writer = stream.getWriter();

  // Queue multiple atomic writes to trigger backpressure
  const promises = [];
  const numWrites = 10;

  for (let i = 0; i < numWrites; i++) {
    const data = new Uint8Array([i]);
    promises.push(writer.atomicWrite(data));
  }

  // Wait for all writes to complete
  await Promise.all(promises);
  await writer.close();

  // Verify all writes succeeded
  const readable = wt.incomingUnidirectionalStreams;
  const stream_reader = readable.getReader();
  const { value: recv_stream } = await stream_reader.read();
  stream_reader.releaseLock();

  const reply = await read_stream(recv_stream);

  // Should receive all written chunks
  let total_bytes = 0;
  for (const chunk of reply) {
    total_bytes += chunk.length;
  }
  assert_equals(total_bytes, numWrites, 'should receive all atomic write data');
}, 'Many queued atomicWrite() calls all complete');

// Test that atomicWrite() is properly serialized with regular writes
promise_test(async t => {
  const wt = new WebTransport(webtransport_url('echo.py'));
  await wt.ready;

  const stream = await wt.createUnidirectionalStream();
  const writer = stream.getWriter();

  // Mix atomicWrite and regular write calls
  const writes = [];
  for (let i = 0; i < 5; i++) {
    if (i % 2 === 0) {
      writes.push({ type: 'regular', data: new Uint8Array([i]) });
    } else {
      writes.push({ type: 'atomic', data: new Uint8Array([i]) });
    }
  }

  // Execute writes - if atomicWrite goes through pipeline, order is preserved
  const promises = [];
  for (const write of writes) {
    if (write.type === 'atomic') {
      promises.push(writer.atomicWrite(write.data));
    } else {
      promises.push(writer.write(write.data));
    }
  }

  await Promise.all(promises);
  await writer.close();

  // Verify order is preserved
  const readable = wt.incomingUnidirectionalStreams;
  const stream_reader = readable.getReader();
  const { value: recv_stream } = await stream_reader.read();
  stream_reader.releaseLock();

  const reply = await read_stream(recv_stream);

  // Concatenate received data
  let received = new Uint8Array(0);
  for (const chunk of reply) {
    const temp = new Uint8Array(received.length + chunk.length);
    temp.set(received);
    temp.set(chunk, received.length);
    received = temp;
  }

  // Check that data is in correct order (0, 1, 2, 3, 4)
  assert_equals(received.length, 5, 'should receive 5 bytes');
  for (let i = 0; i < 5; i++) {
    assert_equals(received[i], i, `byte ${i} should be ${i}`);
  }
}, 'atomicWrite() is properly serialized with regular writes through pipeline');

// Per WritableStream spec, abort() rejects all pending write requests
// (both atomic and regular) with the abort reason.
promise_test(async t => {
  const wt = new WebTransport(webtransport_url('echo.py'));
  t.add_cleanup(() => wt.close());
  await wt.ready;

  const stream = await wt.createUnidirectionalStream();
  const writer = stream.getWriter();

  const atomicPromise = writer.atomicWrite(new Uint8Array([1, 2, 3]));
  const regularPromise = writer.write(new Uint8Array([4, 5, 6]));

  const abortPromise = writer.abort(new DOMException('test abort', 'AbortError'));

  await promise_rejects_dom(t, 'AbortError', atomicPromise,
                            'atomic write should be aborted');
  await promise_rejects_dom(t, 'AbortError', regularPromise,
                            'regular write should be aborted');

  await abortPromise;

  // Per WritableStream spec, writes to an errored stream are rejected
  // with the stream's stored error (the abort reason).
  await promise_rejects_dom(t, 'AbortError', writer.write(new Uint8Array([7])),
                            'write after abort should fail');
}, 'abort() with interleaved atomic/non-atomic writes rejects all pending writes');
