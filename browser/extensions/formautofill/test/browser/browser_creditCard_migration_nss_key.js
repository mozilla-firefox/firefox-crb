/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

/**
 * The copy into Rust of Linux cards saved under the NSS key database's key,
 * which the OS key store no longer reads once it uses libsecret (bug 2094564).
 * The tests stub OSKeyStore.decrypt and OSKeyStore.decryptWithNSSKeyStore.
 */

const ENABLED_PREF = "extensions.formautofill.creditCards.storage.rust.enabled";
const ACTIVE_PREF = "extensions.formautofill.creditCards.storage.rust.active";

const rustActive = () => Services.prefs.getBoolPref(ACTIVE_PREF, false);

const TEST_FORM = `<form id="form">
  <input id="cc-name" autocomplete="cc-name">
  <input id="cc-number" autocomplete="cc-number">
  <input id="cc-exp-month" autocomplete="cc-exp-month">
  <input id="cc-exp-year" autocomplete="cc-exp-year">
  <input type="submit"/>
</form>`;

const CC_FORM_URL =
  "https://example.org/document-builder.sjs?html=" + TEST_FORM;

const TEST_CARD = {
  "cc-name": "John Doe",
  "cc-number": "4111111111111111",
  "cc-exp-month": 4,
  "cc-exp-year": 2030,
};

const TEST_CARD_AMEX = {
  "cc-name": "Jane Roe",
  "cc-number": "378282246310005",
  "cc-exp-month": 12,
  "cc-exp-year": 2031,
};

const EXPECTED_FILL = {
  "cc-name": TEST_CARD["cc-name"],
  "cc-number": TEST_CARD["cc-number"],
  "cc-exp-month": "04",
  "cc-exp-year": String(TEST_CARD["cc-exp-year"]),
};

/**
 * @param {boolean} rust Whether the Rust store should serve afterwards.
 */
async function switchTo(rust) {
  await formAutofillStorage.initialize();
  Services.prefs.setBoolPref(ENABLED_PREF, rust);
  await formAutofillStorage._creditCardSwitch;
  Assert.equal(
    Services.prefs.getBoolPref(ACTIVE_PREF, false),
    rust,
    `the profile is served by ${rust ? "Rust" : "JSON"}`
  );
}

/**
 * Fill the credit card form from the autocomplete popup.
 *
 * @returns {Promise<object>} The filled values, keyed by field id.
 */
async function fillFromStorage(expected = EXPECTED_FILL) {
  let filled;
  await BrowserTestUtils.withNewTab(CC_FORM_URL, async browser => {
    await openPopupOn(browser, "#cc-name");
    await BrowserTestUtils.synthesizeKey("VK_DOWN", {}, browser);
    await BrowserTestUtils.synthesizeKey("VK_RETURN", {}, browser);
    await waitForAutofill(browser, "#cc-name", expected["cc-name"]);

    filled = await SpecialPowers.spawn(browser, [], () =>
      Object.fromEntries(
        ["cc-name", "cc-number", "cc-exp-month", "cc-exp-year"].map(id => [
          id,
          content.document.getElementById(id).value,
        ])
      )
    );
  });
  return filled;
}

add_setup(async function () {
  // Filling would otherwise ask for OS re-authentication.
  const osAuthWas = FormAutofillUtils.getOSAuthEnabled();
  FormAutofillUtils.setOSAuthEnabled(false);

  const enabledWas = Services.prefs.getBoolPref(ENABLED_PREF, false);

  await SpecialPowers.pushPrefEnv({
    set: [["extensions.formautofill.creditCards.enabled", true]],
  });

  registerCleanupFunction(async () => {
    FormAutofillUtils.setOSAuthEnabled(osAuthWas);
    await removeAllRecords();
    Services.prefs.setBoolPref(ENABLED_PREF, enabledWas);
    await formAutofillStorage._creditCardSwitch;
  });
});

const servingNames = async () =>
  (await formAutofillStorage.creditCards.getAll()).map(c => c["cc-name"]);

const ATTEMPTS_PREF =
  "extensions.formautofill.creditCards.storage.rust.migrationAttempts";

/**
 * Make OSKeyStore.decrypt fail for every card, as under libsecret's new key.
 *
 * @param {Function} readNSSKey What OSKeyStore.decryptWithNSSKeyStore does.
 * @returns {Function} Undoes it.
 */
