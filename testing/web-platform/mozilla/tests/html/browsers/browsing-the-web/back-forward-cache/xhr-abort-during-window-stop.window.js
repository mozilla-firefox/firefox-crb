// META: title=XMLHttpRequest: window.stop() should abort deferred XHR and fire correct events

async_test(function(t) {
  var iframe = document.createElement("iframe");
  var events = [];

  window.addEventListener("message", t.step_func(function(e) {
    if (e.data.type === "xhr-event") {
      events.push(e.data.event);
    }
    if (e.data.type === "ready") {
      // Call window.stop() on the iframe to cancel its in-flight XHR.
      iframe.contentWindow.stop();
      t.step_timeout(t.step_func_done(function() {
        assert_true(events.includes("abort"), "abort event should fire");
        assert_true(events.includes("loadend"), "loadend event should fire");
        assert_false(events.includes("error"), "error event should not fire");
        assert_false(events.includes("load"), "load event should not fire");
      }), 1000);
    }
  }));

  iframe.src = "resources/abort-during-navigation-iframe.html";
  document.body.appendChild(iframe);
}, "XHR should fire abort (not error) when cancelled by window.stop()");
