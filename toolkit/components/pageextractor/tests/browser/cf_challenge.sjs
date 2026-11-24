/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Answers the way Cloudflare serves a challenge page: a 403 marked with
// "cf-mitigated: challenge", isolated like the real one, with no text to read
// until the challenge's script runs.
function handleRequest(request, response) {
  response.setStatusLine(request.httpVersion, "403", "Forbidden");
  response.setHeader("Content-Type", "text/html", false);
  response.setHeader("cf-mitigated", "challenge", false);
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin", false);
  response.setHeader("Cross-Origin-Embedder-Policy", "require-corp", false);
  response.write(
    "<!DOCTYPE html><html><head><title>Just a moment...</title></head>" +
      "<body><noscript>Enable JavaScript and cookies to continue</noscript>" +
      "</body></html>"
  );
}
