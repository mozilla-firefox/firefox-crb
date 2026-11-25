/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

ChromeUtils.defineESModuleGetters(this, {
  actionCreators: "resource://newtab/common/Actions.mjs",
  actionTypes: "resource://newtab/common/Actions.mjs",
  sinon: "resource://testing-common/Sinon.sys.mjs",
  GeolocationTestUtils:
    "resource://testing-common/GeolocationTestUtils.sys.mjs",
  MerinoTestUtils: "resource://testing-common/MerinoTestUtils.sys.mjs",
  UrlbarPrefs: "moz-src:///browser/components/urlbar/UrlbarPrefs.sys.mjs",
  WeatherFeed: "resource://newtab/lib/WeatherFeed.sys.mjs",
  Region: "resource://gre/modules/Region.sys.mjs",
});

const { WEATHER_SUGGESTION } = MerinoTestUtils;
GeolocationTestUtils.init(this);
MerinoTestUtils.init(this);

const WEATHER_ENABLED = "browser.newtabpage.activity-stream.showWeather";
const SYS_WEATHER_ENABLED =
  "browser.newtabpage.activity-stream.system.showWeather";

add_setup(async () => {
  do_get_profile();
  Services.fog.initializeFOG();
  await MerinoTestUtils.server.start();
});

add_task(async function test_MerinoClient_wrapper_passes_correct_args() {
  let sandbox = sinon.createSandbox();
  sandbox.stub(WeatherFeed.prototype, "PersistentCache").returns({
    set: () => {},
    get: () => {},
  });

  let feed = new WeatherFeed();
  let client = feed.MerinoClient("TEST_CLIENT");

  Assert.equal(
    typeof client.name,
    "string",
    "MerinoClient name should be a string, not an object"
  );
  Assert.equal(
    client.name,
    "TEST_CLIENT",
    "MerinoClient name should match the passed argument"
  );

  sandbox.restore();
});

add_task(async function test_construction() {
  let sandbox = sinon.createSandbox();
  sandbox.stub(WeatherFeed.prototype, "PersistentCache").returns({
    set: () => {},
    get: () => {},
  });

  let feed = new WeatherFeed();

  info("WeatherFeed constructor should create initial values");

  Assert.ok(feed, "Could construct a WeatherFeed");
  Assert.strictEqual(feed.loaded, false, "WeatherFeed is not loaded");
  Assert.strictEqual(feed.merino, null, "merino is initialized as null");
  Assert.strictEqual(
    feed.suggestions.length,
    0,
    "suggestions is initialized as a array with length of 0"
  );
  Assert.strictEqual(
    feed.fetchTimer,
    null,
    "fetchTimer is initialized as null"
  );
  sandbox.restore();
});

add_task(async function test_checkOptInRegion() {
  let sandbox = sinon.createSandbox();

  sandbox.stub(WeatherFeed.prototype, "PersistentCache").returns({
    set: () => {},
    get: () => {},
  });

  let feed = new WeatherFeed();

  feed.store = {
    dispatch: sinon.spy(),
    getState() {
      return { Prefs: { values: {} } };
    },
  };

  sandbox.stub(feed, "isEnabled").returns(true);

  // First case: If home region is in the opt-in list, showWeatherOptIn should be true
  // Region._setHomeRegion() is the supported way to control region in tests:
  // https://firefox-source-docs.mozilla.org/toolkit/modules/toolkit_modules/Region.html#testing
  // We used false here because that second argument is a change observer that will fire an event.
  // So keeping it false silently sets the region for our test
  Region._setHomeRegion("FR", false);
  let resultTrue = await feed.checkOptInRegion();

  Assert.strictEqual(
    resultTrue,
    true,
    "Returns true for region in opt-in list"
  );
  Assert.ok(
    feed.store.dispatch.calledWith(
      actionCreators.SetPref("system.showWeatherOptIn", true)
    ),
    "Dispatch sets system.showWeatherOptIn to true when region is in opt-in list"
  );

  // Second case: If home region is not in the opt-in list, showWeatherOptIn should be false
  Region._setHomeRegion("ZZ", false);
  let resultFalse = await feed.checkOptInRegion();

  Assert.strictEqual(
    resultFalse,
    false,
    "Returns false for region not found in opt-in list"
  );
  Assert.ok(
    feed.store.dispatch.calledWith(
      actionCreators.SetPref("system.showWeatherOptIn", false)
    ),
    "Dispatch sets system.showWeatherOptIn to false when region is not in opt-in list"
  );

  sandbox.restore();
});

add_task(async function test_onAction_INIT() {
  let sandbox = sinon.createSandbox();
  sandbox.stub(WeatherFeed.prototype, "MerinoClient").returns({
    get: () => [WEATHER_SUGGESTION],
    on: () => {},
  });
  sandbox.stub(WeatherFeed.prototype, "PersistentCache").returns({
    set: () => {},
    get: () => {},
  });
  const dateNowTestValue = 1;
  sandbox.stub(WeatherFeed.prototype, "Date").returns({
    now: () => dateNowTestValue,
  });

  let feed = new WeatherFeed();
  let locationData = {
    city: "testcity",
    adminArea: "",
    country: "",
  };

  Services.prefs.setBoolPref(WEATHER_ENABLED, true);
  Services.prefs.setBoolPref(SYS_WEATHER_ENABLED, true);

  sandbox.stub(feed, "isEnabled").returns(true);

  sandbox.stub(feed, "_fetchHelper").resolves({
    suggestions: [WEATHER_SUGGESTION],
    hourlyForecasts: [],
  });
  feed.locationData = locationData;
  feed.store = {
    dispatch: sinon.spy(),
    getState() {
      return this.state;
    },
    state: {
      Prefs: {
        values: {
          "weather.query": "348794",
        },
      },
    },
  };

  info("WeatherFeed.onAction INIT should initialize Weather");

  await feed.onAction({
    type: actionTypes.INIT,
  });

  Assert.equal(feed.store.dispatch.callCount, 2);
  Assert.ok(
    feed.store.dispatch.calledWith(
      actionCreators.BroadcastToContent({
        type: actionTypes.WEATHER_UPDATE,
        data: {
          suggestions: [WEATHER_SUGGESTION],
          hourlyForecasts: [],
          lastUpdated: dateNowTestValue,
          locationData,
        },
      })
    )
  );
  Services.prefs.clearUserPref(WEATHER_ENABLED);
  sandbox.restore();
});

