// META: global=window,worker
// META: script=/common/utils.js
// META: script=resources/webtransport-test-helpers.sub.js

for (const WT_CODE of [255, 256, 70000, 0xffffffff]) {
  promise_test(async t => {
    const id = token();
    const wt = new WebTransport(webtransport_url(`client-close.py?token=${id}`));
    add_completion_callback(() => wt.close());
    await wt.ready;

    const writable = await wt.createUnidirectionalStream();
    const HTTP_CODE = webtransport_code_to_http_code(WT_CODE);
    await writable.abort(
        new WebTransportError('', {streamErrorCode: WT_CODE}));

    const info = await query_stream_close_info(id);
    assert_equals(info.source, 'reset', 'reset_stream');
    assert_equals(info.code, HTTP_CODE, 'code');
  }, `Abort unidirectional stream with streamErrorCode ${WT_CODE}`);
}
