// META: title=XMLHttpRequest: window.stop() during a slow navigation should abort deferred XHR

async_test(function(t) {
  var iframe = document.createElement("iframe");
  var events = [];

  window.addEventListener("message", t.step_func(function(e) {
    if (e.data.type === "xhr-event") {
      events.push(e.data.event);
    }
    if (e.data.type === "ready") {
      // Start a slow navigation that won't commit for a long time.
      // The pending navigation leaves the document's XHR alone.
      iframe.contentWindow.location.href = "/common/slow.py?delay=10000";

      // Wait a moment for the navigation to start, then stop it.
      // This cancels the navigation and should also cancel the
      // XHR.
      t.step_timeout(function() {
        iframe.contentWindow.stop();

        t.step_timeout(t.step_func_done(function() {
          assert_true(events.includes("abort"), "abort event should fire");
          assert_true(events.includes("loadend"), "loadend event should fire");
          assert_false(events.includes("error"), "error event should not fire");
          assert_false(events.includes("load"), "load event should not fire");
        }), 1000);
      }, 500);
    }
  }));

  iframe.src = "resources/abort-during-navigation-iframe.html";
  document.body.appendChild(iframe);
}, "Deferred XHR should fire abort when window.stop() cancels a slow navigation");
