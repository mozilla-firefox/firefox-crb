"use strict";

/* import-globals-from ../../../../../netwerk/test/unit/head_trr.js */

ChromeUtils.defineESModuleGetters(this, {
  AddonManager: "resource://gre/modules/AddonManager.sys.mjs",
});

AddonTestUtils.init(this);
AddonTestUtils.overrideCertDB();

AddonTestUtils.createAppInfo(
  "xpcshell@tests.mozilla.org",
  "XPCShell",
  "1",
  "42"
);

const TRR_PREFS = [
  "network.trr.mode",
  "network.trr.uri",
  "network.trr.bootstrapAddr",
  "network.trr.excluded-domains",
];

const DISABLE_HEURISTICS_PREF = "doh-rollout.disable-heuristics";

const DEFAULT_VALUE = {
  mode: "default",
  url: "",
  bootstrapAddress: "",
  excludedDomains: [],
};

function clearTRRPrefs() {
  for (let pref of [...TRR_PREFS, DISABLE_HEURISTICS_PREF]) {
    Services.prefs.clearUserPref(pref);
  }
}

function checkPrefsUnset(msg) {
  for (let pref of TRR_PREFS) {
    ok(!Services.prefs.prefHasUserValue(pref), `${pref} is not set ${msg}`);
  }
}

function checkPrefs(expected) {
  for (let [pref, value] of Object.entries(expected)) {
    if (value === undefined) {
      ok(!Services.prefs.prefHasUserValue(pref), `${pref} is not set`);
    } else {
      let actual =
        typeof value == "number"
          ? Services.prefs.getIntPref(pref)
          : Services.prefs.getStringPref(pref);
      equal(actual, value, `${pref} has the expected value`);
    }
  }
}

function dohSettingsBackground() {
  browser.test.onMessage.addListener(async (msg, arg) => {
    let api = browser.dns?.dohSettings;
    try {
      let result;
      switch (msg) {
        case "set":
          result = await api.set({ value: arg });
          break;
        case "get":
          result = await api.get({});
          break;
        case "clear":
          result = await api.clear({});
          break;
        case "listen":
          api.onChange.addListener(details => {
            browser.test.sendMessage("onChange", details);
          });
          result = true;
          break;
        case "hasAPI":
          result = !!browser.dns?.dohSettings;
          break;
        case "requestProxy":
          result = await browser.permissions.request({
            permissions: ["proxy"],
          });
          break;
        case "removeProxy":
          result = await browser.permissions.remove({
            permissions: ["proxy"],
          });
          break;
        case "resolve":
          result = await browser.dns.resolve(arg);
          break;
      }
      browser.test.sendMessage(`${msg}:done`, { result });
    } catch (e) {
      browser.test.sendMessage(`${msg}:done`, { error: e.message });
    }
  });
  browser.test.sendMessage("ready");
}

function loadDoHExtension({
  permissions = ["dns", "proxy"],
  optional_permissions,
  incognitoOverride = "spanning",
  useAddonManager = "temporary",
  id,
} = {}) {
  let manifest = { permissions };
  if (optional_permissions) {
    manifest.optional_permissions = optional_permissions;
  }
  if (id) {
    manifest.browser_specific_settings = { gecko: { id } };
  }
  return ExtensionTestUtils.loadExtension({
    background: dohSettingsBackground,
    manifest,
    incognitoOverride,
    useAddonManager,
  });
}

async function startExtension(options) {
  let extension = loadDoHExtension(options);
  await extension.startup();
  await extension.awaitMessage("ready");
  return extension;
}

async function call(extension, msg, arg) {
  extension.sendMessage(msg, arg);
  return extension.awaitMessage(`${msg}:done`);
}

async function setAndCheck(extension, value, expectedPrefs, expectedValue) {
  let { result, error } = await call(extension, "set", value);
  equal(error, undefined, `set(${JSON.stringify(value)}) does not throw`);
  equal(result, true, "set returns true");
  checkPrefs(expectedPrefs);

  ({ result } = await call(extension, "get"));
  equal(
    result.levelOfControl,
    "controlled_by_this_extension",
    "The setting is controlled by this extension"
  );
  deepEqual(
    result.value,
    { ...DEFAULT_VALUE, ...expectedValue },
    "get returns the expected value"
  );
}

const isAndroid = AppConstants.platform == "android";

