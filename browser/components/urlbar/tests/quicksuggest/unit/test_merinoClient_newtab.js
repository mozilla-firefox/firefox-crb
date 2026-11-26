/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Tests the New Tab APIs in merino client.

"use strict";

ChromeUtils.defineESModuleGetters(this, {
  MerinoClient: "moz-src:///browser/components/urlbar/MerinoClient.sys.mjs",
});

add_setup(async () => {
  await MerinoTestUtils.server.start();
});

add_task(async function fetchPictureOfTheDay() {
  MerinoTestUtils.server.reset();
  MerinoTestUtils.server.response.body = { title: "Picture" };

  let merino = new MerinoClient("test");
  let result = await merino.fetchPictureOfTheDay({
    source: "newtab",
    endpointUrl: MerinoTestUtils.server.url.toString(),
    acceptLanguage: "fr",
  });

  Assert.deepEqual(result, { data: { title: "Picture" }, error: null });
  let [request] = MerinoTestUtils.server.requests;
  let params = new URLSearchParams(request.queryString);
  Assert.equal(params.get("source"), "newtab");
  Assert.equal(request.getHeader("Accept-Language"), "fr");
});

add_task(async function fetchFramedWidgets() {
  MerinoTestUtils.server.reset();
  MerinoTestUtils.server.response.body = { widgets: [] };

  let merino = new MerinoClient("test");
  let result = await merino.fetchFramedWidgets({
    source: "newtab",
    endpointUrl: MerinoTestUtils.server.url.toString(),
    locale: "fr",
  });

  Assert.deepEqual(result, { data: { widgets: [] }, error: null });
  let [request] = MerinoTestUtils.server.requests;
  let params = new URLSearchParams(request.queryString);
  Assert.equal(params.get("source"), "newtab");
  Assert.equal(params.get("locale"), "fr");
  Assert.equal(request.getHeader("Accept-Language"), "fr");
});

add_task(async function errors() {
  let merino = new MerinoClient("test");
  let endpointUrl = MerinoTestUtils.server.url.toString();

  for (let method of ["fetchPictureOfTheDay", "fetchFramedWidgets"]) {
    Assert.deepEqual(
      await merino[method]({ endpointUrl: "" }),
      { data: null, error: null },
      `${method}: no endpoint`
    );
    Assert.deepEqual(
      await merino[method]({ endpointUrl: "not a url" }),
      { data: null, error: "invalid_url" },
      `${method}: invalid endpoint`
    );

    MerinoTestUtils.server.response = { status: 500 };
    Assert.deepEqual(
      await merino[method]({ endpointUrl }),
      { data: null, error: "load_error" },
      `${method}: HTTP error`
    );

    MerinoTestUtils.server.response = {
      status: 200,
      contentType: "text/plain",
      body: "not json",
    };
    Assert.deepEqual(
      await merino[method]({ endpointUrl }),
      { data: null, error: "load_error" },
      `${method}: unreadable response`
    );
  }

  MerinoTestUtils.server.reset();
});

// `onResult` should be called once for each request that is sent, and what the
// methods return should not depend on it.
add_task(async function onResult() {
  let merino = new MerinoClient("test");
  let endpointUrl = MerinoTestUtils.server.url.toString();

  let tests = [
    {
      response: { body: { title: "Picture" } },
      expectedReturn: { data: { title: "Picture" }, error: null },
      expectedResult: ["success", { httpStatus: 200 }],
    },
    {
      response: { status: 500 },
      expectedReturn: { data: null, error: "load_error" },
      expectedResult: ["http_error", { httpStatus: 500 }],
    },
    {
      response: { contentType: "text/plain", body: "not json" },
      expectedReturn: { data: null, error: "load_error" },
      expectedResult: ["no_suggestion", { httpStatus: 200 }],
    },
    {
      endpointUrl: "http://localhost/valid-but-unreachable-url",
      expectedReturn: { data: null, error: "load_error" },
      expectedResult: ["network_error", { httpStatus: null }],
    },
    {
      endpointUrl: "",
      expectedReturn: { data: null, error: null },
      expectedResult: null,
    },
    {
      endpointUrl: "not a url",
      expectedReturn: { data: null, error: "invalid_url" },
      expectedResult: null,
    },
  ];

  for (let method of ["fetchPictureOfTheDay", "fetchFramedWidgets"]) {
    for (let test of tests) {
      info(`Testing ${method}: ` + JSON.stringify(test));
      MerinoTestUtils.server.response = test.response ?? {};

      let results = [];
      let returned = await merino[method]({
        endpointUrl: test.endpointUrl ?? endpointUrl,
        onResult: (...args) => results.push(args),
      });

      Assert.deepEqual(returned, test.expectedReturn, "Return value");
      Assert.deepEqual(
        results,
        test.expectedResult ? [test.expectedResult] : [],
        "onResult calls"
      );
    }
  }

  MerinoTestUtils.server.reset();
});

// A request is aborted when the timeout the caller passes elapses.
add_task(async function timeout() {
  let merino = new MerinoClient("test");
  let endpointUrl = MerinoTestUtils.server.url.toString();

  for (let method of ["fetchPictureOfTheDay", "fetchFramedWidgets"]) {
    MerinoTestUtils.server.response = { body: { widgets: [] }, delay: 400 };

    let results = [];
    Assert.deepEqual(
      await merino[method]({
        endpointUrl,
        timeoutMs: 50,
        onResult: (...args) => results.push(args),
      }),
      { data: null, error: "load_error" },
      `${method}: the request is aborted when the timeout elapses`
    );
    Assert.deepEqual(results, [["timeout", { httpStatus: null }]]);
  }

  MerinoTestUtils.server.reset();
});
