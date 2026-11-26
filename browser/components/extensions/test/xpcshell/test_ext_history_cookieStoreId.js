"use strict";

const { AddonTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/AddonTestUtils.sys.mjs"
);

ChromeUtils.defineESModuleGetters(this, {
  PlacesUtils: "resource://gre/modules/PlacesUtils.sys.mjs",
});

AddonTestUtils.init(this);
AddonTestUtils.overrideCertDB();
AddonTestUtils.createAppInfo(
  "xpcshell@tests.mozilla.org",
  "XPCShell",
  "1",
  "43"
);

const TEST_URL = "https://example.com/";
const RESTRICTED_PREF = "extensions.userContextIsolation.defaults.restricted";

async function insertVisits(url = TEST_URL) {
  let now = Date.now();
  await PlacesUtils.history.insert({
    url,
    visits: [
      { date: new Date(now - 3000) },
      { date: new Date(now - 2000), userContextId: 1 },
      { date: new Date(now - 1000), userContextId: 2 },
    ],
  });
}

async function fetchUserContextIds(url = TEST_URL) {
  let db = await PlacesUtils.promiseDBConnection();
  let rows = await db.execute(
    `SELECT v.userContextId FROM moz_historyvisits v
     JOIN moz_places h ON h.id = v.place_id
     WHERE h.url_hash = hash(:url) AND h.url = :url
     ORDER BY v.visit_date`,
    { url }
  );
  return rows.map(r => r.getResultByName("userContextId"));
}

function loadExtension(permissions) {
  return ExtensionTestUtils.loadExtension({
    manifest: { permissions },
    background() {
      browser.test.onMessage.addListener(async (method, ...args) => {
        let [namespace, name] = method.split(".");
        try {
          let result = await browser[namespace][name](...args);
          browser.test.sendMessage("result", { result });
        } catch (e) {
          browser.test.sendMessage("result", { error: e.message });
        }
      });
    },
  });
}

async function callAPI(extension, method, ...args) {
  extension.sendMessage(method, ...args);
  return extension.awaitMessage("result");
}

add_setup(async function () {
  Services.prefs.setBoolPref("privacy.userContext.enabled", true);
  registerCleanupFunction(() => {
    Services.prefs.clearUserPref("privacy.userContext.enabled");
    Services.prefs.clearUserPref(RESTRICTED_PREF);
  });
});

add_task(async function test_getVisits() {
  await PlacesUtils.history.clear();
  await insertVisits();

  let extension = loadExtension(["history"]);
  await extension.startup();

  let { result } = await callAPI(extension, "history.getVisits", {
    url: TEST_URL,
  });
  Assert.deepEqual(
    result.map(v => v.cookieStoreId),
    ["firefox-container-2", "firefox-container-1", "firefox-default"],
    "getVisits should return the cookieStoreId of each visit"
  );

  await extension.unload();
});

add_task(async function test_onVisited() {
  await PlacesUtils.history.clear();

  let extension = ExtensionTestUtils.loadExtension({
    manifest: { permissions: ["history"] },
    background() {
      browser.history.onVisited.addListener(({ url, cookieStoreId }) => {
        browser.test.sendMessage("visited", { url, cookieStoreId });
      });
      browser.test.sendMessage("ready");
    },
  });
  await extension.startup();
  await extension.awaitMessage("ready");

  await PlacesUtils.history.insert({
    url: `${TEST_URL}container`,
    visits: [{ userContextId: 1 }],
  });
  await PlacesUtils.history.insert({
    url: `${TEST_URL}default`,
    visits: [{}],
  });

  Assert.deepEqual(
    await extension.awaitMessage("visited"),
    { url: `${TEST_URL}container`, cookieStoreId: "firefox-container-1" },
    "onVisited should report the container"
  );
  Assert.deepEqual(
    await extension.awaitMessage("visited"),
    { url: `${TEST_URL}default`, cookieStoreId: "firefox-default" },
    "onVisited should report the default container"
  );

  await extension.unload();
});

