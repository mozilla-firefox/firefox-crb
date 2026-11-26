/**
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

do_get_profile();

const { searchBrowsingHistory } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/models/Tools.sys.mjs"
);

/**
 * searchBrowsingHistory tests
 *
 * Wrapper test: ensures Tools.searchBrowsingHistory() returns a valid JSON
 * structure for time-range browsing history search (empty searchTerm).
 */

add_task(async function test_searchBrowsingHistory_wrapper() {
  const output = await searchBrowsingHistory(
    {
      searchTerm: "",
      startTs: null,
      endTs: null,
      historyLimit: 15,
    },
    makeConversation()
  );

  Assert.equal(output.searchTerm, "", "searchTerm match");
  Assert.ok("results" in output, "results field present");
  Assert.ok(Array.isArray(output.results), "results is an array");

  // No error expected for empty searchTerm path.
  Assert.ok(!("error" in output), "no error field present");

  // Some basic structure sanity checks.
  Assert.ok("count" in output, "count field present");
  Assert.equal(output.count, output.results.length, "count matches results");
});

/**
 * searchBrowsingHistory wrapper robustness tests
 *
 * Ensures wrapper tolerates missing or invalid tool arguments.
 */

// test: tool called with no arguments
add_task(async function test_searchBrowsingHistory_wrapper_no_args() {
  const output = await searchBrowsingHistory(undefined, makeConversation());

  Assert.ok("searchTerm" in output, "searchTerm field present");
  Assert.ok("results" in output, "results field present");
  Assert.ok(Array.isArray(output.results), "results is an array");

  // Wrapper may legitimately return an error (e.g. semantic DB not initialized).
  Assert.ok(
    "error" in output || "message" in output,
    "error or message present"
  );
});

// test: tool called with undefined
add_task(async function test_searchBrowsingHistory_wrapper_undefined_args() {
  const output = await searchBrowsingHistory(undefined, makeConversation());

  Assert.ok("searchTerm" in output, "searchTerm field present");
  Assert.ok("results" in output, "results field present");
  Assert.ok(Array.isArray(output.results), "results is an array");
  Assert.ok(
    "error" in output || "message" in output,
    "error or message present"
  );
});

// test: tool called with null
add_task(async function test_searchBrowsingHistory_wrapper_null_args() {
  const output = await searchBrowsingHistory(null, makeConversation());

  Assert.ok("searchTerm" in output, "searchTerm field present");
  Assert.ok("results" in output, "results field present");
  Assert.ok(Array.isArray(output.results), "results is an array");
  Assert.ok(
    "error" in output || "message" in output,
    "error or message present"
  );
});

// test: tool called with non-object (string)
add_task(async function test_searchBrowsingHistory_wrapper_string_args() {
  const output = await searchBrowsingHistory("mozilla", makeConversation());

  Assert.ok("searchTerm" in output, "searchTerm field present");
  Assert.ok("results" in output, "results field present");
  Assert.ok(Array.isArray(output.results), "results is an array");
  Assert.ok(
    "error" in output || "message" in output,
    "error or message present"
  );
});

// test: tool called with non-object (number)
add_task(async function test_searchBrowsingHistory_wrapper_number_args() {
  const output = await searchBrowsingHistory(123, makeConversation());

  Assert.ok("searchTerm" in output, "searchTerm field present");
  Assert.ok("results" in output, "results field present");
  Assert.ok(Array.isArray(output.results), "results is an array");
  Assert.ok(
    "error" in output || "message" in output,
    "error or message present"
  );
});

add_task(async function test_searchBrowsingHistory_sets_security_flags() {
  const conversation = makeConversation();
  await searchBrowsingHistory({}, conversation);
  conversation.securityProperties.commit();
  Assert.equal(
    conversation.securityProperties.privateData,
    true,
    "private_data flag set"
  );
  Assert.equal(
    conversation.securityProperties.untrustedInput,
    false,
    "untrusted_input not set"
  );
});

add_task(async function test_searchBrowsingHistory_allowed_when_flags_set() {
  const conversation = makeConversation({
    privateData: true,
    untrustedInput: true,
  });
  const output = await searchBrowsingHistory({}, conversation);

  Assert.ok("results" in output, "returns results, not a refusal");
});

// test: tool called with non-object (boolean)
add_task(async function test_searchBrowsingHistory_wrapper_boolean_args() {
  const output = await searchBrowsingHistory(true, makeConversation());

  Assert.ok("searchTerm" in output, "searchTerm field present");
  Assert.ok("results" in output, "results field present");
  Assert.ok(Array.isArray(output.results), "results is an array");
  Assert.ok(
    "error" in output || "message" in output,
    "error or message present"
  );
});

const AITAB_PREF = "browser.smartwindow.aitab.enabled";
const SMART_PAGE_URL = "about:smartpage?page=moth-defences-against-bats";
const WEB_URL = "https://example.com/smart-pages-help";

/**
 * Seeds one generated page and one web page. The generated page needs the
 * AITab pref, because history refuses every other about: URL.
 */
async function seedSmartPageHistory() {
  await PlacesUtils.history.clear();
  Services.prefs.setBoolPref(AITAB_PREF, true);
  registerCleanupFunction(async () => {
    Services.prefs.clearUserPref(AITAB_PREF);
    await PlacesUtils.history.clear();
  });
  await PlacesUtils.history.insertMany([
    {
      url: SMART_PAGE_URL,
      title: "Moth Defences Against Bats",
      visits: [{ date: new Date(Date.now() - 60 * 1000) }],
    },
    {
      url: WEB_URL,
      title: "Smart pages help",
      visits: [{ date: new Date() }],
    },
  ]);
}

add_task(async function test_searchBrowsingHistory_smart_pages_only() {
  await seedSmartPageHistory();

  const output = await searchBrowsingHistory(
    { searchTerm: "smart pages", smartPagesOnly: true },
    makeConversation()
  );

  Assert.deepEqual(
    output.results.map(r => r.url),
    [SMART_PAGE_URL],
    "Only the generated page is returned"
  );
  Assert.equal(
    output.results[0].title,
    '"Moth Defences Against Bats" (Untrusted webpage data)',
    "The title is still marked as untrusted"
  );
});

add_task(async function test_searchBrowsingHistory_smart_pages_only_empty() {
  await seedSmartPageHistory();
  await PlacesUtils.history.remove(SMART_PAGE_URL);

  const output = await searchBrowsingHistory(
    { smartPagesOnly: true },
    makeConversation()
  );

  Assert.equal(output.count, 0, "No generated page is in history");
  Assert.equal(
    output.message,
    "No Smart Pages found in the browser history.",
    "The message names Smart Pages"
  );
});

add_task(
  async function test_searchBrowsingHistory_smart_pages_only_needs_pref() {
    await seedSmartPageHistory();
    Services.prefs.setBoolPref(AITAB_PREF, false);

    const output = await searchBrowsingHistory(
      { smartPagesOnly: true },
      makeConversation()
    );

    Assert.deepEqual(
      output.results.map(r => r.url).sort(),
      [SMART_PAGE_URL, WEB_URL].sort(),
      "smartPagesOnly is ignored while the AITab pref is off"
    );
  }
);

add_task(
  async function test_searchBrowsingHistory_smart_pages_only_is_strict() {
    await seedSmartPageHistory();

    const output = await searchBrowsingHistory(
      { smartPagesOnly: "true" },
      makeConversation()
    );

    Assert.equal(
      output.results.length,
      2,
      "Only the boolean true limits the results to generated pages"
    );
  }
);
