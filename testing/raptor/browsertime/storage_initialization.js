/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Reads loadQuotaDurationMs from nsIQuotaManagerServiceInternal and reports
// it via custom_data. Runs against a conditioned profile built by the
// storage_initialization scenario.

/* global require, module */

const { logTest } = require("./utils/profiling");

function verifyStorageScript(storageApi) {
  if (storageApi === "idb") {
    return `
      const notifyDone = arguments[arguments.length - 1];
      const request = indexedDB.open('now', 1);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction('now', 'readonly');
        const store = tx.objectStore('now');
        const get = store.get('now');
        get.onsuccess = () => {
          notifyDone(Number(get.result?.value));
        };
        get.onerror = () => notifyDone(0);
      };
      request.onerror = () => notifyDone(0);
    `;
  }
  if (storageApi === "cache") {
    return `
      const notifyDone = arguments[arguments.length - 1];
      caches.open('now').then(cache =>
        cache.match('/now').then(resp =>
          resp ? resp.text().then(t => notifyDone(Number(t))) : notifyDone(0)
        )
      ).catch(() => notifyDone(0));
    `;
  }
  return `
    const notifyDone = arguments[arguments.length - 1];
    const radix = 10;
    const value = parseInt(localStorage.getItem('now'), radix);
    notifyDone(value);
  `;
}

module.exports = logTest(
  "Storage initialization test",
  async function (context, commands) {
    const url = context.options.browsertime.url;
    const storageApi = context.options.browsertime.storageApi || "ls";

    context.log.info("Starting a storage initialization test");
    context.log.info("URL: " + url + ", storageApi: " + storageApi);

    await commands.measure.start();
    await commands.navigate(url);
    await commands.measure.stop();

    const storageUsableAt = await context.selenium.driver.executeAsyncScript(
      verifyStorageScript(storageApi)
    );

    context.log.info(
      "Storage verification: " + (storageUsableAt ? "OK" : "FAILED")
    );

    const loadQuotaMs = await commands.js.runPrivileged(`
      const qms = Cc["@mozilla.org/dom/quota-manager-service;1"]
        .getService(Ci.nsIQuotaManagerServiceInternal);
      return qms.loadQuotaDurationMs;
    `);

    context.log.info("LoadQuota: " + loadQuotaMs + " ms");

    await commands.measure.addObject({
      custom_data: { loadQuotaMs },
    });

    context.log.info("Storage initialization test ended");

    return true;
  }
);