add_task(async function test_addUrl() {
  await PlacesUtils.history.clear();

  let extension = loadExtension(["history", "cookies"]);
  await extension.startup();

  let now = Date.now();
  for (let [index, cookieStoreId] of [
    "firefox-default",
    "firefox-container-1",
    undefined,
  ].entries()) {
    let { error } = await callAPI(extension, "history.addUrl", {
      url: TEST_URL,
      visitTime: now - (3 - index) * 1000,
      cookieStoreId,
    });
    Assert.equal(error, undefined, `addUrl with ${cookieStoreId} should work`);
  }
  Assert.deepEqual(
    await fetchUserContextIds(),
    [0, 1, 0],
    "addUrl should store the userContextId of the cookieStoreId"
  );

  for (let [cookieStoreId, message] of [
    [
      "firefox-private",
      "Illegal to set private cookieStoreId in a non-private window",
    ],
    [
      "firefox-container-99",
      "No cookie store exists with ID firefox-container-99",
    ],
  ]) {
    let { error } = await callAPI(extension, "history.addUrl", {
      url: TEST_URL,
      cookieStoreId,
    });
    Assert.equal(error, message, `addUrl with ${cookieStoreId} should fail`);
  }

  Services.prefs.setCharPref(RESTRICTED_PREF, "[2]");
  let { error } = await callAPI(extension, "history.addUrl", {
    url: TEST_URL,
    cookieStoreId: "firefox-container-2",
  });
  Assert.equal(
    error,
    "Cannot access firefox-container-2",
    "addUrl should fail for a restricted container"
  );
  Services.prefs.clearUserPref(RESTRICTED_PREF);

  await extension.unload();

  extension = loadExtension(["history"]);
  await extension.startup();
  ({ error } = await callAPI(extension, "history.addUrl", {
    url: TEST_URL,
    cookieStoreId: "firefox-container-1",
  }));
  Assert.equal(
    error,
    "No permission for cookieStoreId: firefox-container-1",
    "addUrl with a cookieStoreId should require the cookies permission"
  );
  await extension.unload();
});

add_task(async function test_deleteUrl() {
  await PlacesUtils.history.clear();
  await insertVisits();

  let extension = loadExtension(["history", "cookies"]);
  await extension.startup();

  await callAPI(extension, "history.deleteUrl", {
    url: TEST_URL,
    cookieStoreId: "firefox-container-1",
  });
  Assert.deepEqual(
    await fetchUserContextIds(),
    [0, 2],
    "deleteUrl should only remove the visits of the container"
  );

  await callAPI(extension, "history.deleteUrl", {
    url: TEST_URL,
    cookieStoreId: "firefox-default",
  });
  Assert.deepEqual(
    await fetchUserContextIds(),
    [2],
    "deleteUrl should only remove the visits of the default container"
  );

  await extension.unload();
});

add_task(async function test_deleteRange() {
  await PlacesUtils.history.clear();
  await insertVisits();

  let extension = loadExtension(["history", "cookies"]);
  await extension.startup();

  await callAPI(extension, "history.deleteRange", {
    startTime: 0,
    endTime: Date.now(),
    cookieStoreId: "firefox-container-2",
  });
  Assert.deepEqual(
    await fetchUserContextIds(),
    [0, 1],
    "deleteRange should only remove the visits of the container"
  );

  await extension.unload();
});

add_task(async function test_browsingData_removeHistory() {
  await PlacesUtils.history.clear();
  await insertVisits();

  let extension = loadExtension(["browsingData"]);
  await extension.startup();

  let { error } = await callAPI(extension, "browsingData.removeHistory", {
    cookieStoreId: "firefox-private",
  });
  Assert.equal(error, undefined, "Removing private history should work");
  Assert.deepEqual(
    await fetchUserContextIds(),
    [0, 1, 2],
    "Removing private history should not remove any visit"
  );

  await callAPI(extension, "browsingData.removeHistory", {
    cookieStoreId: "firefox-container-1",
  });
  Assert.deepEqual(
    await fetchUserContextIds(),
    [0, 2],
    "removeHistory should only remove the visits of the container"
  );

  await callAPI(extension, "browsingData.removeHistory", {
    cookieStoreId: "firefox-default",
  });
  Assert.deepEqual(
    await fetchUserContextIds(),
    [2],
    "removeHistory should only remove the visits of the default container"
  );

  await extension.unload();
});