add_setup(async function () {
  // Make sure an accidental connection to the configured DoH server, or to
  // a bootstrap address, never leaves the machine.
  Services.prefs.setBoolPref("network.dns.native-is-localhost", true);
  Services.prefs.setBoolPref(
    "extensions.webextOptionalPermissionPrompts",
    false
  );
  registerCleanupFunction(() => {
    Services.prefs.clearUserPref("network.dns.native-is-localhost");
    Services.prefs.clearUserPref("extensions.webextOptionalPermissionPrompts");
    clearTRRPrefs();
  });

  await AddonTestUtils.promiseStartupManager();
});

add_task({ skip_if: () => !isAndroid }, async function test_android() {
  let extension = await startExtension();
  for (let method of ["get", "set", "clear"]) {
    let { error } = await call(extension, method, { mode: "off" });
    equal(
      error,
      "dns.dohSettings is not supported on android.",
      `${method} rejects on Android`
    );
  }
  checkPrefsUnset("on Android");
  await extension.unload();
});

add_task({ skip_if: () => isAndroid }, async function test_get_defaults() {
  let extension = await startExtension();
  let { result } = await call(extension, "get");
  deepEqual(
    result,
    { levelOfControl: "controllable_by_this_extension", value: DEFAULT_VALUE },
    "get reports the default configuration"
  );

  for (let [prefValue, mode] of [
    [0, "default"],
    [1, "off"],
    [2, "doh-first"],
    [3, "doh-only"],
    [4, "off"],
    [5, "off"],
  ]) {
    Services.prefs.setIntPref("network.trr.mode", prefValue);
    ({ result } = await call(extension, "get"));
    equal(result.value.mode, mode, `network.trr.mode=${prefValue} is ${mode}`);
  }

  Services.prefs.setStringPref(
    "network.trr.excluded-domains",
    " a.com, ,b.com"
  );
  ({ result } = await call(extension, "get"));
  deepEqual(
    result.value.excludedDomains,
    ["a.com", "b.com"],
    "excludedDomains is parsed from the pref"
  );

  clearTRRPrefs();
  await extension.unload();
});

add_task({ skip_if: () => isAndroid }, async function test_set() {
  let extension = await startExtension();

  await setAndCheck(
    extension,
    {
      mode: "doh-only",
      url: "https://doh.example.com/dns-query",
      bootstrapAddress: "127.0.0.1",
      excludedDomains: ["a.example", "B.Example"],
    },
    {
      "network.trr.mode": 3,
      "network.trr.uri": "https://doh.example.com/dns-query",
      "network.trr.bootstrapAddr": "127.0.0.1",
      "network.trr.excluded-domains": "a.example,b.example",
    },
    {
      mode: "doh-only",
      url: "https://doh.example.com/dns-query",
      bootstrapAddress: "127.0.0.1",
      excludedDomains: ["a.example", "b.example"],
    }
  );

  // Properties that are not passed revert to their default value.
  await setAndCheck(
    extension,
    { mode: "doh-first", url: "https://doh.example.com:8443/q" },
    {
      "network.trr.mode": 2,
      "network.trr.uri": "https://doh.example.com:8443/q",
      "network.trr.bootstrapAddr": undefined,
      "network.trr.excluded-domains": undefined,
    },
    { mode: "doh-first", url: "https://doh.example.com:8443/q" }
  );

  // "off" disables DoH explicitly, so that it isn't enabled by the rollout.
  await setAndCheck(
    extension,
    { mode: "off" },
    { "network.trr.mode": 5, "network.trr.uri": undefined },
    { mode: "off" }
  );

  await setAndCheck(
    extension,
    { mode: "doh-first", bootstrapAddress: "::1" },
    { "network.trr.mode": 2, "network.trr.bootstrapAddr": "::1" },
    { mode: "doh-first", bootstrapAddress: "::1" }
  );

  await setAndCheck(
    extension,
    { mode: "default", excludedDomains: ["a.example"] },
    {
      "network.trr.mode": undefined,
      "network.trr.uri": undefined,
      "network.trr.excluded-domains": "a.example",
    },
    { excludedDomains: ["a.example"] }
  );

  let { result } = await call(extension, "set", {
    mode: "default",
    excludedDomains: ["a.example"],
  });
  equal(result, true, "Setting the same value again succeeds");

  ({ result } = await call(extension, "clear"));
  equal(result, true, "clear returns true");
  checkPrefsUnset("after clear");

  ({ result } = await call(extension, "get"));
  equal(
    result.levelOfControl,
    "controllable_by_this_extension",
    "The setting is no longer controlled after clear"
  );

  await call(extension, "set", { mode: "doh-only" });
  await extension.unload();
  checkPrefsUnset("after unload");
});

