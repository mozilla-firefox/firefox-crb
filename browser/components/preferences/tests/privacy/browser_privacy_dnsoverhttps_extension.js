/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

/* global browser */

const { AddonTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/AddonTestUtils.sys.mjs"
);
AddonTestUtils.initMochitest(this);

const EXTENSION_ID = "doh-prefs@tests.mozilla.org";
const EXTENSION_NAME = "DoH Prefs Test";

add_setup(async function () {
  // Keep DoH connections to the default provider local.
  let dnsOverride = Cc["@mozilla.org/network/native-dns-override;1"].getService(
    Ci.nsINativeDNSResolverOverride
  );
  dnsOverride.addIPOverride("mozilla.cloudflare-dns.com", "127.0.0.1");
  registerCleanupFunction(() => dnsOverride.clearOverrides());
  await SpecialPowers.pushPrefEnv({
    set: [["network.trr.confirmationNS", "skip"]],
  });
});

function loadDoHExtension() {
  return ExtensionTestUtils.loadExtension({
    manifest: {
      name: EXTENSION_NAME,
      permissions: ["dns", "proxy"],
      browser_specific_settings: { gecko: { id: EXTENSION_ID } },
    },
    incognitoOverride: "spanning",
    useAddonManager: "permanent",
    background() {
      browser.dns.dohSettings
        .set({ value: { mode: "doh-only" } })
        .then(() => browser.test.sendMessage("set"));
    },
  });
}

function getMessageBar(control) {
  return control.querySelector(".extension-controlled-message-bar");
}

add_task(async function testExtensionControlledDoH() {
  await openPreferencesViaOpenPreferencesAPI("dnsOverHttps", {
    leaveOpen: true,
  });
  let win = gBrowser.selectedBrowser.contentWindow;
  let radioControl = await settingControlRenders("dohRadioGroup", win);
  let exceptionsControl = await settingControlRenders(
    "dohExceptionsButton",
    win
  );
  ok(!getMessageBar(radioControl), "No extension message bar initially");
  ok(!radioControl.disabled, "The radio group is enabled initially");
  ok(!exceptionsControl.disabled, "The exceptions button is enabled initially");

  let extension = loadDoHExtension();
  await extension.startup();
  await extension.awaitMessage("set");

  await BrowserTestUtils.waitForMutationCondition(
    radioControl,
    { childList: true, subtree: true },
    () => !!getMessageBar(radioControl)
  );
  let messageBar = getMessageBar(radioControl);
  is(
    messageBar.messageL10nId,
    "extension-controlling-doh",
    "The message bar uses the DoH string"
  );
  Assert.deepEqual(
    messageBar.messageL10nArgs,
    { name: EXTENSION_NAME },
    "The message bar names the extension"
  );
  ok(
    messageBar.querySelector("moz-button[data-l10n-id='disable-extension']"),
    "The message bar offers to disable the extension"
  );
  ok(radioControl.disabled, "The radio group is disabled");
  await TestUtils.waitForCondition(
    () => exceptionsControl.disabled,
    "The exceptions button is disabled"
  );
  is(
    radioControl.controlEl.value,
    "custom",
    "The extension's mode selects the custom radio"
  );
  for (let id of ["dohFallbackIfCustom", "dohProviderSelect"]) {
    let nested = await settingControlRenders(id, win);
    await TestUtils.waitForCondition(
      () => nested.controlEl.isDisabled,
      `${id} is disabled`
    );
  }
  is(
    win.document.querySelectorAll(".extension-controlled-message-bar").length,
    1,
    "Only one extension message bar is shown"
  );

  await extension.unload();
  await BrowserTestUtils.waitForMutationCondition(
    radioControl,
    { childList: true, subtree: true },
    () => !getMessageBar(radioControl)
  );
  ok(!radioControl.disabled, "The radio group is enabled after unload");
  await TestUtils.waitForCondition(
    () => !exceptionsControl.disabled,
    "The exceptions button is enabled after unload"
  );

  gBrowser.removeCurrentTab();
});

// Opening the privacy pane and searching initialize every pane, none of which
// should adjust the prefs that the extension controls.
add_task(async function testPanesLeaveExtensionPrefsAlone() {
  let extension = loadDoHExtension();
  await extension.startup();
  await extension.awaitMessage("set");

  await openPreferencesViaOpenPreferencesAPI("panePrivacy", {
    leaveOpen: true,
  });
  await runSearchInput("DNS");
  ok(
    !Services.prefs.getStringPref("network.trr.uri"),
    "The preferences page does not set a provider"
  );
  is(
    Services.prefs.getIntPref("network.trr.mode"),
    Ci.nsIDNSService.MODE_TRRONLY,
    "The extension's mode is untouched"
  );

  await extension.unload();
  gBrowser.removeCurrentTab();
});