// Test if location lookup was successful
add_task(async function test_onAction_opt_in_location_success() {
  let sandbox = sinon.createSandbox();

  sandbox.stub(WeatherFeed.prototype, "PersistentCache").returns({
    set: () => {},
    get: () => {},
  });

  let feed = new WeatherFeed();

  feed.store = {
    dispatch: sinon.spy(),
    getState() {
      return { Prefs: { values: {} } };
    },
  };

  // Stub _fetchNormalizedLocation() to simulate a successful lookup
  sandbox.stub(feed, "_fetchNormalizedLocation").resolves({
    localized_name: "Testville",
    administrative_area: "Paris",
    country: "FR",
    key: "12345",
  });

  await feed.onAction({ type: actionTypes.WEATHER_USER_OPT_IN_LOCATION });

  Assert.ok(
    feed.store.dispatch.calledWith(
      actionCreators.SetPref("weather.optInAccepted", true)
    )
  );
  Assert.ok(
    feed.store.dispatch.calledWith(
      actionCreators.SetPref("weather.optInDisplayed", false)
    )
  );

  // Assert location data broadcasted to content
  Assert.ok(
    feed.store.dispatch.calledWith(
      actionCreators.BroadcastToContent({
        type: actionTypes.WEATHER_LOCATION_DATA_UPDATE,
        data: {
          city: "Testville",
          adminName: "Paris",
          country: "FR",
        },
      })
    ),
    "Broadcasts WEATHER_LOCATION_DATA_UPDATE with normalized location data"
  );

  Assert.ok(
    feed.store.dispatch.calledWith(
      actionCreators.SetPref("weather.query", "12345")
    ),
    "Sets weather.query pref from location key"
  );

  sandbox.restore();
});

// Test if no location was found
add_task(async function test_onAction_opt_in_no_location_found() {
  let sandbox = sinon.createSandbox();

  sandbox.stub(WeatherFeed.prototype, "PersistentCache").returns({
    set: () => {},
    get: () => {},
  });

  let feed = new WeatherFeed();

  feed.store = {
    dispatch: sinon.spy(),
    getState() {
      return { Prefs: { values: {} } };
    },
  };

  // Test that _fetchNormalizedLocation doesn't return a location
  sandbox.stub(feed, "_fetchNormalizedLocation").resolves(null);

  await feed.onAction({ type: actionTypes.WEATHER_USER_OPT_IN_LOCATION });

  // Ensure the pref flips always happens so user won’t see the opt-in again
  Assert.ok(
    feed.store.dispatch.calledWith(
      actionCreators.SetPref("weather.optInAccepted", true)
    )
  );
  Assert.ok(
    feed.store.dispatch.calledWith(
      actionCreators.SetPref("weather.optInDisplayed", false)
    )
  );

  Assert.ok(
    !feed.store.dispatch.calledWithMatch(
      actionCreators.BroadcastToContent({
        type: actionTypes.WEATHER_LOCATION_DATA_UPDATE,
      })
    ),
    "Doesn't broadcast location data if location not found"
  );

  Assert.ok(
    !feed.store.dispatch.calledWith(
      actionCreators.SetPref("weather.query", sinon.match.any)
    ),
    "Does not set weather.query if no detected location"
  );

  sandbox.restore();
});

add_task(async function test_fetchLocationAutocomplete_broadcasts_results() {
  let sandbox = sinon.createSandbox();
  sandbox.stub(WeatherFeed.prototype, "PersistentCache").returns({
    set: () => {},
    get: () => {},
  });

  let feed = new WeatherFeed();
  feed.store = {
    dispatch: sinon.spy(),
    getState() {
      return { Weather: { locationSearchString: "Tor" } };
    },
  };
  let autoComplete = sandbox.stub();
  feed.merinoLocationSearch = { autoCompleteWeatherLocation: autoComplete };

  const toronto = { key: "55488", localized_name: "Toronto" };
  const cases = [
    { response: { locations: [toronto] }, expected: [toronto] },
    { response: { locations: [] }, expected: [] },
    { response: null, expected: [] },
  ];
  for (const { response, expected } of cases) {
    feed.store.dispatch.resetHistory();
    autoComplete.resolves(response);

    await feed.fetchLocationAutocomplete();

    Assert.deepEqual(
      feed.store.dispatch.firstCall.args[0],
      actionCreators.BroadcastToContent({
        type: actionTypes.WEATHER_LOCATION_SUGGESTIONS_UPDATE,
        data: expected,
      }),
      `Broadcasts ${expected.length} suggestion(s) for ${JSON.stringify(response)}`
    );
  }

  sandbox.restore();
});

