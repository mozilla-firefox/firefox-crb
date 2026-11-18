// META: global=window,worker
// META: script=/common/get-host-info.sub.js
// META: script=resources/webtransport-test-helpers.sub.js

// Tests for WebTransportSendStream.getStats(), WebTransportReceiveStream.getStats(),
// and WebTransportSendGroup.getStats().

// --- WebTransportSendStream.getStats() ---

promise_test(async t => {
  const wt = new WebTransport(webtransport_url('echo.py'));
  t.add_cleanup(() => wt.close());
  await wt.ready;

  const stream = await wt.createUnidirectionalStream();
  const p = stream.getStats();
  assert_true(p instanceof Promise, 'getStats() must return a Promise');
  const stats = await p;

  assert_true('bytesWritten' in stats, 'bytesWritten must be present');
  assert_true('bytesSent' in stats, 'bytesSent must be present');
  assert_true('bytesAcknowledged' in stats, 'bytesAcknowledged must be present');
  assert_greater_than_equal(stats.bytesWritten, 0, 'bytesWritten >= 0');
  assert_greater_than_equal(stats.bytesSent, 0, 'bytesSent >= 0');
  assert_greater_than_equal(stats.bytesAcknowledged, 0, 'bytesAcknowledged >= 0');
}, 'WebTransportSendStream.getStats() returns a valid stats object');

promise_test(async t => {
  const wt = new WebTransport(webtransport_url('echo.py'));
  t.add_cleanup(() => wt.close());
  await wt.ready;

  const stream = await wt.createUnidirectionalStream();
  const writer = stream.getWriter();
  const dataSize = 1000;
  await writer.write(new Uint8Array(dataSize).fill(42));

  const stats = await stream.getStats();
  assert_equals(stats.bytesWritten, dataSize,
                'bytesWritten must equal bytes passed to write()');
  // bytesSent may lag bytesWritten if not all data has been transmitted yet
  assert_less_than_equal(stats.bytesSent, stats.bytesWritten,
                         'bytesSent <= bytesWritten');
  assert_less_than_equal(stats.bytesAcknowledged, stats.bytesSent,
                         'bytesAcknowledged <= bytesSent');
}, 'WebTransportSendStream.getStats() tracks bytes written by the application');

promise_test(async t => {
  const wt = new WebTransport(webtransport_url('echo.py'));
  t.add_cleanup(() => wt.close());
  await wt.ready;

  const stream = await wt.createUnidirectionalStream();
  const writer = stream.getWriter();

  const stats1 = await stream.getStats();
  await writer.write(new Uint8Array(500).fill(1));
  const stats2 = await stream.getStats();
  const p = writer.write(new Uint8Array(250).fill(2));
  await writer.write(new Uint8Array(250).fill(2));
  const stats3 = await stream.getStats();
  await p;

  assert_greater_than_equal(stats2.bytesWritten, stats1.bytesWritten,
                            'bytesWritten must not decrease');
  assert_greater_than_equal(stats3.bytesWritten, stats2.bytesWritten,
                            'bytesWritten must not decrease');
  assert_equals(stats3.bytesWritten, 1000,
                'bytesWritten must equal cumulative bytes written');
  // bytesSent and bytesAcknowledged must also be non-decreasing
  assert_greater_than_equal(stats2.bytesSent, stats1.bytesSent,
                            'bytesSent must not decrease');
  assert_greater_than_equal(stats3.bytesSent, stats2.bytesSent,
                            'bytesSent must not decrease');
}, 'WebTransportSendStream.getStats() bytesWritten is monotonically non-decreasing');

promise_test(async t => {
  const wt = new WebTransport(webtransport_url('echo.py'));
  t.add_cleanup(() => wt.close());
  await wt.ready;

  const stream = await wt.createUnidirectionalStream();
  const writer = stream.getWriter();

  // The first call must not pin bytesSent: it has to keep following the
  // network as more data goes out.
  const stats1 = await stream.getStats();
  const dataSize = 1000;
  await writer.write(new Uint8Array(dataSize).fill(7));

  let stats;
  do {
    await new Promise(resolve => t.step_timeout(resolve, 50));
    stats = await stream.getStats();
  } while (stats.bytesSent < dataSize);

  assert_greater_than(stats.bytesSent, stats1.bytesSent,
                      'bytesSent must advance past the first reading');
}, 'WebTransportSendStream.getStats() bytesSent advances after the first call');

// --- WebTransportReceiveStream.getStats() ---