function switchOSKeyStoreBackend(readNSSKey) {
  const realDecrypt = OSKeyStore.decrypt;
  const realDecryptWithNSSKeyStore = OSKeyStore.decryptWithNSSKeyStore;
  OSKeyStore.decrypt = async () => {
    throw Components.Exception("Not this key", Cr.NS_ERROR_FAILURE);
  };
  OSKeyStore.decryptWithNSSKeyStore = readNSSKey;
  return () => {
    OSKeyStore.decrypt = realDecrypt;
    OSKeyStore.decryptWithNSSKeyStore = realDecryptWithNSSKeyStore;
  };
}

const migrationEvents = () =>
  (Glean.formautofillCreditcards.migrateToRust.testGetValue() ?? []).map(
    event => event.extra
  );

const nssKeyFallbackEvents = () =>
  (
    Glean.formautofillCreditcards.migrateNssKeyFallback.testGetValue() ?? []
  ).map(event => event.extra);

add_task(
  { skip_if: () => AppConstants.platform != "linux" },
  async function test_linux_migrates_a_card_under_the_nss_key() {
    await switchTo(false);
    await setStorage(TEST_CARD);
    Services.fog.testResetFOG();

    // The card's real key stands in for the NSS database's.
    const realDecrypt = OSKeyStore.decrypt.bind(OSKeyStore);
    let nssReads = 0;
    const restore = switchOSKeyStoreBackend(async cipherText => {
      nssReads++;
      return realDecrypt(cipherText, "testing");
    });
    try {
      await switchTo(true);
    } finally {
      restore();
    }

    Assert.ok(nssReads, "the number was read with the NSS key");
    const [event] = migrationEvents();
    Assert.equal(event?.result, "ok", "the copy completed");
    Assert.equal(event.failed, "0", "with no card refused");
    Assert.deepEqual(
      nssKeyFallbackEvents(),
      [{ recovered: "true" }],
      "reporting the card recovered"
    );
    Assert.equal(event.diverged, "0", "and nothing reported as diverged");
    Assert.deepEqual(
      await fillFromStorage(),
      EXPECTED_FILL,
      "and the card fills from Rust with the number it was saved with"
    );

    await removeAllRecords();
  }
);

add_task(
  { skip_if: () => AppConstants.platform != "linux" },
  async function test_linux_keeps_a_card_no_key_reads_on_json() {
    await switchTo(false);
    await setStorage(TEST_CARD);
    Services.fog.testResetFOG();

    const restore = switchOSKeyStoreBackend(async () => {
      throw Components.Exception("No such key", Cr.NS_ERROR_FAILURE);
    });
    try {
      Services.prefs.setBoolPref(ENABLED_PREF, true);
      await formAutofillStorage._creditCardSwitch;
    } finally {
      restore();
    }

    Assert.ok(!rustActive(), "the profile stays on JSON");
    const [event] = migrationEvents();
    Assert.equal(event?.result, "error", "the copy failed");
    Assert.equal(event.failed, "1", "on the card neither key reads");
    Assert.deepEqual(
      nssKeyFallbackEvents(),
      [{ recovered: "false" }],
      "reporting it as one the NSS key cannot read either"
    );
    Assert.equal((await getCreditCards()).length, 1, "which JSON still holds");

    Services.prefs.setBoolPref(ENABLED_PREF, false);
    await formAutofillStorage._creditCardSwitch;
    Services.prefs.clearUserPref(ATTEMPTS_PREF);
    await removeAllRecords();
  }
);

add_task(
  { skip_if: () => AppConstants.platform == "linux" },
  async function test_other_platforms_do_not_read_the_nss_key() {
    await switchTo(false);
    await setStorage(TEST_CARD);
    Services.fog.testResetFOG();

    let nssReads = 0;
    const restore = switchOSKeyStoreBackend(async () => {
      nssReads++;
      throw Components.Exception("Unexpected", Cr.NS_ERROR_FAILURE);
    });
    try {
      Services.prefs.setBoolPref(ENABLED_PREF, true);
      await formAutofillStorage._creditCardSwitch;
    } finally {
      restore();
    }

    Assert.equal(nssReads, 0, "the NSS key is never tried");
    Assert.ok(!rustActive(), "and the card that would not decrypt stays put");
    const [event] = migrationEvents();
    Assert.equal(event?.failed, "1", "the copy reports the card failed");
    Assert.deepEqual(nssKeyFallbackEvents(), [], "and nothing about NSS");

    Services.prefs.setBoolPref(ENABLED_PREF, false);
    await formAutofillStorage._creditCardSwitch;
    Services.prefs.clearUserPref(ATTEMPTS_PREF);
    await removeAllRecords();
  }
);