// Test fetching weather information using GeolocationUtils.geolocation()
add_task(async function test_fetch_weather_with_geolocation() {
  const TEST_DATA = [
    {
      geolocation: {
        country_code: "US",
        region_code: "CA",
        region: "Califolnia",
        city: "San Francisco",
      },
      expected: {
        country: "US",
        region: "CA",
        city: "San Francisco",
      },
    },
    {
      geolocation: {
        country_code: "JP",
        region_code: "14",
        region: "Kanagawa",
        city: "",
      },
      expected: {
        country: "JP",
        region: "14",
        city: "Kanagawa",
      },
    },
    {
      geolocation: {
        country_code: "TestCountry",
        region_code: "",
        region: "TestRegion",
        city: "TestCity",
      },
      expected: {
        country: "TestCountry",
        region: "TestRegion",
        city: "TestCity",
      },
    },
    {
      // Test city-state fallback: Singapore (no region field)
      geolocation: {
        country_code: "SG",
        region_code: null,
        region: null,
        city: "Singapore",
      },
      expected: {
        country: "SG",
        region: "Singapore", // City used as fallback for region
        city: "Singapore",
      },
    },
    {
      // Test city-state fallback: Monaco (no region field)
      geolocation: {
        country_code: "MC",
        city: "Monaco",
      },
      expected: {
        country: "MC",
        region: "Monaco", // City used as fallback for region
        city: "Monaco",
      },
    },
    {
      geolocation: {
        country_code: "TestCountry",
      },
      expected: false,
    },
    {
      geolocation: {
        region_code: "TestRegionCode",
      },
      expected: false,
    },
    {
      geolocation: {
        region: "TestRegion",
      },
      expected: false,
    },
    {
      geolocation: {
        city: "TestCity",
      },
      expected: false,
    },
    {
      geolocation: {},
      expected: false,
    },
    {
      geolocation: null,
      expected: false,
    },
  ];

  for (let { geolocation, expected } of TEST_DATA) {
    info(`Test for ${JSON.stringify(geolocation)}`);

    let sandbox = sinon.createSandbox();
    sandbox.stub(WeatherFeed.prototype, "PersistentCache").returns({
      set: () => {},
      get: () => {},
    });

    let feed = new WeatherFeed();
    sandbox.stub(feed, "isEnabled").returns(true);
    feed.store = {
      dispatch: sinon.spy(),
      getState() {
        return { Prefs: { values: {} } };
      },
    };
    feed.merino = feed.MerinoClient();

    // Stub merino client
    let stub = sandbox.stub(feed.merino, "fetchWeatherReport").resolves(null);
    let cleanupGeolocationStub =
      GeolocationTestUtils.stubGeolocation(geolocation);

    await feed.onAction({ type: actionTypes.SYSTEM_TICK });

    if (expected) {
      sinon.assert.calledOnce(stub);
      sinon.assert.calledWith(stub, {
        source: "newtab",
        locationName: undefined,
        ...expected,
        timeoutMs: 7000,
        onResult: sinon.match.func,
      });
    } else {
      sinon.assert.notCalled(stub);
    }

    await cleanupGeolocationStub();
    sandbox.restore();
  }
});

// Bug 2046143: the Nova widget shows the opt-in prompt in place of weather, so
// the feed must not geolocate + fetch location weather before the user opts in.
// The gate is scoped to nova.enabled so the legacy widget (which renders its
// opt-in dialog only over a fetched suggestion) keeps fetching as before.
add_task(async function test_fetch_weather_optin_gate() {
  const VALID_GEOLOCATION = {
    country_code: "DE",
    region_code: "BE",
    region: "Berlin",
    city: "Berlin",
  };

  const TEST_DATA = [
    {
      desc: "nova + region opt-in required, not accepted -> no fetch",
      values: {
        "nova.enabled": true,
        "system.showWeatherOptIn": true,
        "weather.optInAccepted": false,
      },
      shouldFetch: false,
    },
    {
      desc: "nova + trainhop opt-in required, not accepted -> no fetch",
      values: {
        "nova.enabled": true,
        trainhopConfig: { weather: { weatherOptInEnabled: true } },
        "weather.optInAccepted": false,
      },
      shouldFetch: false,
    },
    {
      desc: "nova + widgetWeather trainhop opt-in required, not accepted -> no fetch",
      values: {
        "nova.enabled": true,
        trainhopConfig: { widgetWeather: { weatherOptInEnabled: true } },
        "weather.optInAccepted": false,
      },
      shouldFetch: false,
    },
    {
      desc: "nova + widgetWeather opt-in false overrides legacy weather key -> fetch",
      values: {
        "nova.enabled": true,
        trainhopConfig: {
          widgetWeather: { weatherOptInEnabled: false },
          weather: { weatherOptInEnabled: true },
        },
        "weather.optInAccepted": false,
      },
      shouldFetch: true,
    },
    {
      desc: "nova + opt-in required, accepted -> fetch",
      values: {
        "nova.enabled": true,
        "system.showWeatherOptIn": true,
        "weather.optInAccepted": true,
      },
      shouldFetch: true,
    },
    {
      desc: "nova + non-opt-in region -> fetch",
      values: {
        "nova.enabled": true,
        "system.showWeatherOptIn": false,
        "weather.optInAccepted": false,
      },
      shouldFetch: true,
    },
    {
      desc: "legacy (nova disabled) + opt-in required, not accepted -> still fetch",
      values: {
        "nova.enabled": false,
        "system.showWeatherOptIn": true,
        "weather.optInAccepted": false,
      },
      shouldFetch: true,
    },
  ];

  for (let { desc, values, shouldFetch } of TEST_DATA) {
    info(desc);

    let sandbox = sinon.createSandbox();
    sandbox.stub(WeatherFeed.prototype, "PersistentCache").returns({
      set: () => {},
      get: () => {},
    });

    let feed = new WeatherFeed();
    sandbox.stub(feed, "isEnabled").returns(true);
    feed.store = {
      dispatch: sinon.spy(),
      getState() {
        return { Prefs: { values } };
      },
    };
    feed.merino = feed.MerinoClient();

    let stub = sandbox.stub(feed.merino, "fetchWeatherReport").resolves(null);
    let cleanupGeolocationStub =
      GeolocationTestUtils.stubGeolocation(VALID_GEOLOCATION);

    await feed.onAction({ type: actionTypes.SYSTEM_TICK });

    if (shouldFetch) {
      sinon.assert.calledOnce(stub);
    } else {
      sinon.assert.notCalled(stub);
    }

    await cleanupGeolocationStub();
    sandbox.restore();
  }
});

// Test detecting location using GeolocationUtils.geolocation()
add_task(async function test_detect_location_with_geolocation() {
  const TEST_DATA = [
    {
      geolocation: {
        city: "San Francisco",
      },
      expected: "San Francisco",
    },
    {
      geolocation: {
        city: "",
        region: "Yokohama",
      },
      expected: "Yokohama",
    },
    {
      geolocation: {
        region: "Tokyo",
      },
      expected: "Tokyo",
    },
    {
      geolocation: {
        city: "",
        region: "",
      },
      expected: false,
    },
    {
      geolocation: {},
      expected: false,
    },
    {
      geolocation: null,
      expected: false,
    },
  ];
  for (let { geolocation, expected } of TEST_DATA) {
    info(`Test for ${JSON.stringify(geolocation)}`);

    let sandbox = sinon.createSandbox();
    sandbox.stub(WeatherFeed.prototype, "PersistentCache").returns({
      set: () => {},
      get: () => {},
    });

    let feed = new WeatherFeed();
    feed.store = {
      dispatch: sinon.spy(),
      getState() {
        return { Prefs: { values: {} } };
      },
    };
    feed.merinoLocationDetect = { fetch: () => {} };

    // Stub merino client
    let stub = sandbox.stub(feed.merinoLocationDetect, "fetch").resolves(null);
    // Stub geolocation
    let cleanupGeolocationStub =
      GeolocationTestUtils.stubGeolocation(geolocation);
    await feed.onAction({ type: actionTypes.WEATHER_USER_OPT_IN_LOCATION });

    if (expected) {
      sinon.assert.calledOnce(stub);
      sinon.assert.calledWith(stub, {
        otherParams: { request_type: "location", source: "newtab" },
        providers: ["accuweather"],
        query: expected,
        timeoutMs: 7000,
        onResult: sinon.match.func,
      });
    } else {
      sinon.assert.notCalled(stub);
    }

    await cleanupGeolocationStub();
    sandbox.restore();
  }
});

