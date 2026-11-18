// META: global=window,worker
// META: script=resources/webtransport-test-helpers.sub.js

// Tests that Firefox can connect to WebTransport servers implementing
// draft-ietf-webtrans-http3-15 (`:protocol: webtransport-h3`) and
// draft-ietf-webtrans-http3-07 (`:protocol: webtransport`), as well as
// servers advertising both.

promise_test(async t => {
  const wt = new WebTransport(webtransport_url('echo-request-headers.py'));
  await wt.ready;
  wt.close();
  await wt.closed.catch(() => {});
}, 'Connect to server supporting both draft-07 and draft-15 (default)');

promise_test(async t => {
  // Firefox prefers draft-15 when the server accepts both.
  const wt = new WebTransport(webtransport_url('echo-request-headers.py'));
  await wt.ready;
  const streams = wt.incomingUnidirectionalStreams.getReader();
  const {value: recv_stream} = await streams.read();
  streams.releaseLock();
  const headers = await read_stream_as_json(recv_stream);
  assert_equals(headers[':protocol'], 'webtransport-h3');
  wt.close();
  await wt.closed.catch(() => {});
}, 'The default server negotiates draft-15');

promise_test(async t => {
  const wt = new WebTransport(webtransport_url_draft15('echo-request-headers.py'));
  await wt.ready;
  wt.close();
  await wt.closed.catch(() => {});
}, 'Connect to draft-15-only server (webtransport-h3 protocol)');

promise_test(async t => {
  const wt = new WebTransport(webtransport_url_draft07('echo-request-headers.py'));
  await wt.ready;
  wt.close();
  await wt.closed.catch(() => {});
}, 'Connect to draft-07-only server (webtransport protocol)');

promise_test(async t => {
  // Verify data can be round-tripped on a draft-15 server.
  const wt = new WebTransport(webtransport_url_draft15('echo.py'));
  await wt.ready;
  const stream = await wt.createUnidirectionalStream();
  const writer = stream.getWriter();
  await writer.write(new Uint8Array([1, 2, 3]));
  await writer.close();
  wt.close();
  await wt.closed.catch(() => {});
}, 'Data transfer works on draft-15-only server');

promise_test(async t => {
  // Verify data can be round-tripped on a draft-07 server.
  const wt = new WebTransport(webtransport_url_draft07('echo.py'));
  await wt.ready;
  const stream = await wt.createUnidirectionalStream();
  const writer = stream.getWriter();
  await writer.write(new Uint8Array([1, 2, 3]));
  await writer.close();
  wt.close();
  await wt.closed.catch(() => {});
}, 'Data transfer works on draft-07-only server');
