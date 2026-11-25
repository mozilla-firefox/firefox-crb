/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

add_task(async function test_shouldLog_maxLogLevel() {
  let ci = console.createInstance({ maxLogLevel: "Warn" });

  Assert.ok(
    ci.shouldLog("Error"),
    "Should return true for logging a higher level"
  );
  Assert.ok(
    ci.shouldLog("Warn"),
    "Should return true for logging the same level"
  );
  Assert.ok(
    !ci.shouldLog("Debug"),
    "Should return false for logging a lower level;"
  );
});

add_task(async function test_shouldLog_maxLogLevelPref() {
  Services.prefs.setStringPref("test.log", "Warn");
  let ci = console.createInstance({ maxLogLevelPref: "test.log" });

  Assert.ok(
    !ci.shouldLog("Debug"),
    "Should return false for logging a lower level;"
  );

  Services.prefs.setStringPref("test.log", "Debug");
  Assert.ok(
    ci.shouldLog("Debug"),
    "Should return true for logging a lower level after pref update"
  );
});

add_task(async function test_shouldLog_maxLogLevelPref_case_match() {
  Services.prefs.setStringPref("test.log.case", "Warn");
  let ci = console.createInstance({ maxLogLevelPref: "test.log.case" });

  Assert.ok(ci.shouldLog("Warn"), "Should log at the exact pref level");
  Assert.ok(ci.shouldLog("Error"), "Should log above the pref level");
  Assert.ok(!ci.shouldLog("Info"), "Should not log below the pref level");

  Services.prefs.setStringPref("test.log.case", "Error");
  Assert.ok(ci.shouldLog("Error"), "Should log at the updated pref level");
  Assert.ok(
    !ci.shouldLog("Warn"),
    "Should not log below the updated pref level"
  );
});

add_task(async function test_shouldLog_maxLogLevelPref_case_insensitive() {
  let ci = console.createInstance({ maxLogLevelPref: "test.log.icase" });

  for (const prefValue of ["warn", "WARN", "wArN"]) {
    Services.prefs.setStringPref("test.log.icase", prefValue);
    Assert.ok(
      ci.shouldLog("Warn"),
      `Should log at the Warn level when pref is "${prefValue}"`
    );
    Assert.ok(
      ci.shouldLog("Error"),
      `Should log above Warn when pref is "${prefValue}"`
    );
    Assert.ok(
      !ci.shouldLog("Info"),
      `Should not log below Warn when pref is "${prefValue}"`
    );
  }
});

add_task(async function test_shouldLog_env() {
  // https://searchfox.org/firefox-main/rev/a4d90d145864bee938bb23cb2684d64bff032431/mozglue/misc/LoggingCore.h#31-38
  //
  //   +---------+------------------+-----------------+
  //   | Numeric | NSPR Logging     | Mozilla Logging |
  //   +---------+------------------+-----------------+
  //   |       0 | PR_LOG_NONE      | Disabled        |
  //   |       1 | PR_LOG_ALWAYS    | Error           |
  //   |       2 | PR_LOG_ERROR     | Warning         |
  //   |       3 | PR_LOG_WARNING   | Info            |
  //   |       4 | PR_LOG_DEBUG     | Debug           |
  //   |       5 | PR_LOG_DEBUG + 1 | Verbose         |
  //   +---------+------------------+-----------------+

  const tests = [
    {
      ci: console.createInstance({
        logModule: "shouldlogtest_0",
        maxLogLevel: "Off",
      }),
      mozLogLevel: 0,
      maxLogLevel: "Off",
      shouldLog: [],
      shouldNotLog: ["Error", "Warn", "Info", "Debug", "Trace"],
    },
    {
      ci: console.createInstance({
        logModule: "shouldlogtest_1",
        maxLogLevel: "Off",
      }),
      mozLogLevel: 1,
      maxLogLevel: "Off",
      shouldLog: ["Error"],
      shouldNotLog: ["Warn", "Info", "Debug", "Trace"],
    },
    {
      ci: console.createInstance({
        logModule: "shouldlogtest_2",
        maxLogLevel: "Off",
      }),
      mozLogLevel: 2,
      maxLogLevel: "Off",
      shouldLog: ["Error", "Warn"],
      shouldNotLog: ["Info", "Debug", "Trace"],
    },
    {
      ci: console.createInstance({
        logModule: "shouldlogtest_3",
        maxLogLevel: "Off",
      }),
      mozLogLevel: 3,
      maxLogLevel: "Off",
      shouldLog: ["Error", "Warn", "Info"],
      shouldNotLog: ["Debug", "Trace"],
    },
    {
      ci: console.createInstance({
        logModule: "shouldlogtest_4",
        maxLogLevel: "Off",
      }),
      mozLogLevel: 4,
      maxLogLevel: "Off",
      shouldLog: ["Error", "Warn", "Info", "Debug"],
      shouldNotLog: ["Trace"],
    },
    {
      ci: console.createInstance({
        logModule: "shouldlogtest_5",
        maxLogLevel: "Off",
      }),
      mozLogLevel: 5,
      maxLogLevel: "Off",
      shouldLog: ["Error", "Warn", "Info", "Debug", "Trace"],
      shouldNotLog: [],
    },
    // Also check that MOZ_LOG doesn't prevent regular logging
    {
      ci: console.createInstance({
        logModule: "shouldlogtest_0",
        maxLogLevel: "All",
      }),
      mozLogLevel: 0,
      maxLogLevel: "All",
      shouldLog: ["Error", "Warn", "Info", "Debug", "Trace"],
      shouldNotLog: [],
    },
    {
      ci: console.createInstance({
        logModule: "shouldlogtest_0",
        maxLogLevel: "Warn",
      }),
      mozLogLevel: 0,
      maxLogLevel: "Warn",
      shouldLog: ["Error", "Warn"],
      shouldNotLog: ["Info", "Debug", "Trace"],
    },
  ];

  for (const test of tests) {
    for (const level of test.shouldNotLog) {
      Assert.ok(
        !test.ci.shouldLog(level),
        `Should return false for "${level}" with MOZ_LOG=${test.mozLogLevel} and maxLogLevel=${test.maxLogLevel}`
      );
    }

    for (const level of test.shouldLog) {
      Assert.ok(
        test.ci.shouldLog(level),
        `Should return true for "${level}" with MOZ_LOG=${test.mozLogLevel} and maxLogLevel=${test.maxLogLevel}`
      );
    }
  }
});
