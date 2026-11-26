/**
 * Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/
 */

import { setTimeout, clearTimeout } from "resource://gre/modules/Timer.sys.mjs";

let pollingDeadline;

// All waits in a test share a one-minute budget. Callers need a harness timeout
// greater than that budget, including time for setup and cleanup.
export async function waitForCondition(condition, message) {
  pollingDeadline ??= ChromeUtils.now() + 60000;
  let stopped = false;
  let timer;
  const remaining = pollingDeadline - ChromeUtils.now();
  if (remaining <= 0) {
    throw new Error(`Timed out waiting for: ${message}`);
  }
  try {
    await Promise.race([
      (async () => {
        while (!stopped) {
          await new Promise(resolve => setTimeout(resolve, 50));
          if (!stopped && (await condition())) {
            return;
          }
        }
      })(),
      new Promise((resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out waiting for: ${message}`)),
          remaining
        );
      }),
    ]);
  } finally {
    stopped = true;
    clearTimeout(timer);
  }
}

// Flush repeatedly until no lease or recent write keeps the origin dirty.
export async function waitForOriginToSettle(
  principal,
  persistenceType = "default"
) {
  await waitForCondition(async () => {
    await flushDirtyOriginInfos();
    return !(await isOriginDirty(principal, persistenceType));
  }, "origin to settle");
}

class RequestError extends Error {
  constructor(resultCode, resultName) {
    super(`Request failed (code: ${resultCode}, name: ${resultName})`);
    this.name = "RequestError";
    this.resultCode = resultCode;
    this.resultName = resultName;
  }
}

export function setStoragePrefs(optionalPrefsToSet) {
  const prefsToSet = [["dom.quotaManager.testing", true]];

  if (Services.appinfo.OS === "WINNT") {
    prefsToSet.push(["dom.quotaManager.useDOSDevicePathSyntax", true]);
  }

  if (optionalPrefsToSet) {
    prefsToSet.push(...optionalPrefsToSet);
  }

  for (const pref of prefsToSet) {
    Services.prefs.setBoolPref(pref[0], pref[1]);
  }
}

export function clearStoragePrefs(optionalPrefsToClear) {
  const prefsToClear = ["dom.quotaManager.testing", "dom.simpleDB.enabled"];

  if (Services.appinfo.OS === "WINNT") {
    prefsToClear.push("dom.quotaManager.useDOSDevicePathSyntax");
  }

  if (optionalPrefsToClear) {
    prefsToClear.push(...optionalPrefsToClear);
  }

  for (const pref of prefsToClear) {
    Services.prefs.clearUserPref(pref);
  }
}

export async function getCachedUsageForOrigin(principal) {
  const request = Services.qms.getCachedUsageForPrincipal(
    principal,
    function () {}
  );

  await new Promise(function (resolve) {
    request.callback = function () {
      resolve();
    };
  });

  if (request.resultCode != Cr.NS_OK) {
    throw new RequestError(request.resultCode, request.resultName);
  }

  return request.result;
}

export async function clearStoragesForOrigin(principal) {
  const request = Services.qms.clearStoragesForPrincipal(principal);

  await new Promise(function (resolve) {
    request.callback = function () {
      resolve();
    };
  });

  if (request.resultCode != Cr.NS_OK) {
    throw new RequestError(request.resultCode, request.resultName);
  }

  return request.result;
}

export async function flushDirtyOriginInfos() {
  const request = Services.qms.flushDirtyOriginInfos();

  await new Promise(function (resolve) {
    request.callback = function () {
      resolve();
    };
  });

  if (request.resultCode != Cr.NS_OK) {
    throw new RequestError(request.resultCode, request.resultName);
  }

  return request.result;
}

export async function isOriginDirty(principal, persistenceType = "default") {
  const request = Services.qms.getFullOriginMetadata(
    persistenceType,
    principal
  );

  await new Promise(function (resolve) {
    request.callback = function () {
      resolve();
    };
  });

  if (request.resultCode != Cr.NS_OK) {
    throw new RequestError(request.resultCode, request.resultName);
  }

  return request.result.dirty;
}

export async function resetStorage() {
  const request = Services.qms.reset();

  await new Promise(function (resolve) {
    request.callback = function () {
      resolve();
    };
  });

  if (request.resultCode != Cr.NS_OK) {
    throw new RequestError(request.resultCode, request.resultName);
  }

  return request.result;
}
