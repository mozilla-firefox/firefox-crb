/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

do_get_profile();

const { ExaSearchProvider } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/models/search/SearchProviders.sys.mjs"
);

const PREF_EXTRA_HEADERS = "browser.smartwindow.extraHeaders";
const PREF_APIKEY = "browser.smartwindow.searchQuery.apiKey";

async function searchHeaders() {
  const originalFetch = ExaSearchProvider._fetch;
  let headers;
  ExaSearchProvider._fetch = async (_url, options) => {
    headers = options.headers;
    return { ok: true, status: 200, json: async () => ({ results: [] }) };
  };
  try {
    await new ExaSearchProvider().search("weather");
  } finally {
    ExaSearchProvider._fetch = originalFetch;
  }
  return headers;
}

add_setup(() => {
  Services.prefs.setStringPref(PREF_APIKEY, "test-token");
  registerCleanupFunction(() => {
    Services.prefs.clearUserPref(PREF_APIKEY);
    Services.prefs.clearUserPref(PREF_EXTRA_HEADERS);
  });
});

add_task(async function test_no_extra_headers() {
  Services.prefs.clearUserPref(PREF_EXTRA_HEADERS);
  const headers = await searchHeaders();
  Assert.equal(headers["service-type"], "search");
  Assert.equal(headers.Authorization, "Bearer test-token");
  Assert.ok(!("x-fastly-request" in headers));
});

add_task(async function test_forwards_only_fastly_request_header() {
  Services.prefs.setStringPref(
    PREF_EXTRA_HEADERS,
    JSON.stringify({
      "X-Fastly-Request": "fastly-key",
      "service-type": "mochi-dev",
      "x-dev-authorization": "dev-key",
    })
  );
  const headers = await searchHeaders();
  Assert.equal(headers["x-fastly-request"], "fastly-key");
  Assert.equal(headers["service-type"], "search");
  Assert.ok(!("x-dev-authorization" in headers));
});

add_task(async function test_invalid_extra_headers() {
  Services.prefs.setStringPref(PREF_EXTRA_HEADERS, "not json");
  const headers = await searchHeaders();
  Assert.ok(!("x-fastly-request" in headers));
  Assert.equal(headers["service-type"], "search");
});
