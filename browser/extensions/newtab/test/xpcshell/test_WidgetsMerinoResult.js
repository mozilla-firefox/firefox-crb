/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

ChromeUtils.defineESModuleGetters(this, {
  recordWidgetsMerinoResult:
    "resource://newtab/lib/Widgets/WidgetsMerinoResult.sys.mjs",
  trackWidgetsMerinoResult:
    "resource://newtab/lib/Widgets/WidgetsMerinoResult.sys.mjs",
});

const CATEGORIES = [
  "success",
  "no_suggestion",
  "timeout",
  "network_error",
  "http_4xx",
  "http_5xx",
];

/**
 * @param {string} key
 * @returns {object}
 *   The counts recorded for `key`, as { category: n }.
 */
function getCounts(key) {
  let counts = {};
  for (let category of CATEGORIES) {
    let value = Glean.newtab.widgetsMerinoResult
      .get(key, category)
      .testGetValue();
    if (value) {
      counts[category] = value;
    }
  }
  return counts;
}

add_setup(() => {
  do_get_profile();
  Services.fog.initializeFOG();
});

add_task(function test_recordWidgetsMerinoResult_categories() {
  const cases = [
    { args: ["success", { httpStatus: 200 }], expected: "success" },
    { args: ["no_suggestion", { httpStatus: 204 }], expected: "no_suggestion" },
    { args: ["timeout", { httpStatus: null }], expected: "timeout" },
    {
      args: ["network_error", { httpStatus: null }],
      expected: "network_error",
    },
    { args: ["http_error", { httpStatus: 400 }], expected: "http_4xx" },
    { args: ["http_error", { httpStatus: 499 }], expected: "http_4xx" },
    { args: ["http_error", { httpStatus: 500 }], expected: "http_5xx" },
    { args: ["http_error", { httpStatus: 599 }], expected: "http_5xx" },
    { args: ["http_error", { httpStatus: 302 }], expected: "network_error" },
    { args: ["http_error", { httpStatus: null }], expected: "network_error" },
    { args: ["http_error"], expected: "network_error" },
  ];

  for (let { args, expected } of cases) {
    Services.fog.testResetFOG();

    recordWidgetsMerinoResult("stocks_quotes", ...args);

    Assert.deepEqual(
      getCounts("stocks_quotes"),
      { [expected]: 1 },
      `${JSON.stringify(args)} counts as ${expected}`
    );
  }
});

add_task(function test_recordWidgetsMerinoResult_keys() {
  Services.fog.testResetFOG();

  recordWidgetsMerinoResult("picture_of_the_day", "success");
  recordWidgetsMerinoResult("picture_of_the_day", "success");
  recordWidgetsMerinoResult("framed_widgets", "timeout");

  Assert.deepEqual(getCounts("picture_of_the_day"), { success: 2 });
  Assert.deepEqual(getCounts("framed_widgets"), { timeout: 1 });
});

add_task(function test_trackWidgetsMerinoResult() {
  Services.fog.testResetFOG();
  let tracker = trackWidgetsMerinoResult("stocks_search");
  tracker.onResult("success", { httpStatus: 200 });
  Assert.deepEqual(
    getCounts("stocks_search"),
    {},
    "Nothing is counted before record() is called"
  );
  tracker.record();
  tracker.record();
  Assert.deepEqual(
    getCounts("stocks_search"),
    { success: 1 },
    "record() counts the result once"
  );

  Services.fog.testResetFOG();
  tracker = trackWidgetsMerinoResult("stocks_search");
  tracker.onResult("success", { httpStatus: 200 });
  tracker.record(false);
  Assert.deepEqual(
    getCounts("stocks_search"),
    { no_suggestion: 1 },
    "A success the caller couldn't use counts as no_suggestion"
  );

  Services.fog.testResetFOG();
  tracker = trackWidgetsMerinoResult("stocks_search");
  tracker.onResult("http_error", { httpStatus: 503 });
  tracker.record(false);
  Assert.deepEqual(
    getCounts("stocks_search"),
    { http_5xx: 1 },
    "A failure counts as what it is, whatever the caller could use"
  );

  Services.fog.testResetFOG();
  tracker = trackWidgetsMerinoResult("stocks_search");
  tracker.record();
  tracker.record(false);
  Assert.deepEqual(
    getCounts("stocks_search"),
    {},
    "Nothing is counted when MerinoClient reported no result"
  );
});
