/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at <http://mozilla.org/MPL/2.0/>. */

"use strict";

requestLongerTimeout(2);

/**
 * Asserts inline stylesheets in the debugger
 */
const httpServer = createTestHTTPServer();
const BASE_URL = `http://localhost:${httpServer.identity.primaryPort}/`;

httpServer.registerContentType("html", "text/html");
httpServer.registerContentType("js", "application/javascript");

const INLINE_STYLE_1_CONTENT = `.bar {
  background-color: red;
  width: 10px; 
  height: 10px;
}`;
const INLINE_STYLE_2_CONTENT =
  ".bla { background-color: #3498db; width: 10px; height: 10px; }";

const HTML_SOURCE_CONTENT = `<html>
      <head>
        <style type="text/css">
.foo {
  background-color: green;
  width: 10px; 
  height: 10px;
}
        </style>
        <style>
${INLINE_STYLE_1_CONTENT}
        </style>
      </head>
      <body>
          <div class="foo"></div>
          <div class="bar"></div>
          <div class="bla"></div>
          <script type="text/javascript">
            const style = document.createElement('style');
            style.innerHTML = "${INLINE_STYLE_2_CONTENT}";
            document.head.appendChild(style);
          </script>
      </body>
    </html>`;

httpServer.registerPathHandler("/inline-css.html", (request, response) => {
  response.setStatusLine(request.httpVersion, 200, "OK");
  response.write(HTML_SOURCE_CONTENT);
});

add_task(async function testInlineStyleSheets() {
  await pushPref("devtools.debugger.features.stylesheets-in-debugger", true);
  const dbg = await initDebuggerWithAbsoluteURL(
    BASE_URL + "inline-css.html",
    "<style 0>",
    "<style 1>",
    "<style 2>"
  );

  await selectSourceFromSourceTreeWithIndex(
    dbg,
    "inline-css.html",
    3,
    "Select the second inline style sheet"
  );

  await waitForSourcesInSourceTree(
    dbg,
    ["inline-css.html", "inline_stylesheets"],
    { noExpand: false }
  );

  await selectSourceFromSourceTreeWithIndex(
    dbg,
    "inline_stylesheets",
    5,
    "Select the inline_stylesheets folder to display the inline style for the inline-css.html"
  );

  info("Assert that the content of the html is dispalyed");
  is(
    getEditorContent(dbg),
    HTML_SOURCE_CONTENT,
    "The content of html source is correct"
  );

  await selectSourceFromSourceTreeWithIndex(
    dbg,
    "<style 1>",
    5,
    "Select the second inline style sheet"
  );

  is(
    getEditorContent(dbg),
    INLINE_STYLE_1_CONTENT,
    "The content of second inline style sheet is correct"
  );

  await selectSourceFromSourceTreeWithIndex(
    dbg,
    "<style 2>",
    6,
    "Select the third inline style sheet"
  );

  is(
    getEditorContent(dbg),
    INLINE_STYLE_2_CONTENT,
    "The content of third inline style sheet is correct"
  );
});