// Creates a WeatherFeed with stubbed merino methods and a virtual setTimeout
// so that _fetchHelper retry behavior can be driven synchronously.

function setupFetchHelperHarness(sandbox, outcomes, hourlyOutcomes = null) {
  // Prevent the "next fetch" scheduling inside fetchHelper().
  sandbox.stub(WeatherFeed.prototype, "restartFetchTimer").returns(undefined);

  // Stub setTimeout to capture the retry callback without actually waiting.
  // triggerRetry() fires it on demand so the test controls timing exactly.
  let timeoutCallback = null;
  const setTimeoutStub = sandbox
    .stub(WeatherFeed.prototype, "setTimeout")
    .callsFake(cb => {
      timeoutCallback = cb;
      return 1;
    });

  const feed = new WeatherFeed();

  // When testing hourly retries, enable the forecast widget so _fetchHelper
  // calls fetchHourlyForecasts inside its Promise.all.
  // weather.display and widgets.system.weatherForecast.enabled are the two
  // flags _fetchHelper checks to decide whether to call fetchHourlyForecasts.
  const prefValues =
    hourlyOutcomes !== null
      ? {
          "weather.display": "detailed",
          "widgets.system.weatherForecast.enabled": true,
          "widgets.weather.size": "large",
        }
      : {};

  feed.store = {
    dispatch: sinon.spy(),
    getState() {
      return { Prefs: { values: prefValues } };
    },
  };

  const fetchStub = sinon.stub();
  outcomes.forEach((outcome, index) => {
    if (outcome === "reject") {
      fetchStub.onCall(index).rejects(new Error(`fail${index}`));
    } else if (outcome === "resolve") {
      fetchStub.onCall(index).resolves({ city_name: "RetryCity" });
    }
  });

  feed.merino = { fetchWeatherReport: fetchStub };

  if (hourlyOutcomes !== null) {
    const fetchHourlyStub = sinon.stub();
    hourlyOutcomes.forEach((outcome, index) => {
      if (outcome === "reject") {
        fetchHourlyStub.onCall(index).rejects(new Error(`hourlyFail${index}`));
      } else if (outcome === "resolve") {
        fetchHourlyStub.onCall(index).resolves([{ hour: 0 }]);
      }
    });
    feed.merino.fetchHourlyForecasts = fetchHourlyStub;
  }

  return {
    feed,
    setTimeoutStub,
    triggerRetry: () => timeoutCallback && timeoutCallback(),
  };
}

add_task(async function test_fetchHelper_retry_resolve() {
  const sandbox = sinon.createSandbox();

  const { feed, setTimeoutStub, triggerRetry } = setupFetchHelperHarness(
    sandbox,
    ["reject", "resolve"]
  );

  // After retry success, fetchHelper should resolve to RetryCity.
  const promise = feed._fetchHelper(1, "q");

  // Two microtask turns are needed: one for Promise.all to process the
  // rejection, and one for the catch block to run and call setTimeout.
  await Promise.resolve();
  await Promise.resolve();

  Assert.equal(feed.merino.fetchWeatherReport.callCount, 1);
  Assert.equal(setTimeoutStub.callCount, 1);
  Assert.ok(
    setTimeoutStub.calledWith(sinon.match.func, 60 * 1000),
    "retry waits 60s (virtually)"
  );

  // Fire the retry.
  triggerRetry();
  const results = await promise;

  Assert.equal(
    feed.merino.fetchWeatherReport.callCount,
    2,
    "retried exactly once"
  );
  Assert.deepEqual(
    results,
    { suggestions: [{ city_name: "RetryCity" }], hourlyForecasts: [] },
    "returned retry result"
  );

  sandbox.restore();
});

add_task(async function test_fetchHelper_retry_reject() {
  const sandbox = sinon.createSandbox();

  const { feed, setTimeoutStub, triggerRetry } = setupFetchHelperHarness(
    sandbox,
    ["reject", "reject"]
  );

  // After retry also fails, fetchHelper should resolve to [].
  const promise = feed._fetchHelper(1, "q");

  // Two microtask turns are needed: one for Promise.all to process the
  // rejection, and one for the catch block to run and call setTimeout.
  await Promise.resolve();
  await Promise.resolve();

  Assert.equal(feed.merino.fetchWeatherReport.callCount, 1);
  Assert.equal(setTimeoutStub.callCount, 1);
  Assert.ok(
    setTimeoutStub.calledWith(sinon.match.func, 60 * 1000),
    "retry waits 60s (virtually)"
  );

  // Fire the retry.
  triggerRetry();
  const results = await promise;

  Assert.equal(
    feed.merino.fetchWeatherReport.callCount,
    2,
    "retried exactly once then gave up"
  );
  Assert.deepEqual(
    results,
    { suggestions: [], hourlyForecasts: [] },
    "returns empty object after exhausting retries"
  );

  sandbox.restore();
});

add_task(async function test_fetchHelper_hourly_failure_nonfatal() {
  const sandbox = sinon.createSandbox();

  // Hourly rejects, but report succeeds — result should still include the
  // weather report and no retry should be scheduled.
  const { feed, setTimeoutStub } = setupFetchHelperHarness(
    sandbox,
    ["resolve"],
    ["reject"]
  );

  const results = await feed._fetchHelper(1, "q");

  Assert.equal(feed.merino.fetchWeatherReport.callCount, 1);
  Assert.equal(feed.merino.fetchHourlyForecasts.callCount, 1);
  Assert.equal(setTimeoutStub.callCount, 0, "no retry scheduled");
  Assert.deepEqual(
    results,
    { suggestions: [{ city_name: "RetryCity" }], hourlyForecasts: [] },
    "report returned even when hourly fails"
  );

  sandbox.restore();
});

