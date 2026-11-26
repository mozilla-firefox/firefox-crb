/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

ChromeUtils.defineESModuleGetters(this, {
  recordWidgetsMerinoResult:
    "resource://newtab/lib/Widgets/WidgetsMerinoResult.sys.mjs",
  trackWidgetsMerinoResult:
    "resource://newtab/lib/Widgets/WidgetsMerinoResult.sys.mjs",
});

function getCounts(key) {
  return getWidgetsMerinoResults([key])[key] ?? {};
}

add_setup(() => {
  do_get_profile();
  Services.fog.initializeFOG();
});

add_task(function test_recordWidgetsMerinoResult_categories() {
  const cases = [
    { args: ["timeout", { httpStatus: null }], expected: "timeout" },
    { args: ["http_error", { httpStatus: 404 }], expected: "http_4xx" },
    { args: ["http_error", { httpStatus: 503 }], expected: "http_5xx" },
    { args: ["http_error", { httpStatus: 302 }], expected: "network_error" },
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