promise_test(async t => {
  const wt = new WebTransport(webtransport_url('echo.py'));
  t.add_cleanup(() => wt.close());
  await wt.ready;

  // The readable side of a bidirectional stream is a WebTransportReceiveStream
  const {readable} = await wt.createBidirectionalStream();
  const p = readable.getStats();
  assert_true(p instanceof Promise, 'getStats() must return a Promise');
  const stats = await p;

  assert_true('bytesReceived' in stats, 'bytesReceived must be present');
  assert_true('bytesRead' in stats, 'bytesRead must be present');
  assert_greater_than_equal(stats.bytesReceived, 0, 'bytesReceived >= 0');
  assert_greater_than_equal(stats.bytesRead, 0, 'bytesRead >= 0');
}, 'WebTransportReceiveStream.getStats() returns a valid stats object');

promise_test(async t => {
  // stats-data-transfer.py creates a bidi stream and sends 5000 bytes then closes it
  const wt = new WebTransport(webtransport_url('stats-data-transfer.py'));
  t.add_cleanup(() => wt.close());
  await wt.ready;

  const streams = wt.incomingBidirectionalStreams.getReader();
  const {value: {readable}, done} = await streams.read();
  assert_false(done, 'the server must open a stream');

  let totalBytesRead = 0;
  for await (const chunk of readable) {
    totalBytesRead += chunk.length;
  }

  const stats = await readable.getStats();
  assert_equals(stats.bytesRead, totalBytesRead,
                'bytesRead must equal bytes consumed by the application');
  assert_greater_than_equal(stats.bytesReceived, stats.bytesRead,
                            'bytesReceived >= bytesRead');
  assert_greater_than(stats.bytesRead, 0,
                      'bytesRead must be positive after reading data');
}, 'WebTransportReceiveStream.getStats() tracks bytes read by the application');

promise_test(async t => {
  // stats-data-transfer.py sends 5000 bytes then closes the stream. Read a
  // single 100-byte BYOB chunk and let the rest arrive without reading it, to
  // verify bytesRead counts what the application consumed rather than
  // everything the transport received.
  // See https://w3c.github.io/webtransport/#receive-stream-stats.
  const CHUNK_SIZE = 100;
  const wt = new WebTransport(webtransport_url('stats-data-transfer.py'));
  t.add_cleanup(() => wt.close());
  await wt.ready;

  const streams = wt.incomingBidirectionalStreams.getReader();
  const {value: {readable}, done} = await streams.read();
  assert_false(done, 'the server must open a stream');

  const reader = readable.getReader({mode: 'byob'});
  // A BYOB read is capped by the view, but may return less if that much has
  // not arrived yet.
  const {value} = await reader.read(new Uint8Array(CHUNK_SIZE));
  assert_between_inclusive(value.length, 1, CHUNK_SIZE,
                           'BYOB read is bounded by the view');

  // Poll until bytesReceived reflects the full transfer (the wire-level FIN
  // has been processed), without reading any further.
  let stats;
  for (let i = 0; i < 50; i++) {
    stats = await readable.getStats();
    if (stats.bytesReceived >= 5000) {
      break;
    }
    await wait(50);
  }

  assert_equals(stats.bytesReceived, 5000,
                'bytesReceived must reflect the full transfer');
  assert_equals(stats.bytesRead, value.length,
                'bytesRead must only count what the application read');
}, 'WebTransportReceiveStream.getStats() does not conflate bytesRead with ' +
   'bytesReceived');

promise_test(async t => {
  const wt = new WebTransport(webtransport_url('stats-data-transfer.py'));
  t.add_cleanup(() => wt.close());
  await wt.ready;

  const streams = wt.incomingBidirectionalStreams.getReader();
  const {value: {readable}, done} = await streams.read();
  assert_false(done, 'the server must open a stream');

  const stats1 = await readable.getStats();

  // Not an async iterator: breaking out of one would cancel the stream.
  const reader = readable.getReader();
  const {value: chunk} = await reader.read();
  reader.releaseLock();

  const stats2 = await readable.getStats();

  assert_greater_than_equal(stats2.bytesRead, stats1.bytesRead,
                            'bytesRead must not decrease');
  assert_greater_than_equal(stats2.bytesReceived, stats1.bytesReceived,
                            'bytesReceived must not decrease');
  assert_greater_than_equal(stats2.bytesRead, chunk.length,
                            'bytesRead must be at least the chunk size after reading');
}, 'WebTransportReceiveStream.getStats() is monotonically non-decreasing');

promise_test(async t => {
  const wt = new WebTransport(webtransport_url('echo.py'));
  t.add_cleanup(() => wt.close());
  await wt.ready;

  const bidi = await wt.createBidirectionalStream();
  const receiveStream = bidi.readable;

  // No data has been sent, so no bytes should have been received or read
  const stats = await receiveStream.getStats();
  assert_equals(stats.bytesReceived, 0,
                'bytesReceived must be 0 when no data has been received');
  assert_equals(stats.bytesRead, 0,
                'bytesRead must be 0 when no data has been read');
}, 'WebTransportReceiveStream.getStats() returns zero stats before any data arrives');