add_task(async function test_fetchHelper_small_size_skips_hourly() {
  const sandbox = sinon.createSandbox();

  sandbox.stub(WeatherFeed.prototype, "restartFetchTimer").returns(undefined);

  const feed = new WeatherFeed();
  feed.store = {
    dispatch: sinon.spy(),
    getState() {
      return {
        Prefs: {
          values: {
            "weather.display": "detailed",
            "widgets.system.weatherForecast.enabled": true,
            "widgets.weather.size": "small",
          },
        },
      };
    },
  };
  feed.merino = {
    fetchWeatherReport: sinon.stub().resolves({ city_name: "SidebarCity" }),
    fetchHourlyForecasts: sinon.stub().resolves([{ hour: 0 }]),
  };

  const results = await feed._fetchHelper(1, "q");

  Assert.equal(
    feed.merino.fetchHourlyForecasts.callCount,
    0,
    "hourly not fetched for small widget"
  );
  Assert.deepEqual(
    results,
    { suggestions: [{ city_name: "SidebarCity" }], hourlyForecasts: [] },
    "report returned without hourly data"
  );

  sandbox.restore();
});

add_task(async function test_isEnabled_classic_mode() {
  let sandbox = sinon.createSandbox();
  sandbox.stub(WeatherFeed.prototype, "PersistentCache").returns({
    set: () => {},
    get: () => {},
  });

  let feed = new WeatherFeed();
  feed.store = {
    getState() {
      return {
        Prefs: {
          values: {
            showWeather: true,
            "system.showWeather": true,
            "nova.enabled": false,
            "widgets.weather.enabled": false,
          },
        },
      };
    },
  };

  Assert.ok(
    feed.isEnabled(),
    "isEnabled returns true when showWeather is true in classic mode"
  );

  feed.store.getState = () => ({
    Prefs: {
      values: {
        showWeather: false,
        "system.showWeather": true,
        "nova.enabled": false,
        "widgets.weather.enabled": true,
      },
    },
  });

  Assert.ok(
    !feed.isEnabled(),
    "isEnabled returns false when showWeather is false in classic mode"
  );

  sandbox.restore();
});

add_task(async function test_isEnabled_via_trainhop_namespace() {
  let sandbox = sinon.createSandbox();
  sandbox.stub(WeatherFeed.prototype, "PersistentCache").returns({
    set: () => {},
    get: () => {},
  });

  let feed = new WeatherFeed();
  feed.store = {
    getState() {
      return {
        Prefs: {
          values: {
            "nova.enabled": true,
            "widgets.weather.enabled": true,
            trainhopConfig: { widgetWeather: { visible: true } },
          },
        },
      };
    },
  };

  Assert.ok(
    feed.isEnabled(),
    "isEnabled returns true via trainhopConfig.widgetWeather.visible"
  );

  sandbox.restore();
});

add_task(async function test_isEnabled_nova_mode() {
  let sandbox = sinon.createSandbox();
  sandbox.stub(WeatherFeed.prototype, "PersistentCache").returns({
    set: () => {},
    get: () => {},
  });

  let feed = new WeatherFeed();
  feed.store = {
    getState() {
      return {
        Prefs: {
          values: {
            showWeather: true,
            "system.showWeather": true,
            "nova.enabled": true,
            "widgets.weather.enabled": true,
          },
        },
      };
    },
  };

  Assert.ok(
    feed.isEnabled(),
    "isEnabled returns true when widgets.weather.enabled is true in Nova mode"
  );

  feed.store.getState = () => ({
    Prefs: {
      values: {
        showWeather: true,
        "system.showWeather": true,
        "nova.enabled": true,
        "widgets.weather.enabled": false,
      },
    },
  });

  Assert.ok(
    !feed.isEnabled(),
    "isEnabled returns false when widgets.weather.enabled is false in Nova mode"
  );

  sandbox.restore();
});

add_task(async function test_onPrefChanged_widgets_weather_enabled() {
  let sandbox = sinon.createSandbox();
  sandbox.stub(WeatherFeed.prototype, "PersistentCache").returns({
    set: () => {},
    get: () => {},
  });

  let feed = new WeatherFeed();
  feed.store = {
    dispatch: sinon.spy(),
    getState() {
      return {
        Prefs: {
          values: {
            showWeather: true,
            "system.showWeather": true,
            "nova.enabled": true,
            "widgets.weather.enabled": false,
          },
        },
      };
    },
  };
  feed.loaded = true;

  const resetWeatherStub = sandbox.stub(feed, "resetWeather").resolves();
  const loadWeatherStub = sandbox.stub(feed, "loadWeather").resolves();

  await feed.onPrefChangedAction({
    data: { name: "widgets.weather.enabled" },
  });

  Assert.ok(
    resetWeatherStub.calledOnce,
    "resetWeather called when widgets.weather.enabled is set to false"
  );
  Assert.ok(loadWeatherStub.notCalled, "loadWeather not called");

  feed.loaded = false;
  feed.store.getState = () => ({
    Prefs: {
      values: {
        showWeather: true,
        "system.showWeather": true,
        "nova.enabled": true,
        "widgets.weather.enabled": true,
      },
    },
  });

  await feed.onPrefChangedAction({
    data: { name: "widgets.weather.enabled" },
  });

  Assert.ok(
    loadWeatherStub.calledOnce,
    "loadWeather called when widgets.weather.enabled is set to true"
  );

  sandbox.restore();
});

add_task(async function test_optin_regions_in_default_region_weather_config() {
  const { WEATHER_OPTIN_REGIONS } = ChromeUtils.importESModule(
    "resource://newtab/lib/ActivityStream.sys.mjs"
  );
  const defaultRegions = Services.prefs
    .getDefaultBranch(null)
    .getStringPref(
      "browser.newtabpage.activity-stream.discoverystream.region-weather-config"
    )
    .split(",")
    .map(region => region.trim());

  // Opt-in regions where Weather is not yet enabled by default.
  const NOT_ENABLED_BY_DEFAULT = ["LU"];

  for (const region of WEATHER_OPTIN_REGIONS) {
    if (NOT_ENABLED_BY_DEFAULT.includes(region)) {
      continue;
    }
    Assert.ok(
      defaultRegions.includes(region),
      `Opt-in region ${region} is in the default region-weather-config pref`
    );
  }
});

