// META: global=window,worker
// META: script=/common/get-host-info.sub.js
// META: script=resources/webtransport-test-helpers.sub.js

// Tests for WebTransportWriter.commit(). commit() has no effect a test can
// observe, so these only check that it does not disturb the stream.

promise_test(async t => {
  const wt = new WebTransport(webtransport_url('echo.py'));
  await wt.ready;

  const stream = await wt.createUnidirectionalStream();
  const writer = stream.getWriter();

  // commit() should not throw
  writer.commit();

  // Should be able to write after commit
  const data = new Uint8Array([1, 2, 3]);
  await writer.write(data);
  await writer.close();

  const readable = wt.incomingUnidirectionalStreams;
  const stream_reader = readable.getReader();
  const { value: recv_stream } = await stream_reader.read();
  stream_reader.releaseLock();

  const reply = await read_stream(recv_stream);
  assert_equals(reply.length, 1, 'should receive one chunk');
  assert_array_equals(reply[0], data, 'echoed data should match');
}, 'commit() can be called on a writer');

promise_test(async t => {
  const wt = new WebTransport(webtransport_url('echo.py'));
  await wt.ready;

  const stream = await wt.createUnidirectionalStream();
  const writer = stream.getWriter();

  const data = new Uint8Array([1, 2, 3]);
  await writer.write(data);
  await writer.close();

  // commit() on a closed writer should not throw
  writer.commit();

  const readable = wt.incomingUnidirectionalStreams;
  const stream_reader = readable.getReader();
  const { value: recv_stream } = await stream_reader.read();
  stream_reader.releaseLock();

  const reply = await read_stream(recv_stream);
  assert_equals(reply.length, 1, 'should receive one chunk');
}, 'commit() on closed writer does not throw');

// Test that commit() sets [[CommittedOffset]] to [[BytesWritten]]
promise_test(async t => {
  const wt = new WebTransport(webtransport_url('echo.py'));
  await wt.ready;

  const stream = await wt.createUnidirectionalStream();
  const writer = stream.getWriter();

  // Write some data
  const data1 = new Uint8Array([1, 2, 3, 4, 5]);
  const data2 = new Uint8Array([6, 7, 8]);

  await writer.write(data1);
  await writer.write(data2);

  writer.commit();

  // Write more data after commit
  const data3 = new Uint8Array([9, 10]);
  await writer.write(data3);

  await writer.close();

  // Verify all data was received
  const readable = wt.incomingUnidirectionalStreams;
  const stream_reader = readable.getReader();
  const { value: recv_stream } = await stream_reader.read();
  stream_reader.releaseLock();

  const reply = await read_stream(recv_stream);

  let total_bytes = 0;
  for (const chunk of reply) {
    total_bytes += chunk.length;
  }
  assert_equals(total_bytes, 10, 'should receive all 10 bytes written');
}, 'commit() between writes does not disturb the data');

// Test that commit() is synchronous (doesn't return a promise)
promise_test(async t => {
  const wt = new WebTransport(webtransport_url('echo.py'));
  await wt.ready;

  const stream = await wt.createUnidirectionalStream();
  const writer = stream.getWriter();

  const data = new Uint8Array([1, 2, 3]);
  await writer.write(data);

  // commit() should return undefined, not a promise
  const result = writer.commit();
  assert_equals(result, undefined, 'commit() should return undefined');

  await writer.close();
}, 'commit() is synchronous and returns undefined');
