"use strict";

let timer;

function handleRequest(request, response) {
  response.processAsync();
  response.setHeader("Content-Type", "text/css", false);
  response.setHeader("Cache-Control", "no-store", false);
  timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
  timer.initWithCallback(
    () => {
      response.write("h1 { color: red; }");
      response.finish();
    },
    2000,
    Ci.nsITimer.TYPE_ONE_SHOT
  );
}