add_task({ skip_if: () => isAndroid }, async function test_invalid_values() {
  let extension = await startExtension();

  const INVALID = [
    [{ mode: "trr" }, /Invalid enumeration value "trr"/],
    [{ mode: 2 }, /Expected string instead of 2/],
    [{ requestTimeout: 1000 }, /Unexpected property "requestTimeout"/],
    [{ url: "http://doh.example.com/" }, /url must use https/],
    [{ url: "doh.example.com/dns-query" }, /is not a valid url/],
    [{ url: "https://" }, /is not a valid url/],
    [{ bootstrapAddress: "doh.example.com" }, /is not a valid IP address/],
    [{ bootstrapAddress: "256.1.1.1" }, /is not a valid IP address/],
    [{ bootstrapAddress: "127.0.0.1:53" }, /is not a valid IP address/],
    [{ bootstrapAddress: "127.0.0.1." }, /is not a valid IP address/],
    [{ bootstrapAddress: "[::1]" }, /is not a valid IP address/],
    [{ excludedDomains: "a.example" }, /Expected array instead of/],
    [{ excludedDomains: ["a.example,b.example"] }, /is not a valid domain/],
    [{ excludedDomains: ["a example"] }, /is not a valid domain/],
    [{ excludedDomains: [""] }, /is not a valid domain/],
    [{ confirmationNS: "skip" }, /Unexpected property "confirmationNS"/],
    [{ url: "https://doh.example.com/" }, /url requires the doh-first/],
    [
      { mode: "default", url: "https://doh.example.com/" },
      /url requires the doh-first/,
    ],
    [
      { mode: "off", url: "https://doh.example.com/" },
      /url requires the doh-first/,
    ],
    [
      { mode: "default", bootstrapAddress: "127.0.0.1" },
      /bootstrapAddress requires the doh-first/,
    ],
    [
      { mode: "off", bootstrapAddress: "127.0.0.1" },
      /bootstrapAddress requires the doh-first/,
    ],
  ];

  for (let [value, expected] of INVALID) {
    let { error } = await call(extension, "set", value);
    Assert.stringMatches(
      error,
      expected,
      `set(${JSON.stringify(value)}) rejects`
    );
  }

  let { error } = await call(extension, "set", "doh-only");
  Assert.stringMatches(error, /Expected object/, "Non-object value rejects");

  checkPrefsUnset("after invalid values");

  let { result } = await call(extension, "get");
  equal(
    result.levelOfControl,
    "controllable_by_this_extension",
    "Invalid values do not take control of the setting"
  );

  await extension.unload();
});

add_task(
  { skip_if: () => isAndroid },
  async function test_requires_private_browsing() {
    let extension = await startExtension({ incognitoOverride: "not_allowed" });

    let { error } = await call(extension, "set", { mode: "doh-first" });
    equal(
      error,
      "dns.dohSettings requires private browsing permission.",
      "set rejects without private browsing access"
    );
    checkPrefsUnset("without private browsing access");

    let { result } = await call(extension, "get");
    deepEqual(result.value, DEFAULT_VALUE, "get works without private access");

    await extension.unload();
  }
);

add_task({ skip_if: () => isAndroid }, async function test_locked_prefs() {
  let extension = await startExtension();

  Services.prefs.lockPref("network.trr.mode");
  try {
    let { result } = await call(extension, "get");
    equal(
      result.levelOfControl,
      "not_controllable",
      "The setting is not controllable when a pref is locked"
    );

    let { error } = await call(extension, "set", { mode: "doh-only" });
    equal(
      error,
      "DNS over HTTPS settings are being managed by the Policies manager.",
      "set rejects when a pref is locked"
    );
  } finally {
    Services.prefs.unlockPref("network.trr.mode");
  }
  checkPrefsUnset("after locked set");

  await extension.unload();
});

add_task({ skip_if: () => isAndroid }, async function test_requires_proxy() {
  let extension = await startExtension({ permissions: ["dns"] });
  let { result } = await call(extension, "hasAPI");
  equal(result, false, "dns.dohSettings requires the proxy permission");
  await extension.unload();

  extension = await startExtension({ permissions: ["proxy"] });
  ({ result } = await call(extension, "hasAPI"));
  equal(result, false, "dns.dohSettings requires the dns permission");
  await extension.unload();
});

