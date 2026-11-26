/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Tests the weather related APIs in merino client.

"use strict";

ChromeUtils.defineESModuleGetters(this, {
  GeolocationUtils:
    "moz-src:///browser/components/urlbar/private/GeolocationUtils.sys.mjs",
  MerinoClient: "moz-src:///browser/components/urlbar/MerinoClient.sys.mjs",
});

const HOURLY_FORECASTS = [
  {
    date_time: "2026-11-20T10:00:00-08:00",
    epoch_date_time: 1795197600,
    icon_id: 1,
    temperature: { c: 15, f: 59 },
    url: "https://example.com/hourly",
  },
];

add_setup(async () => {
  await MerinoTestUtils.server.start();

  let cleanup = GeolocationTestUtils.stubGeolocation({
    country_code: "JP",
    region: "Kanagawa",
    region_code: "14",
  });

  registerCleanupFunction(async function () {
    await cleanup();
  });
});

add_task(async function fetchWeatherReport() {
  const testData = [
    {
      params: {
        source: "test",
        timeoutMs: 100,
      },
      expected: {
        query: "",
        otherParams: {
          source: "test",
          country: "JP",
          region: "14",
          city: "Kanagawa",
        },
        timeoutMs: 100,
      },
    },
    {
      params: {
        source: "test",
        locationName: "location name",
      },
      expected: {
        query: "location name",
        otherParams: {
          source: "test",
        },
      },
    },
    {
      params: {
        source: "test",
        city: "test city",
      },
      expected: {
        query: "",
        otherParams: {
          source: "test",
          city: "test city",
        },
      },
    },
    {
      params: {
        source: "test",
        country: "test country code",
      },
      expected: {
        query: "",
        otherParams: {
          source: "test",
          country: "test country code",
        },
      },
    },
    {
      params: {
        source: "test",
        region: "r1,r2,r3",
      },
      expected: {
        query: "",
        otherParams: {
          source: "test",
          region: "r1,r2,r3",
        },
      },
    },
    {
      params: {
        source: "test",
        city: "test city",
        country: "test country code",
        region: "r1,r2,r3",
      },
      expected: {
        query: "",
        otherParams: {
          source: "test",
          city: "test city",
          country: "test country code",
          region: "r1,r2,r3",
        },
      },
    },
    {
      params: {
        source: "test",
        locationName: "location name",
        city: "test city",
        country: "test country code",
        region: "r1,r2,r3",
      },
      expected: {
        query: "location name",
        otherParams: {
          source: "test",
        },
      },
    },
  ];

  let merino = new MerinoClient("test");
  let onResult = () => {};

  for (let { params, expected } of testData) {
    let stub = sinon.stub(merino, "fetch").resolves([]);

    await merino.fetchWeatherReport({ ...params, onResult });

    Assert.ok(stub.calledOnce);
    Assert.deepEqual(stub.firstCall.args[0], {
      providers: ["accuweather"],
      query: expected.query,
      otherParams: {
        request_type: "weather",
        ...expected.otherParams,
      },
      timeoutMs: expected.timeoutMs,
      endpointUrl: UrlbarPrefs.get("merino.weather.reportEndpointURL"),
      onResult,
    });

    stub.restore();
  }
});

add_task(async function autoCompleteWeatherLocation() {
  const testData = [
    {
      params: {
        source: "test",
        timeoutMs: 100,
      },
      expected: {
        query: "",
        otherParams: {
          source: "test",
        },
        timeoutMs: 100,
      },
    },
    {
      params: {
        source: "test",
        query: "q",
        timeoutMs: 100,
      },
      expected: {
        query: "q",
        otherParams: {
          source: "test",
        },
        timeoutMs: 100,
      },
    },
  ];

  let merino = new MerinoClient("test");
  let onResult = () => {};

  for (let { params, expected } of testData) {
    let stub = sinon.stub(merino, "fetch").resolves([]);

    await merino.autoCompleteWeatherLocation({ ...params, onResult });

    Assert.ok(stub.calledOnce);
    Assert.deepEqual(stub.firstCall.args[0], {
      providers: ["accuweather"],
      query: expected.query,
      otherParams: {
        request_type: "location",
        ...expected.otherParams,
      },
      timeoutMs: expected.timeoutMs,
      onResult,
    });

    stub.restore();
  }
});

