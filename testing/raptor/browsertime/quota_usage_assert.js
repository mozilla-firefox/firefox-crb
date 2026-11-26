/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Reads navigator.storage.estimate() and reports usage_bytes via custom_data.
// Runs against a conditioned profile pre-populated by the quota_usage scenario.

/* global require, module */

const { logTest } = require("./utils/profiling");

module.exports = logTest(
  "Quota usage assertion test",
  async function (context, commands) {
    context.log.info("Starting quota usage assertion test");

    await commands.measure.start();
    await commands.navigate("https://test-quota-usage.org/check");
    await commands.measure.stop();

    const result = await context.selenium.driver.executeAsyncScript(`
        const notifyDone = arguments[arguments.length - 1];
        navigator.storage.estimate().then(estimate => {
            notifyDone({
                usage: estimate.usage,
                quota: estimate.quota,
            });
        }).catch(e => {
            notifyDone({ error: e.toString() });
        });
    `);

    if (result.error) {
      context.log.error("Failed to get storage estimate: " + result.error);
      return false;
    }

    context.log.info("Storage usage: " + result.usage + " bytes");
    context.log.info("Storage quota: " + result.quota + " bytes");

    await commands.measure.addObject({
      custom_data: {
        usage_bytes: result.usage,
      },
    });

    context.log.info("Quota usage assertion test ended");
    return true;
  }
);
