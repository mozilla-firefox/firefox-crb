// META: global=window,worker
// META: script=/common/get-host-info.sub.js
// META: script=resources/webtransport-test-helpers.sub.js

// Tests for WebTransportWriter interface

promise_test(async t => {
  const wt = new WebTransport(webtransport_url('echo.py'));
  await wt.ready;

  const stream = await wt.createUnidirectionalStream();
  const writer = stream.getWriter();

  // Verify that getWriter() returns a WebTransportWriter
  assert_true(writer instanceof WritableStreamDefaultWriter);
  assert_true(writer instanceof WebTransportWriter);

  // WebTransportWriter extends WritableStreamDefaultWriter, so check for
  // the additional methods
  assert_true('atomicWrite' in writer,
              'writer should have atomicWrite method');
  assert_true('commit' in writer,
              'writer should have commit method');

  await writer.close();
}, 'WebTransportSendStream.getWriter() returns WebTransportWriter');

promise_test(async t => {
  const wt = new WebTransport(webtransport_url('echo.py'));
  await wt.ready;

  const stream = await wt.createBidirectionalStream();
  const writer = stream.writable.getWriter();

  // Verify methods exist on bidirectional stream writer too
  assert_true(writer instanceof WritableStreamDefaultWriter);
  assert_true(writer instanceof WebTransportWriter);
  assert_true('atomicWrite' in writer,
              'bidirectional stream writer should have atomicWrite method');
  assert_true('commit' in writer,
              'bidirectional stream writer should have commit method');

  await writer.close();
}, 'WebTransportWriter is returned from bidirectional stream getWriter()');

promise_test(async t => {
  const wt = new WebTransport(webtransport_url('echo.py'));
  await wt.ready;

  const stream = await wt.createUnidirectionalStream();
  const writer = stream.getWriter();

  const data = new Uint8Array([1, 2, 3, 4, 5]);

  // atomicWrite should return a Promise
  const promise = writer.atomicWrite(data);
  assert_true(promise instanceof Promise,
              'atomicWrite should return a Promise');

  await promise;
  await writer.close();

  // Echo handler should echo the data back
  const readable = wt.incomingUnidirectionalStreams;
  const stream_reader = readable.getReader();
  const { value: recv_stream } = await stream_reader.read();
  stream_reader.releaseLock();

  const reply = await read_stream(recv_stream);
  assert_equals(reply.length, 1, 'should receive one chunk');
  assert_array_equals(reply[0], data, 'echoed data should match');
}, 'unidirectional atomicWrite() writes data atomically');

promise_test(async t => {
  const wt = new WebTransport(webtransport_url('echo.py'));
  await wt.ready;

  const stream = await wt.createBidirectionalStream();
  const writer = stream.writable.getWriter();

  const data = new Uint8Array([1, 2, 3, 4, 5]);

  // atomicWrite should return a Promise
  const promise = writer.atomicWrite(data);
  assert_true(promise instanceof Promise,
              'atomicWrite should return a Promise');

  await promise;
  await writer.close();

  // Echo handler should echo the data back
  const reply = await read_stream(stream.readable);
  assert_equals(reply.length, 1, 'should receive one chunk');
  assert_array_equals(reply[0], data, 'echoed data should match');
}, 'bidirectional atomicWrite() writes data atomically');

promise_test(async t => {
  const wt = new WebTransport(webtransport_url('echo.py'));
  await wt.ready;

  const stream = await wt.createBidirectionalStream();
  const writer = stream.writable.getWriter();

  const data1 = new Uint8Array([1, 2, 3]);
  const data2 = new Uint8Array([4, 5, 6]);
  const data3 = new Uint8Array([7, 8, 9]);
  const data4 = new Uint8Array([10, 11, 12]);
  const result = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

  // Write multiple chunks atomically
  await writer.atomicWrite(data1);
  await writer.write(data2);
  await writer.atomicWrite(data3);
  await writer.write(data4);
  await writer.close();

  // Read the echoed data
  const reply = await read_stream(stream.readable);

  // Concatenate all received chunks
  let received = new Uint8Array(0);
  for (const chunk of reply) {
    const temp = new Uint8Array(received.length + chunk.length);
    temp.set(received);
    temp.set(chunk, received.length);
    received = temp;
  }

  assert_array_equals(received, result, 'All chunks should be in order');
}, 'Mixing atomicWrite() and write() calls maintain order');

promise_test(async t => {
  const wt = new WebTransport(webtransport_url('echo.py'));
  await wt.ready;

  const stream = await wt.createUnidirectionalStream();
  const writer = stream.getWriter();

  // Mix regular writes and atomic writes
  const data1 = new Uint8Array([1, 2, 3]);
  const data2 = new Uint8Array([4, 5, 6]);
  const data3 = new Uint8Array([7, 8, 9]);

  await writer.write(data1);
  await writer.atomicWrite(data2);
  await writer.write(data3);
  await writer.close();

  const readable = wt.incomingUnidirectionalStreams;
  const stream_reader = readable.getReader();
  const { value: recv_stream } = await stream_reader.read();
  stream_reader.releaseLock();

  const reply = await read_stream(recv_stream);

  // Should receive all data
  let total_length = 0;
  for (const chunk of reply) {
    total_length += chunk.length;
  }
  assert_equals(total_length, data1.length + data2.length + data3.length,
                'should receive all written data');
}, 'Regular write() and atomicWrite() can be mixed');

