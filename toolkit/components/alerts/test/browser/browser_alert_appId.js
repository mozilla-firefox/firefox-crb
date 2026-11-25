/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { MockRegistrar } = ChromeUtils.importESModule(
  "resource://testing-common/MockRegistrar.sys.mjs"
);

const AlertNotification = Components.Constructor(
  "@mozilla.org/alert-notification;1",
  "nsIAlertNotification",
  "init"
);
const CopiedAlertNotification = Components.Constructor(
  "@mozilla.org/alert-notification;1",
  "nsIAlertNotification",
  "initWithObject"
);

const PAGE_URL = "https://example.com/page.html";

let gProviderCalls = [];
// Replaces the result of the mock provider when set.
let gAppIdOverride = null;

const mockAppIdProvider = {
  getAppId(uri, userContextId) {
    gProviderCalls.push({ spec: uri.spec, userContextId });
    if (gAppIdOverride) {
      return gAppIdOverride();
    }
    return `test.webapp-${userContextId}`;
  },
  QueryInterface: ChromeUtils.generateQI(["nsIAlertAppIdProvider"]),
};

add_setup(async () => {
  const cid = MockRegistrar.register(
    "@mozilla.org/alert-app-id-provider;1",
    mockAppIdProvider
  );
  registerCleanupFunction(() => MockRegistrar.unregister(cid));
});

let gAlertCount = 0;

// Creates an alert, recording the provider calls made while initializing it.
function createAlert({
  userContextId = 0,
  privateBrowsing = false,
  principal = Services.scriptSecurityManager.createContentPrincipal(
    Services.io.newURI(PAGE_URL),
    { userContextId, privateBrowsingId: privateBrowsing ? 1 : 0 }
  ),
} = {}) {
  gProviderCalls = [];
  gAlertCount++;
  return new AlertNotification(
    `test-alert-${gAlertCount}`,
    "",
    "title",
    "text",
    false,
    "",
    "auto",
    "",
    "",
    principal,
    privateBrowsing
  );
}

add_task(async function test_appIdFromPrincipal() {
  gAppIdOverride = null;
  const alert = createAlert();

  Assert.deepEqual(
    gProviderCalls,
    [{ spec: PAGE_URL, userContextId: 0 }],
    "The provider is queried with the principal URL and container"
  );
  Assert.equal(alert.appId, "test.webapp-0", "The alert has the app ID");
});

add_task(async function test_appIdInContainer() {
  gAppIdOverride = null;
  const alert = createAlert({ userContextId: 2 });

  Assert.equal(gProviderCalls[0].userContextId, 2, "The container is passed");
  Assert.equal(alert.appId, "test.webapp-2", "The alert has the app ID");
});

add_task(async function test_appIdIsComputedOnce() {
  gAppIdOverride = null;
  const alert = createAlert();
  gAppIdOverride = () => "test.changed";

  Assert.equal(alert.appId, "test.webapp-0", "The app ID is kept");
  Assert.equal(gProviderCalls.length, 1, "The provider is queried once");
});

add_task(async function test_appIdIsRecomputedForCopies() {
  gAppIdOverride = null;
  const alert = createAlert();

  gAppIdOverride = () => "test.copy";
  const copy = new CopiedAlertNotification(alert);

  Assert.equal(copy.appId, "test.copy", "The copy computes its own app ID");
  Assert.deepEqual(
    gProviderCalls[1],
    { spec: PAGE_URL, userContextId: 0 },
    "The copy is looked up with the same principal"
  );
});

add_task(async function test_noAppIdInPrivateBrowsing() {
  gAppIdOverride = null;
  const alert = createAlert({ privateBrowsing: true });

  Assert.deepEqual(gProviderCalls, [], "The provider is not queried");
  Assert.equal(alert.appId, "", "The alert belongs to Firefox");
});

add_task(async function test_noAppIdForChromeAlerts() {
  gAppIdOverride = null;
  const alert = createAlert({
    principal: Services.scriptSecurityManager.getSystemPrincipal(),
  });

  Assert.deepEqual(gProviderCalls, [], "The provider is not queried");
  Assert.equal(alert.appId, "", "The alert belongs to Firefox");
});

add_task(async function test_providerThrows() {
  // XPConnect reports exceptions thrown by JS components.
  expectUncaughtException();
  gAppIdOverride = () => {
    throw Components.Exception("", Cr.NS_ERROR_FAILURE);
  };
  const alert = createAlert();

  Assert.equal(gProviderCalls.length, 1, "The provider was queried");
  Assert.equal(alert.appId, "", "The alert belongs to Firefox");
});
