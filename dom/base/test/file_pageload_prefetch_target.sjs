"use strict";

// Keeps slow responses' timers alive until they fire.
const pendingTimers = new Set();

function hitsKey(token) {
  return `hits-${token}`;
}

function heldKey(token) {
  return `held-${token}`;
}

function handleRequest(request, response) {
  const params = new URLSearchParams(request.queryString);

  // ?count=<token>: report how many times that token's target was requested.
  if (params.has("count")) {
    response.setStatusLine(request.httpVersion, 200, "OK");
    response.setHeader("Content-Type", "text/plain", false);
    response.setHeader("Cache-Control", "no-store", false);
    response.write(getState(hitsKey(params.get("count"))) || "0");
    return;
  }

  // ?release=<token>: let that token's held response end.
  if (params.has("release")) {
    getObjectState(heldKey(params.get("release")), held =>
      held.wrappedJSObject.release()
    );
    response.setStatusLine(request.httpVersion, 200, "OK");
    response.setHeader("Cache-Control", "no-store", false);
    return;
  }

  // ?redirectto=<url>: redirect there.
  if (params.has("redirectto")) {
    response.setStatusLine(request.httpVersion, 302, "Found");
    response.setHeader("Cache-Control", "private, max-age=600", false);
    response.setHeader("Location", params.get("redirectto"), false);
    return;
  }

  const token = params.get("v");
  setState(hitsKey(token), String(Number(getState(hitsKey(token))) + 1));

  response.setStatusLine(request.httpVersion, 200, "OK");
  response.setHeader("Content-Type", "text/html", false);

  // A no-store target is only reused by a navigation activated from its prefetch.
  const noStore = params.has("nostore");
  response.setHeader(
    "Cache-Control",
    noStore ? "no-store" : "private, max-age=600",
    false
  );

  let body = "<!DOCTYPE html><title>prefetch target</title>";

  // ?large=1: pad the body past a lowered max_body_bytes cap.
  if (params.has("large")) {
    body += "x".repeat(1024);
  }

  // ?held=1: send the headers and the body so far, and hold back the end of
  // the body until ?release=<token> is requested.
  // ?length=1 with it declares the body's length rather than leave it open.
  // ?abort=1 with it sends a chunked response that the release cuts short.
  if (params.has("held")) {
    const end = "<p id=end>end</p>";
    const abort = params.has("abort");
    if (abort) {
      response.seizePower();
      response.write(
        "HTTP/1.1 200 OK\r\n" +
          "Content-Type: text/html; charset=utf-8\r\n" +
          "Cache-Control: private, max-age=600\r\n" +
          "Transfer-Encoding: chunked\r\n\r\n" +
          `${body.length.toString(16)}\r\n${body}\r\n`
      );
    } else {
      // Without a charset the parser waits for more of the body to sniff it.
      response.setHeader("Content-Type", "text/html; charset=utf-8", false);
      if (params.has("length")) {
        response.setHeader(
          "Content-Length",
          String(body.length + end.length),
          false
        );
      }
      response.processAsync();
      response.write(body);
    }
    const held = {
      release() {
        if (!abort) {
          response.write(end);
        }
        response.finish();
      },
      QueryInterface: ChromeUtils.generateQI([]),
    };
    held.wrappedJSObject = held;
    setObjectState(heldKey(token), held);
    return;
  }

  // ?slow=<ms>: hold back the whole response, headers included, so a
  // prefetch of this target is still in flight when the test navigates.
  // ?status=<code> with it answers with that status instead of 200.
  if (params.has("slow")) {
    response.processAsync();
    const timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
    pendingTimers.add(timer);
    timer.init(
      () => {
        pendingTimers.delete(timer);
        if (params.has("status")) {
          response.setStatusLine(
            request.httpVersion,
            Number(params.get("status")),
            "Error"
          );
        }
        response.write(body);
        response.finish();
      },
      Number(params.get("slow")),
      Ci.nsITimer.TYPE_ONE_SHOT
    );
    return;
  }

  response.write(body);
}
