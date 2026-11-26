// META: title=XMLHttpRequest: XHR that completes during a slow navigation should fire load

// A request that completes in the time window between "navigation start" and window.stop()
// should report normal success upon window.stop().
async_test(function(t) {
  var iframe = document.createElement("iframe");
  var events = [];

  window.addEventListener("message", t.step_func(function(e) {
    if (e.data.type === "xhr-event") {
      events.push(e.data.event);
    }
    if (e.data.type === "ready") {
      // Navigate to a slow page. The pending navigation leaves the
      // document's XHR alone, so its response (delay=500ms) arrives and
      // completes while the navigation is still pending (delay=10s).
      iframe.contentWindow.location.href = "/common/slow.py?delay=10000";

      // Wait long enough for the XHR to have completed (it has a 500ms
      // delay), then stop the navigation and verify the XHR completed
      // normally with a load event.
      t.step_timeout(function() {
        iframe.contentWindow.stop();

        t.step_timeout(t.step_func_done(function() {
          assert_true(events.includes("load"), "load event should fire");
          assert_true(events.includes("loadend"), "loadend event should fire");
          assert_false(events.includes("error"), "error event should not fire");
          assert_false(events.includes("abort"), "abort event should not fire");
        }), 1000);
      }, 2000);
    }
  }));

  iframe.src = "resources/abort-during-navigation-iframe.html?delay=500";
  document.body.appendChild(iframe);
}, "XHR that completes during a slow navigation should fire load, not abort");
