// Any copyright is dedicated to the Public Domain.
// http://creativecommons.org/publicdomain/zero/1.0/
"use strict";

// Tests that disabling the per-user-context "disable all security checks"
// override stops sessions established while it was on from being resumed.

do_get_profile();

const HOST = "expired.example.com";
const ORIGIN_ATTRIBUTES = { userContextId: 5 };

const certOverrideService = Cc[
  "@mozilla.org/security/certoverride;1"
].getService(Ci.nsICertOverrideService);

function setOverride(aEnabled) {
  certOverrideService.setDisableAllSecurityChecksAndLetAttackersInterceptMyDataForUserContext(
    ORIGIN_ATTRIBUTES.userContextId,
    aEnabled
  );
}

function connect(aExpectedResult, aResumed) {
  return asyncConnectTo(
    HOST,
    aExpectedResult,
    aResumed === undefined
      ? null
      : securityInfo => equal(securityInfo.resumed, aResumed),
    null,
    ORIGIN_ATTRIBUTES
  );
}

add_setup(async function () {
  await asyncStartTLSTestServer("BadCertAndPinningServer", "bad_certs");
  registerCleanupFunction(() => {
    certOverrideService.resetDisableAllSecurityChecksAndLetAttackersInterceptMyDataForUserContext(
      ORIGIN_ATTRIBUTES.userContextId
    );
  });
});

add_task(async function test_reset_clears_resumable_sessions() {
  await connect(SEC_ERROR_EXPIRED_CERTIFICATE);
  setOverride(true);
  await connect(PRErrorCodeSuccess, false);
  await connect(PRErrorCodeSuccess, true);
  certOverrideService.resetDisableAllSecurityChecksAndLetAttackersInterceptMyDataForUserContext(
    ORIGIN_ATTRIBUTES.userContextId
  );
  await connect(SEC_ERROR_EXPIRED_CERTIFICATE);
});

add_task(async function test_disabling_clears_resumable_sessions() {
  setOverride(true);
  await connect(PRErrorCodeSuccess, false);
  await connect(PRErrorCodeSuccess, true);
  setOverride(false);
  await connect(SEC_ERROR_EXPIRED_CERTIFICATE);
});
