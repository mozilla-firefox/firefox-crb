/**
 * Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/
 */

const { FileUtils } = ChromeUtils.importESModule(
  "resource://testing-common/dom/quota/test/modules/FileUtils.sys.mjs"
);
const { PrincipalUtils } = ChromeUtils.importESModule(
  "resource://testing-common/dom/quota/test/modules/PrincipalUtils.sys.mjs"
);
const { QuotaUtils } = ChromeUtils.importESModule(
  "resource://testing-common/dom/quota/test/modules/QuotaUtils.sys.mjs"
);

/**
 * The .metadata-v2 file is not a usage cache. It is written when an origin
 * directory is created and when the persisted flag changes, and it exists so
 * an origin can still be identified after the storage database is lost.
 *
 * This test verifies that contract. It removes the storage database to force
 * recovery from the restoration files alone, then checks that the origin, its
 * suffix and its persisted flag all survive. Usage is deliberately not
 * compared: it is recomputed by scanning the origin directory, not restored
 * from the file.
 *
 * A second origin with origin attributes is covered so the suffix is checked
 * against a non-empty value rather than only the empty default.
 */
async function testRestorationFileValidity() {
  const plainPrincipal = PrincipalUtils.createPrincipal("http://example42.com");
  const suffixedPrincipal = getPrincipal("https://example43.com", {
    userContextId: 1,
  });

  async function getMetadata(principal) {
    const request = Services.qms.getFullOriginMetadata("default", principal);
    return QuotaUtils.requestFinished(request);
  }

  info("Clearing storage");

  {
    const request = Services.qms.clear();
    await QuotaUtils.requestFinished(request);
  }

  info("Installing package");

  // The profile contains a single origin directory in the default repository
  // populated with basic data for all quota clients. See
  // make_restorationFileValidity.js for how it was produced.
  installPackage("restorationFileValidity_profile");

  info("Initializing storage");

  {
    const request = Services.qms.init();
    await QuotaUtils.requestFinished(request);
  }

  info("Initializing temporary storage");

  {
    const request = Services.qms.initTemporaryStorage();
    await QuotaUtils.requestFinished(request);
  }

  info("Creating an origin with a non-empty suffix");

  {
    const request = Services.qms.initializeTemporaryOrigin(
      "default",
      suffixedPrincipal,
      /* aCreateIfNonExistent */ true
    );
    await QuotaUtils.requestFinished(request);
  }

  info("Getting full origin metadata");

  const plainBefore = await getMetadata(plainPrincipal);
  const suffixedBefore = await getMetadata(suffixedPrincipal);

  Assert.notEqual(suffixedBefore.suffix, "", "The suffix is not empty");

  info("Shutting down storage");

  {
    const request = Services.qms.reset();
    await QuotaUtils.requestFinished(request);
  }

  info("Removing the storage database to force recovery from disk");

  FileUtils.getFile("storage.sqlite").remove(false);

  info("Initializing storage");

  {
    const request = Services.qms.init();
    await QuotaUtils.requestFinished(request);
  }

  info("Initializing temporary storage");

  {
    const request = Services.qms.initTemporaryStorage();
    await QuotaUtils.requestFinished(request);
  }

  info("Verifying full origin metadata was recovered");

  const plainAfter = await getMetadata(plainPrincipal);
  const suffixedAfter = await getMetadata(suffixedPrincipal);

  for (const [before, after, description] of [
    [plainBefore, plainAfter, "without a suffix"],
    [suffixedBefore, suffixedAfter, "with a suffix"],
  ]) {
    Assert.equal(
      before.origin,
      after.origin,
      `Origin is the same for the origin ${description}`
    );
    Assert.equal(
      before.suffix,
      after.suffix,
      `Suffix is the same for the origin ${description}`
    );
    Assert.equal(
      before.persisted,
      after.persisted,
      `Persisted flag is the same for the origin ${description}`
    );
  }
}

/* exported testSteps */
async function testSteps() {
  add_task(
    {
      pref_set: [["dom.quotaManager.loadQuotaFromCache", false]],
    },
    testRestorationFileValidity
  );
}