// --- WebTransportSendGroup.getStats() ---

promise_test(async t => {
  const wt = new WebTransport(webtransport_url('echo.py'));
  t.add_cleanup(() => wt.close());
  await wt.ready;

  const sendGroup = wt.createSendGroup();
  const p = sendGroup.getStats();
  assert_true(p instanceof Promise, 'getStats() must return a Promise');
  const stats = await p;

  assert_true('bytesWritten' in stats, 'bytesWritten must be present');
  assert_true('bytesSent' in stats, 'bytesSent must be present');
  assert_true('bytesAcknowledged' in stats, 'bytesAcknowledged must be present');
  // An empty group contains no streams, so all stats must be zero
  assert_equals(stats.bytesWritten, 0, 'empty group bytesWritten == 0');
  assert_equals(stats.bytesSent, 0, 'empty group bytesSent == 0');
  assert_equals(stats.bytesAcknowledged, 0, 'empty group bytesAcknowledged == 0');
}, 'WebTransportSendGroup.getStats() returns zero stats for an empty group');

promise_test(async t => {
  const wt = new WebTransport(webtransport_url('echo.py'));
  t.add_cleanup(() => wt.close());
  await wt.ready;

  const sendGroup = wt.createSendGroup();
  const stream1 = await wt.createUnidirectionalStream({ sendGroup });
  const stream2 = await wt.createUnidirectionalStream({ sendGroup });

  const writer1 = stream1.getWriter();
  const writer2 = stream2.getWriter();
  await Promise.all([
    writer1.write(new Uint8Array(300).fill(1)),
    writer2.write(new Uint8Array(700).fill(2)),
  ]);

  const stream1Stats = await stream1.getStats();
  const stream2Stats = await stream2.getStats();

  const stats = await sendGroup.getStats();
  // Group stats must aggregate bytesWritten, bytesSent and bytesAcknowledged
  // from all streams in the group, not just bytesWritten.
  assert_equals(stats.bytesWritten, 1000,
                'group bytesWritten must sum all streams in the group');
  // bytesSent and bytesAcknowledged keep advancing, so the group's values,
  // read after the per-stream ones, cannot be smaller than their sum.
  assert_greater_than_equal(
      stats.bytesSent, stream1Stats.bytesSent + stream2Stats.bytesSent,
      'group bytesSent must cover all streams in the group');
  assert_greater_than_equal(
      stats.bytesAcknowledged,
      stream1Stats.bytesAcknowledged + stream2Stats.bytesAcknowledged,
      'group bytesAcknowledged must cover all streams in the group');
  assert_less_than_equal(stats.bytesSent, stats.bytesWritten,
                         'bytesSent <= bytesWritten');
  assert_less_than_equal(stats.bytesAcknowledged, stats.bytesSent,
                         'bytesAcknowledged <= bytesSent');
}, 'WebTransportSendGroup.getStats() aggregates stats from all grouped streams');

promise_test(async t => {
  const wt = new WebTransport(webtransport_url('echo.py'));
  t.add_cleanup(() => wt.close());
  await wt.ready;

  const sendGroup = wt.createSendGroup();
  const inGroup = await wt.createUnidirectionalStream({ sendGroup });
  const outGroup = await wt.createUnidirectionalStream(); // no sendGroup

  const writerIn = inGroup.getWriter();
  const writerOut = outGroup.getWriter();
  await writerIn.write(new Uint8Array(500).fill(1));
  await writerOut.write(new Uint8Array(500).fill(2));

  const stats = await sendGroup.getStats();
  // Only the stream in the group must be counted
  assert_equals(stats.bytesWritten, 500,
                'group stats must only count streams in the group');
}, 'WebTransportSendGroup.getStats() excludes streams not in the group');