add_task(async function fetchHourlyForecasts_request() {
  MerinoTestUtils.server.reset();
  MerinoTestUtils.server.response = { body: HOURLY_FORECASTS };

  let merino = new MerinoClient("test");

  let { forecasts, results } = await fetchHourly(merino, {
    source: "test",
    locationName: "location name",
    city: "test city",
    region: "r1",
    country: "test country code",
  });
  Assert.deepEqual(forecasts, HOURLY_FORECASTS, "The forecasts are returned");
  Assert.deepEqual(results, [["success", { httpStatus: 200 }]]);
  Assert.deepEqual(
    MerinoTestUtils.server.requests.map(request =>
      Object.fromEntries(new URLSearchParams(request.queryString))
    ),
    [
      {
        source: "test",
        q: "location name",
        city: "test city",
        region: "r1",
        country: "test country code",
      },
    ],
    "The request has the expected search params"
  );

  MerinoTestUtils.server.reset();
});

add_task(async function fetchHourlyForecasts_responses() {
  let tests = [
    {
      response: { status: 500, body: HOURLY_FORECASTS },
      expected: ["http_error", { httpStatus: 500 }],
    },
    {
      response: { body: { detail: "Not an array" } },
      expected: ["no_suggestion", { httpStatus: 200 }],
    },
    {
      response: { body: "[]" },
      expected: ["no_suggestion", { httpStatus: 200 }],
    },
  ];

  let merino = new MerinoClient("test");
  for (let { response, expected } of tests) {
    info("Testing response: " + JSON.stringify(response));
    MerinoTestUtils.server.response = response;

    let { forecasts, results } = await fetchHourly(merino);

    Assert.strictEqual(forecasts, null, "No forecasts are returned");
    Assert.deepEqual(results, [expected], "onResult is called once");
  }

  MerinoTestUtils.server.reset();
});

add_task(async function fetchHourlyForecasts_timeout() {
  MerinoTestUtils.server.reset();
  MerinoTestUtils.server.response = { body: HOURLY_FORECASTS, delay: 400 };

  let merino = new MerinoClient("test");
  let { forecasts, results } = await fetchHourly(merino, {
    source: "test",
    city: "test city",
    timeoutMs: 50,
  });
  Assert.strictEqual(forecasts, null, "No forecasts are returned");
  Assert.deepEqual(results, [["timeout", { httpStatus: null }]]);

  MerinoTestUtils.server.reset();
});

// When the endpoint isn't a valid URL, no request is sent, including the
// geolocation request.
add_task(async function fetchHourlyForecasts_invalidEndpoint() {
  MerinoTestUtils.server.reset();
  let originalURL = UrlbarPrefs.get("merino.weather.hourlyEndpointURL");
  UrlbarPrefs.set("merino.weather.hourlyEndpointURL", "not a url");
  GeolocationUtils.geolocation.resetHistory();

  let { forecasts, results } = await fetchHourly(new MerinoClient("test"), {
    source: "test",
  });

  Assert.strictEqual(forecasts, null, "No forecasts are returned");
  Assert.deepEqual(results, [], "onResult is not called");
  Assert.ok(
    GeolocationUtils.geolocation.notCalled,
    "The geolocation is not fetched"
  );
  MerinoTestUtils.server.checkAndClearRequests([]);
  UrlbarPrefs.set("merino.weather.hourlyEndpointURL", originalURL);
});

async function fetchHourly(
  merino,
  args = { source: "test", city: "test city" }
) {
  let results = [];
  let forecasts = await merino.fetchHourlyForecasts({
    ...args,
    onResult: (...a) => results.push(a),
  });
  return { forecasts, results };
}