add_task(
  { skip_if: () => isAndroid },
  async function test_optional_proxy_permission() {
    let extension = await startExtension({
      permissions: ["dns"],
      optional_permissions: ["proxy"],
      useAddonManager: "permanent",
    });

    let { result } = await call(extension, "hasAPI");
    equal(result, false, "The API is not available before the request");

    await withHandlingUserInput(extension, async () => {
      ({ result } = await call(extension, "requestProxy"));
      equal(result, true, "proxy permission granted");
    });

    ({ result } = await call(extension, "hasAPI"));
    equal(result, true, "The API is available after the request");

    await setAndCheck(
      extension,
      { mode: "doh-only", url: "https://doh.example.com/dns-query" },
      {
        "network.trr.mode": 3,
        "network.trr.uri": "https://doh.example.com/dns-query",
      },
      { mode: "doh-only", url: "https://doh.example.com/dns-query" }
    );

    ({ result } = await call(extension, "removeProxy"));
    equal(result, true, "proxy permission removed");
    // Removal of the setting is not awaited by permissions.remove.
    await TestUtils.waitForCondition(
      () => !Services.prefs.prefHasUserValue("network.trr.mode"),
      "Wait for the setting to be removed"
    );
    checkPrefsUnset("after removing the proxy permission");

    ({ result } = await call(extension, "hasAPI"));
    equal(result, false, "The API is gone after removing the permission");

    await extension.unload();
  }
);

add_task({ skip_if: () => isAndroid }, async function test_restore_prefs() {
  Services.prefs.setIntPref("network.trr.mode", 2);
  Services.prefs.setStringPref("network.trr.uri", "https://user.example/dns");
  Services.prefs.setStringPref("network.trr.excluded-domains", "user.example");

  let extension = await startExtension();
  await setAndCheck(
    extension,
    { mode: "doh-only", url: "https://doh.example.com/dns-query" },
    {
      "network.trr.mode": 3,
      "network.trr.uri": "https://doh.example.com/dns-query",
      "network.trr.excluded-domains": undefined,
    },
    { mode: "doh-only", url: "https://doh.example.com/dns-query" }
  );
  await extension.unload();

  checkPrefs({
    "network.trr.mode": 2,
    "network.trr.uri": "https://user.example/dns",
    "network.trr.excluded-domains": "user.example",
    "network.trr.bootstrapAddr": undefined,
  });
  clearTRRPrefs();
});

add_task(
  { skip_if: () => isAndroid },
  async function test_rollout_heuristics_pref() {
    let extension = await startExtension();

    await call(extension, "set", { excludedDomains: ["a.example"] });
    ok(
      !Services.prefs.prefHasUserValue(DISABLE_HEURISTICS_PREF),
      "The default mode does not disable the rollout heuristics"
    );

    for (let mode of ["off", "doh-first", "doh-only"]) {
      await call(extension, "set", { mode });
      equal(
        Services.prefs.getBoolPref(DISABLE_HEURISTICS_PREF, false),
        true,
        `The ${mode} mode disables the rollout heuristics`
      );
    }

    // Mimic DoHController, which disables heuristics when the TRR mode changes.
    let observer = () =>
      Services.prefs.setBoolPref(DISABLE_HEURISTICS_PREF, true);
    Services.prefs.addObserver("network.trr.mode", observer);
    try {
      await extension.unload();
    } finally {
      Services.prefs.removeObserver("network.trr.mode", observer);
    }
    ok(
      !Services.prefs.prefHasUserValue(DISABLE_HEURISTICS_PREF),
      "The rollout heuristics are re-enabled after unload"
    );

    Services.prefs.setBoolPref(DISABLE_HEURISTICS_PREF, true);
    extension = await startExtension();
    await call(extension, "set", { mode: "doh-only" });
    await extension.unload();
    equal(
      Services.prefs.getBoolPref(DISABLE_HEURISTICS_PREF, false),
      true,
      "A prior opt-out of the rollout heuristics is preserved"
    );
    Services.prefs.clearUserPref(DISABLE_HEURISTICS_PREF);
  }
);

add_task(
  { skip_if: () => isAndroid },
  async function test_user_change_is_preserved() {
    let extension = await startExtension();
    await call(extension, "set", {
      mode: "doh-only",
      url: "https://doh.example.com/dns-query",
    });

    // The user picks a different provider, e.g. from about:preferences.
    Services.prefs.setStringPref("network.trr.uri", "https://user.example/");

    let addon = await AddonManager.getAddonByID(extension.id);
    await addon.disable();
    checkPrefs({
      "network.trr.mode": 3,
      "network.trr.uri": "https://user.example/",
    });

    await addon.uninstall();
    clearTRRPrefs();
  }
);