promise_test(async t => {
  const wt = new WebTransport(webtransport_url('echo.py'));
  t.add_cleanup(() => wt.close());
  await wt.ready;

  const sendGroup = wt.createSendGroup();
  const stream = await wt.createUnidirectionalStream({ sendGroup });
  const writer = stream.getWriter();

  const streamStats1 = await stream.getStats();
  const groupStats1 = await sendGroup.getStats();
  assert_equals(groupStats1.bytesWritten, streamStats1.bytesWritten,
                'group with one stream: group.bytesWritten == stream.bytesWritten');
  assert_greater_than_equal(
      groupStats1.bytesSent, streamStats1.bytesSent,
      'group with one stream: group.bytesSent >= stream.bytesSent');
  assert_greater_than_equal(
      groupStats1.bytesAcknowledged, streamStats1.bytesAcknowledged,
      'group with one stream: group.bytesAcknowledged >= stream.bytesAcknowledged');

  await writer.write(new Uint8Array(400).fill(7));
  const streamStats2 = await stream.getStats();
  const groupStats2 = await sendGroup.getStats();
  assert_equals(groupStats2.bytesWritten, streamStats2.bytesWritten,
                'group with one stream: group.bytesWritten == stream.bytesWritten after write');
  assert_greater_than_equal(
      groupStats2.bytesSent, streamStats2.bytesSent,
      'group with one stream: group.bytesSent >= stream.bytesSent after write');
  assert_greater_than_equal(
      groupStats2.bytesAcknowledged, streamStats2.bytesAcknowledged,
      'group with one stream: group.bytesAcknowledged >= stream.bytesAcknowledged after write');
  assert_equals(groupStats2.bytesWritten, 400,
                'group bytesWritten must reflect the write');
}, 'WebTransportSendGroup.getStats() matches the single stream it contains');

promise_test(async t => {
  const wt = new WebTransport(webtransport_url('echo.py'));
  t.add_cleanup(() => wt.close());
  await wt.ready;

  const sendGroup = wt.createSendGroup();
  const stream1 = await wt.createUnidirectionalStream({ sendGroup });
  const stream2 = await wt.createUnidirectionalStream({ sendGroup });
  await Promise.all([
    stream1.getWriter().write(new Uint8Array(300).fill(1)),
    stream2.getWriter().write(new Uint8Array(700).fill(2)),
  ]);

  // Never call the streams' own getStats(): the group alone must see
  // bytesSent reach bytesWritten.
  let stats;
  do {
    await new Promise(resolve => t.step_timeout(resolve, 50));
    stats = await sendGroup.getStats();
  } while (stats.bytesSent < stats.bytesWritten);

  assert_equals(stats.bytesWritten, 1000,
                'group bytesWritten must sum all streams in the group');
  assert_equals(stats.bytesSent, 1000,
                'group bytesSent must reach bytesWritten');
}, 'WebTransportSendGroup.getStats() bytesSent advances without per-stream getStats()');

promise_test(async t => {
  const wt = new WebTransport(webtransport_url('echo.py'));
  t.add_cleanup(() => wt.close());
  await wt.ready;

  const sendGroup = wt.createSendGroup();
  const stream = await wt.createUnidirectionalStream({ sendGroup });
  const writer = stream.getWriter();

  // The first call must not pin the group's bytesSent: later calls have to
  // keep following the network as more data goes out.
  const stats1 = await sendGroup.getStats();
  const dataSize = 1000;
  await writer.write(new Uint8Array(dataSize).fill(7));

  let stats;
  do {
    await new Promise(resolve => t.step_timeout(resolve, 50));
    stats = await sendGroup.getStats();
  } while (stats.bytesSent < dataSize);

  assert_greater_than(stats.bytesSent, stats1.bytesSent,
                      'group bytesSent must advance past the first reading');
}, 'WebTransportSendGroup.getStats() bytesSent advances after the first call');

promise_test(async t => {
  const wt = new WebTransport(webtransport_url('echo.py'));
  await wt.ready;

  const sendGroup = wt.createSendGroup();
  const stream1 = await wt.createUnidirectionalStream({ sendGroup });
  const stream2 = await wt.createUnidirectionalStream({ sendGroup });
  const writer1 = stream1.getWriter();
  const writer2 = stream2.getWriter();
  await Promise.all([
    writer1.write(new Uint8Array(300).fill(1)),
    writer2.write(new Uint8Array(200).fill(2)),
  ]);

  const statsBeforeClose = await sendGroup.getStats();
  assert_equals(statsBeforeClose.bytesWritten, 500,
                'sanity: group aggregates both streams before close');

  wt.close();
  await wt.closed;

  // Per-stream getStats() correctly keeps returning last-known values after
  // close (the stream objects survive); the group's own aggregate must not
  // regress to zero just because the streams are no longer reachable via
  // the transport's own internal bookkeeping.
  const statsAfterClose = await sendGroup.getStats();
  assert_equals(statsAfterClose.bytesWritten, statsBeforeClose.bytesWritten,
                'group bytesWritten must not regress to zero after close');
  assert_equals(statsAfterClose.bytesSent, statsBeforeClose.bytesSent,
                'group bytesSent must not regress to zero after close');
  assert_equals(
    statsAfterClose.bytesAcknowledged, statsBeforeClose.bytesAcknowledged,
    'group bytesAcknowledged must not regress to zero after close');
}, 'WebTransportSendGroup.getStats() keeps last-known values after the connection closes');