const MERINO_KEYS = [
  "weather_report",
  "weather_forecast",
  "weather_location_search",
  "weather_location_detect",
  "weather_geolocation",
];
const MERINO_CATEGORIES = [
  "success",
  "no_suggestion",
  "timeout",
  "network_error",
  "http_4xx",
  "http_5xx",
];
const UNREACHABLE_URL = "http://localhost/valid-but-unreachable-url";
const REPORT_SUCCESS = {
  body: { request_id: "report", suggestions: [WEATHER_SUGGESTION] },
};
const EMPTY_RESPONSE = { body: { request_id: "empty", suggestions: [] } };
const HOURLY_FORECASTS = [
  {
    date_time: "2026-11-20T10:00:00-05:00",
    epoch_date_time: 1795186800,
    icon_id: 1,
    temperature: { c: 5, f: 41 },
    url: "https://example.com/hourly",
  },
];
const TORONTO = { key: "55488", localized_name: "Toronto" };
const LOCATION_SUCCESS = {
  body: { request_id: "location", suggestions: [{ locations: [TORONTO] }] },
};
const LOCATION_NO_MATCH = {
  body: { request_id: "location", suggestions: [{ locations: [] }] },
};
const GEOLOCATION_WITHOUT_CITY = {
  body: {
    request_id: "geolocation",
    suggestions: [
      {
        provider: "geolocation",
        custom_details: { geolocation: { country_code: "US" } },
      },
    ],
  },
};
const GEOLOCATION_SUCCESS = {
  body: {
    request_id: "geolocation",
    suggestions: [MerinoTestUtils.GEOLOCATION_SUGGESTION],
  },
};
const FORECAST_PREFS = {
  "weather.display": "detailed",
  "widgets.system.weatherForecast.enabled": true,
  "widgets.weather.size": "large",
};

/**
 * @returns {object}
 *   The recorded widgets_merino_result counts, as { key: { category: n } }.
 */
function getMerinoResults() {
  let results = {};
  for (let key of MERINO_KEYS) {
    for (let category of MERINO_CATEGORIES) {
      let value = Glean.newtab.widgetsMerinoResult
        .get(key, category)
        .testGetValue();
      if (value) {
        results[key] ??= {};
        results[key][category] = value;
      }
    }
  }
  return results;
}

/**
 * Makes the mock Merino server answer each kind of request with its own
 * response. All of them are sent to the same URL.
 *
 * @param {object} [responses]
 * @param {object} [responses.report]
 * @param {object} [responses.hourly]
 * @param {object} [responses.location]
 * @param {object} [responses.geolocation]
 */
function respondByRequestType({
  report = REPORT_SUCCESS,
  hourly = { body: HOURLY_FORECASTS },
  location = LOCATION_SUCCESS,
  geolocation = GEOLOCATION_SUCCESS,
} = {}) {
  MerinoTestUtils.server.requestHandler = request => {
    let params = new URLSearchParams(request.queryString);
    if (params.get("providers") === "geolocation") {
      return geolocation;
    }
    switch (params.get("request_type")) {
      case "weather":
        return report;
      case "location":
        return location;
      default:
        return hourly;
    }
  };
}

async function withMerinoPrefs(prefs, callback) {
  let original = {};
  for (let [name, value] of Object.entries(prefs)) {
    original[name] = UrlbarPrefs.get(name);
    UrlbarPrefs.set(name, value);
  }
  try {
    await callback();
  } finally {
    for (let [name, value] of Object.entries(original)) {
      UrlbarPrefs.set(name, value);
    }
  }
}

/**
 * Creates a WeatherFeed that talks to the mock Merino server through real
 * MerinoClients.
 *
 * @param {object} sandbox
 * @param {object} [prefValues]
 * @param {object} [cache]
 *   Stands in for the feed's PersistentCache.
 * @returns {WeatherFeed}
 */
function makeMerinoFeed(
  sandbox,
  prefValues = {},
  cache = { set: () => {}, get: () => {} }
) {
  sandbox.stub(WeatherFeed.prototype, "restartFetchTimer").returns(undefined);
  sandbox.stub(WeatherFeed.prototype, "PersistentCache").returns(cache);
  let feed = new WeatherFeed();
  feed.store = {
    dispatch: sinon.spy(),
    getState() {
      return {
        Prefs: { values: prefValues },
        Weather: { locationSearchString: "Tor" },
      };
    },
  };
  feed.locationData = {
    city: "Toronto",
    adminName: { id: "ON" },
    country: { id: "CA" },
  };
  feed.merino = feed.MerinoClient("HNT_WEATHER_FEED");
  return feed;
}

add_task(async function test_merino_result_weather_report() {
  const cases = [
    { report: REPORT_SUCCESS, expected: "success" },
    { report: EMPTY_RESPONSE, expected: "no_suggestion" },
    { report: { status: 204 }, expected: "no_suggestion" },
    { report: { status: 404 }, expected: "http_4xx" },
    { report: { status: 500 }, expected: "http_5xx" },
    { report: { ...REPORT_SUCCESS, delay: 1000 }, expected: "timeout" },
  ];
  for (let { report, expected } of cases) {
    info(`Report response ${JSON.stringify(report)}`);
    Services.fog.testResetFOG();
    MerinoTestUtils.server.reset();
    respondByRequestType({ report });
    let sandbox = sinon.createSandbox();
    let feed = makeMerinoFeed(sandbox);
    feed.merinoTimeoutMs = 200;

    let results = await feed._fetchHelper(0, "Toronto");

    Assert.equal(
      results.suggestions.length,
      expected === "success" ? 1 : 0,
      "Got the report only on success"
    );
    Assert.deepEqual(
      getMerinoResults(),
      { weather_report: { [expected]: 1 } },
      `Recorded weather_report ${expected}`
    );
    sandbox.restore();
  }
});

add_task(async function test_merino_result_weather_report_network_error() {
  Services.fog.testResetFOG();
  MerinoTestUtils.server.reset();
  let sandbox = sinon.createSandbox();
  let feed = makeMerinoFeed(sandbox);

  await withMerinoPrefs(
    { "merino.weather.reportEndpointURL": UNREACHABLE_URL },
    () => feed._fetchHelper(0, "Toronto")
  );

  Assert.deepEqual(getMerinoResults(), {
    weather_report: { network_error: 1 },
  });
  sandbox.restore();
});