const DROP_UNDECRYPTABLE_PREF =
  "extensions.formautofill.creditCards.storage.rust.dropUndecryptable";

/**
 * Save TEST_CARD and TEST_CARD_AMEX, and make OSKeyStore.decrypt fail for
 * TEST_CARD only, as for a card saved before libsecret and one after.
 *
 * @param {Function} readNSSKey What OSKeyStore.decryptWithNSSKeyStore does.
 * @returns {Promise<Function>} Undoes it.
 */
async function saveACardBeforeAndAfterLibsecret(readNSSKey) {
  await switchTo(false);
  await setStorage(TEST_CARD, TEST_CARD_AMEX);
  const [{ "cc-number-encrypted": before }] = (
    await formAutofillStorage.creditCards.getAll()
  ).filter(card => card["cc-name"] == TEST_CARD["cc-name"]);
  Assert.ok(before, "the card saved before libsecret has a ciphertext");

  const realDecrypt = OSKeyStore.decrypt;
  const realDecryptWithNSSKeyStore = OSKeyStore.decryptWithNSSKeyStore;
  OSKeyStore.decrypt = async function (cipherText, ...rest) {
    if (cipherText == before) {
      throw Components.Exception("Not this key", Cr.NS_ERROR_FAILURE);
    }
    return realDecrypt.call(this, cipherText, ...rest);
  };
  OSKeyStore.decryptWithNSSKeyStore = cipherText =>
    readNSSKey(cipherText, realDecrypt.bind(OSKeyStore));
  return () => {
    OSKeyStore.decrypt = realDecrypt;
    OSKeyStore.decryptWithNSSKeyStore = realDecryptWithNSSKeyStore;
  };
}

add_task(
  { skip_if: () => AppConstants.platform != "linux" },
  async function test_linux_a_recovered_card_is_not_dropped() {
    await SpecialPowers.pushPrefEnv({ set: [[DROP_UNDECRYPTABLE_PREF, true]] });
    // Dropping needs another card that decrypts.
    const restore = await saveACardBeforeAndAfterLibsecret(
      (cipherText, realDecrypt) => realDecrypt(cipherText, "testing")
    );
    Services.fog.testResetFOG();
    try {
      await switchTo(true);
    } finally {
      restore();
    }

    const [event] = migrationEvents();
    Assert.equal(event?.result, "ok", "the copy completed");
    Assert.equal(event.migrated, "2", "with both cards");
    Assert.equal(event.drop_reason, undefined, "dropping none");
    Assert.deepEqual(
      nssKeyFallbackEvents(),
      [{ recovered: "true" }],
      "one of them read with NSS"
    );
    Assert.deepEqual(
      (await servingNames()).sort(),
      [TEST_CARD["cc-name"], TEST_CARD_AMEX["cc-name"]].sort(),
      "and Rust serves both"
    );

    await SpecialPowers.popPrefEnv();
    await removeAllRecords();
  }
);

add_task(
  { skip_if: () => AppConstants.platform != "linux" },
  async function test_linux_a_card_nss_was_not_asked_about_is_kept() {
    await SpecialPowers.pushPrefEnv({ set: [[DROP_UNDECRYPTABLE_PREF, true]] });
    // As the NSS read answers during shutdown.
    const restore = await saveACardBeforeAndAfterLibsecret(async () => {
      throw Components.Exception("", Cr.NS_ERROR_ILLEGAL_DURING_SHUTDOWN);
    });
    Services.fog.testResetFOG();
    try {
      Services.prefs.setBoolPref(ENABLED_PREF, true);
      await formAutofillStorage._creditCardSwitch;
    } finally {
      restore();
    }

    Assert.ok(!rustActive(), "the profile stays on JSON");
    const [event] = migrationEvents();
    Assert.equal(event?.result, "error", "the copy failed");
    Assert.equal(event.failed, "1", "on the card NSS was not asked about");
    Assert.equal(event.drop_reason, undefined, "rather than dropping it");
    Assert.deepEqual(
      nssKeyFallbackEvents(),
      [],
      "or counting it as one the NSS key cannot read"
    );
    Assert.equal((await getCreditCards()).length, 2, "JSON still holds both");

    Services.prefs.setBoolPref(ENABLED_PREF, false);
    await formAutofillStorage._creditCardSwitch;
    Services.prefs.clearUserPref(ATTEMPTS_PREF);
    await SpecialPowers.popPrefEnv();
    await removeAllRecords();
  }
);