add_task({ skip_if: () => isAndroid }, async function test_precedence() {
  let extension1 = await startExtension({ id: "doh1@tests.mozilla.org" });
  let extension2 = await startExtension({ id: "doh2@tests.mozilla.org" });

  await call(extension1, "set", {
    mode: "doh-first",
    url: "https://doh1.example/",
  });
  checkPrefs({
    "network.trr.mode": 2,
    "network.trr.uri": "https://doh1.example/",
  });

  await call(extension2, "listen");
  await call(extension2, "set", {
    mode: "doh-only",
    url: "https://doh2.example/",
  });
  let changed = await extension2.awaitMessage("onChange");
  equal(changed.value.url, "https://doh2.example/", "onChange fired");
  checkPrefs({
    "network.trr.mode": 3,
    "network.trr.uri": "https://doh2.example/",
  });

  let { result } = await call(extension1, "get");
  equal(
    result.levelOfControl,
    "controlled_by_other_extensions",
    "The first extension lost control"
  );

  ({ result } = await call(extension1, "set", { mode: "off" }));
  equal(result, false, "set returns false if another extension is in control");
  checkPrefs({ "network.trr.mode": 3 });

  await extension2.unload();
  checkPrefs({ "network.trr.mode": 5, "network.trr.uri": undefined });

  await extension1.unload();
  checkPrefsUnset("after unloading all extensions");
});

add_task({ skip_if: () => isAndroid }, async function test_restart() {
  let extension = await startExtension({
    id: "doh-restart@tests.mozilla.org",
    useAddonManager: "permanent",
  });
  await call(extension, "set", {
    mode: "doh-only",
    url: "https://doh.example.com/dns-query",
  });

  await AddonTestUtils.promiseRestartManager();
  await extension.awaitStartup();
  await extension.awaitMessage("ready");

  checkPrefs({
    "network.trr.mode": 3,
    "network.trr.uri": "https://doh.example.com/dns-query",
  });
  let { result } = await call(extension, "get");
  equal(
    result.levelOfControl,
    "controlled_by_this_extension",
    "The extension is still in control after a restart"
  );

  await extension.unload();
  checkPrefsUnset("after uninstall");
});

add_task({ skip_if: () => isAndroid }, async function test_doh_lookup() {
  trr_test_setup();
  // This is configured through the extension below.
  Services.prefs.clearUserPref("network.trr.bootstrapAddr");

  let certdb = Cc["@mozilla.org/security/x509certdb;1"].getService(
    Ci.nsIX509CertDB
  );
  addCertFromFile(certdb, "http2-ca.pem", "CTu,u,u");

  let trrServer = new TRRServer();
  await trrServer.start();
  registerCleanupFunction(async () => {
    await trrServer.stop();
    trr_clear_prefs();
  });
  await trrServer.registerDoHAnswers("doh-ext.example.com", "A", {
    answers: [
      {
        name: "doh-ext.example.com",
        ttl: 55,
        type: "A",
        flush: false,
        data: "3.3.3.3",
      },
    ],
  });

  let extension = await startExtension();
  let { result, error } = await call(extension, "set", {
    mode: "doh-only",
    url: `https://foo.example.com:${trrServer.port()}/dns-query`,
    bootstrapAddress: "127.0.0.1",
    excludedDomains: ["native.example.com"],
  });
  equal(error, undefined, "set does not throw");
  equal(result, true, "set returns true");
  equal(
    Services.dns.currentTrrMode,
    Ci.nsIDNSService.MODE_TRRONLY,
    "The DNS service uses the TRR only mode"
  );

  ({ result } = await call(extension, "resolve", "doh-ext.example.com"));
  deepEqual(
    result,
    { addresses: ["3.3.3.3"], isTRR: true },
    "The name is resolved through the configured DoH server"
  );
  equal(
    await trrServer.requestCount("doh-ext.example.com", "A"),
    1,
    "The DoH server received the query"
  );

  ({ result } = await call(extension, "resolve", "sub.native.example.com"));
  equal(result.isTRR, false, "Excluded domains use the native resolver");
  equal(
    await trrServer.requestCount("sub.native.example.com", "A"),
    0,
    "The DoH server did not receive the query for the excluded domain"
  );

  await extension.unload();
  checkPrefsUnset("after unloading");
  equal(
    Services.dns.currentTrrMode,
    Ci.nsIDNSService.MODE_NATIVEONLY,
    "DoH is no longer used after the extension is unloaded"
  );
});

function addCertFromFile(certdb, filename, trustString) {
  let certFile = do_get_file(filename, false);
  let fstream = Cc["@mozilla.org/network/file-input-stream;1"].createInstance(
    Ci.nsIFileInputStream
  );
  fstream.init(certFile, -1, 0, 0);
  let pem = NetUtil.readInputStreamToString(fstream, fstream.available())
    .replace(/-----BEGIN CERTIFICATE-----/, "")
    .replace(/-----END CERTIFICATE-----/, "")
    .replace(/[\r\n]/g, "");
  fstream.close();
  certdb.addCertFromBase64(pem, trustString);
}