add_task(async function test_merino_result_weather_forecast() {
  const cases = [
    { hourly: { body: HOURLY_FORECASTS }, expected: "success" },
    { hourly: { status: 500, body: HOURLY_FORECASTS }, expected: "http_5xx" },
    { hourly: { status: 404 }, expected: "http_4xx" },
    {
      hourly: { contentType: "text/plain", body: "not json" },
      expected: "no_suggestion",
    },
    { hourly: { body: { detail: "oops" } }, expected: "no_suggestion" },
    { hourly: { body: "[]" }, expected: "no_suggestion" },
    {
      hourly: { body: HOURLY_FORECASTS, delay: 1000 },
      expected: "timeout",
    },
  ];
  for (let { hourly, expected } of cases) {
    info(`Hourly response ${JSON.stringify(hourly)}`);
    Services.fog.testResetFOG();
    MerinoTestUtils.server.reset();
    respondByRequestType({ hourly });
    let sandbox = sinon.createSandbox();
    let feed = makeMerinoFeed(sandbox, FORECAST_PREFS);
    feed.merinoTimeoutMs = 200;

    let results = await feed._fetchHelper(0, "Toronto");

    Assert.equal(results.suggestions.length, 1, "Got the weather report");
    Assert.deepEqual(
      results.hourlyForecasts,
      expected === "success" ? HOURLY_FORECASTS : [],
      "Got the hourly forecasts only on success"
    );
    Assert.deepEqual(
      getMerinoResults(),
      {
        weather_report: { success: 1 },
        weather_forecast: { [expected]: 1 },
      },
      `Recorded weather_forecast ${expected}`
    );
    sandbox.restore();
  }
});

add_task(async function test_merino_result_weather_forecast_network_error() {
  Services.fog.testResetFOG();
  MerinoTestUtils.server.reset();
  respondByRequestType();
  let sandbox = sinon.createSandbox();
  let feed = makeMerinoFeed(sandbox, FORECAST_PREFS);

  let results;
  await withMerinoPrefs(
    { "merino.weather.hourlyEndpointURL": UNREACHABLE_URL },
    async () => {
      results = await feed._fetchHelper(0, "Toronto");
    }
  );

  Assert.deepEqual(results.hourlyForecasts, [], "Got no hourly forecasts");
  Assert.deepEqual(getMerinoResults(), {
    weather_report: { success: 1 },
    weather_forecast: { network_error: 1 },
  });
  sandbox.restore();
});

// With no location set, the feed asks Merino for the geolocation first. That
// request is counted, and when it fails no weather request is sent.
add_task(async function test_merino_result_weather_geolocation() {
  const cases = [
    {
      geolocation: GEOLOCATION_SUCCESS,
      expected: {
        weather_geolocation: { success: 1 },
        weather_report: { success: 1 },
      },
      expectedRequests: 2,
    },
    {
      geolocation: EMPTY_RESPONSE,
      expected: { weather_geolocation: { no_suggestion: 1 } },
      expectedRequests: 1,
    },
    {
      geolocation: GEOLOCATION_WITHOUT_CITY,
      expected: { weather_geolocation: { no_suggestion: 1 } },
      expectedRequests: 1,
    },
    {
      geolocation: { status: 500 },
      expected: { weather_geolocation: { http_5xx: 1 } },
      expectedRequests: 1,
    },
  ];
  for (let { geolocation, expected, expectedRequests } of cases) {
    info(`Geolocation response ${JSON.stringify(geolocation)}`);
    Services.fog.testResetFOG();
    MerinoTestUtils.server.reset();
    respondByRequestType({ geolocation });
    let sandbox = sinon.createSandbox();
    let feed = makeMerinoFeed(sandbox);

    await feed._fetchHelper(0);

    Assert.deepEqual(getMerinoResults(), expected, "Recorded results");
    Assert.equal(
      MerinoTestUtils.server.requests.length,
      expectedRequests,
      "Number of requests sent"
    );
    sandbox.restore();
  }
});

add_task(async function test_merino_result_not_counted_without_request() {
  Services.fog.testResetFOG();
  MerinoTestUtils.server.reset();
  let sandbox = sinon.createSandbox();
  let feed = makeMerinoFeed(sandbox, FORECAST_PREFS);

  await withMerinoPrefs(
    {
      "merino.endpointURL": "",
      "merino.weather.reportEndpointURL": "",
      "merino.weather.hourlyEndpointURL": "",
    },
    async () => {
      await feed._fetchHelper(0, "Toronto");
      await feed.fetchLocationAutocomplete();
    }
  );

  Assert.deepEqual(getMerinoResults(), {}, "Nothing is recorded");
  Assert.equal(MerinoTestUtils.server.requests.length, 0, "No requests");
  sandbox.restore();
});

add_task(async function test_merino_result_superseded_report_not_counted() {
  Services.fog.testResetFOG();
  MerinoTestUtils.server.reset();
  let requestCount = 0;
  MerinoTestUtils.server.requestHandler = () =>
    requestCount++ ? REPORT_SUCCESS : { ...REPORT_SUCCESS, delay: 60000 };
  let sandbox = sinon.createSandbox();
  let feed = makeMerinoFeed(sandbox);

  let requestPromise = MerinoTestUtils.server.waitForNextRequest();
  let firstFetch = feed._fetchHelper(0, "Toronto");
  await requestPromise;
  let second = await feed._fetchHelper(0, "Toronto");
  let first = await firstFetch;

  Assert.equal(first.suggestions.length, 0, "The first fetch was superseded");
  Assert.equal(second.suggestions.length, 1, "The second fetch got a report");
  Assert.deepEqual(
    getMerinoResults(),
    { weather_report: { success: 1 } },
    "Only the second request is counted"
  );
  MerinoTestUtils.server.reset();
  sandbox.restore();
});

add_task(async function test_merino_result_weather_location_search() {
  const cases = [
    { location: LOCATION_SUCCESS, expected: "success" },
    { location: EMPTY_RESPONSE, expected: "no_suggestion" },
    { location: LOCATION_NO_MATCH, expected: "no_suggestion" },
    { location: { status: 500 }, expected: "http_5xx" },
  ];
  for (let { location, expected } of cases) {
    Services.fog.testResetFOG();
    MerinoTestUtils.server.reset();
    respondByRequestType({ location });
    let sandbox = sinon.createSandbox();
    let feed = makeMerinoFeed(sandbox);

    await feed.fetchLocationAutocomplete();

    Assert.deepEqual(
      getMerinoResults(),
      { weather_location_search: { [expected]: 1 } },
      `Recorded weather_location_search ${expected}`
    );
    sandbox.restore();
  }
});

// Location search has its own MerinoClient, so it doesn't abort a weather
// report that is in flight.
add_task(async function test_merino_result_location_search_keeps_report() {
  Services.fog.testResetFOG();
  MerinoTestUtils.server.reset();
  respondByRequestType({ report: { ...REPORT_SUCCESS, delay: 300 } });
  let sandbox = sinon.createSandbox();
  let feed = makeMerinoFeed(sandbox);

  let requestPromise = MerinoTestUtils.server.waitForNextRequest();
  let reportFetch = feed._fetchHelper(0, "Toronto");
  await requestPromise;
  await feed.fetchLocationAutocomplete();
  let results = await reportFetch;

  Assert.equal(results.suggestions.length, 1, "The report was not aborted");
  Assert.deepEqual(getMerinoResults(), {
    weather_report: { success: 1 },
    weather_location_search: { success: 1 },
  });
  sandbox.restore();
});

// So does location detect.
add_task(async function test_merino_result_location_detect_keeps_report() {
  Services.fog.testResetFOG();
  MerinoTestUtils.server.reset();
  respondByRequestType({ report: { ...REPORT_SUCCESS, delay: 300 } });
  let sandbox = sinon.createSandbox();
  let feed = makeMerinoFeed(sandbox);

  let requestPromise = MerinoTestUtils.server.waitForNextRequest();
  let reportFetch = feed._fetchHelper(0, "Toronto");
  await requestPromise;
  let location = await feed._fetchNormalizedLocation();
  let results = await reportFetch;

  Assert.deepEqual(location, TORONTO, "The location was detected");
  Assert.equal(results.suggestions.length, 1, "The report was not aborted");
  Assert.deepEqual(getMerinoResults(), {
    weather_report: { success: 1 },
    weather_geolocation: { success: 1 },
    weather_location_detect: { success: 1 },
  });
  sandbox.restore();
});

add_task(async function test_merino_result_weather_location_detect() {
  const cases = [
    {
      responses: {},
      expectedLocation: TORONTO,
      expected: {
        weather_geolocation: { success: 1 },
        weather_location_detect: { success: 1 },
      },
    },
    {
      responses: { location: { status: 404 } },
      expectedLocation: undefined,
      expected: {
        weather_geolocation: { success: 1 },
        weather_location_detect: { http_4xx: 1 },
      },
    },
    {
      responses: { location: LOCATION_NO_MATCH },
      expectedLocation: undefined,
      expected: {
        weather_geolocation: { success: 1 },
        weather_location_detect: { no_suggestion: 1 },
      },
    },
    {
      responses: { geolocation: { status: 500 } },
      expectedLocation: null,
      expected: { weather_geolocation: { http_5xx: 1 } },
    },
    {
      responses: { geolocation: GEOLOCATION_WITHOUT_CITY },
      expectedLocation: null,
      expected: { weather_geolocation: { no_suggestion: 1 } },
    },
  ];
  for (let { responses, expectedLocation, expected } of cases) {
    info(`Responses ${JSON.stringify(responses)}`);
    Services.fog.testResetFOG();
    MerinoTestUtils.server.reset();
    respondByRequestType(responses);
    let sandbox = sinon.createSandbox();
    let feed = makeMerinoFeed(sandbox);

    let location = await feed._fetchNormalizedLocation();

    Assert.deepEqual(location, expectedLocation, "Detected location");
    Assert.deepEqual(getMerinoResults(), expected, "Recorded results");
    sandbox.restore();
  }
});

// The cache is only written after a fetch that returned data, so a failing
// client fetches again on every SYSTEM_TICK and a succeeding one doesn't.
add_task(async function test_merino_result_failed_fetch_retried_each_tick() {
  Services.fog.testResetFOG();
  MerinoTestUtils.server.reset();
  respondByRequestType({ report: { status: 500 } });
  let sandbox = sinon.createSandbox();
  let cached = {};
  let feed = makeMerinoFeed(
    sandbox,
    { "weather.query": "Toronto" },
    {
      get: async () => cached,
      set: async (key, value) => {
        cached[key] = value;
      },
    }
  );
  sandbox.stub(feed, "isEnabled").returns(true);

  await feed.onAction({ type: actionTypes.SYSTEM_TICK });
  await feed.onAction({ type: actionTypes.SYSTEM_TICK });
  Assert.deepEqual(
    getMerinoResults(),
    { weather_report: { http_5xx: 2 } },
    "A failed fetch is retried on the next tick"
  );

  respondByRequestType();
  await feed.onAction({ type: actionTypes.SYSTEM_TICK });
  await feed.onAction({ type: actionTypes.SYSTEM_TICK });
  Assert.deepEqual(
    getMerinoResults(),
    { weather_report: { http_5xx: 2, success: 1 } },
    "After a successful fetch, the next tick sends no request"
  );
  sandbox.restore();
});

// On a Firefox whose MerinoClient predates onResult, the options are ignored:
// the feed still gets its data, and nothing is recorded.
add_task(async function test_merino_result_client_without_onResult() {
  Services.fog.testResetFOG();
  let sandbox = sinon.createSandbox();
  let feed = makeMerinoFeed(sandbox, FORECAST_PREFS);
  feed.merino = {
    fetchWeatherReport: async () => WEATHER_SUGGESTION,
    fetchHourlyForecasts: async () => HOURLY_FORECASTS,
  };

  let results = await feed._fetchHelper(0, "Toronto");

  Assert.deepEqual(results, {
    suggestions: [WEATHER_SUGGESTION],
    hourlyForecasts: HOURLY_FORECASTS,
  });
  Assert.deepEqual(getMerinoResults(), {}, "Nothing is recorded");
  sandbox.restore();
});
