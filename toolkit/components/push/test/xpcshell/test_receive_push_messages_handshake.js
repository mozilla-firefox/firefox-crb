/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const { CommandLineHandler } = ChromeUtils.importESModule(
  "moz-src:///toolkit/components/push/PushCommandLineHandler.sys.mjs"
);
const { setTimeout } = ChromeUtils.importESModule(
  "resource://gre/modules/Timer.sys.mjs"
);

const HANDSHAKE_COMPLETE_TOPIC = "push-service-handshake-complete";
const PER_MESSAGE_TIMEOUT_MS = 100;
const TOTAL_TIMEOUT_MS = 500;
const TOLERANCE_MS = 100;

function run_test() {
  do_get_profile();
  Services.fog.initializeFOG();
  run_next_test();
}

function isFuzzy(actual, expected, epsilon, message) {
  Assert.lessOrEqual(
    Math.abs(actual - expected),
    epsilon,
    `${message} - got ${actual}, expected ${expected} +/- ${epsilon}`
  );
}

function completeHandshake() {
  Services.obs.notifyObservers(null, HANDSHAKE_COMPLETE_TOPIC);
}

async function withPushReady(ready, fn) {
  const original = CommandLineHandler.prototype.ensurePushServiceReady;
  // Touching the component's service would start the real Push Service
  const pushComponent = Cc["@mozilla.org/push/Service;1"].getService(
    Ci.nsIPushService
  ).wrappedJSObject;
  const originalIgnoreNewMessages = pushComponent.ignoreNewMessages;
  pushComponent.ignoreNewMessages = () => {};
  CommandLineHandler.prototype.ensurePushServiceReady = async () => {
    if (typeof ready == "function") {
      await ready();
    }
    return !!ready;
  };
  Services.prefs.setBoolPref("dom.push.connection.enabled", true);
  Services.prefs.setIntPref(
    "app.backgroundNotifications.receivePushMessages.perMessageTimeoutMs",
    PER_MESSAGE_TIMEOUT_MS
  );
  Services.prefs.setIntPref(
    "app.backgroundNotifications.receivePushMessages.totalTimeoutMs",
    TOTAL_TIMEOUT_MS
  );
  try {
    return await fn();
  } finally {
    CommandLineHandler.prototype.ensurePushServiceReady = original;
    pushComponent.ignoreNewMessages = originalIgnoreNewMessages;
    Services.prefs.clearUserPref("dom.push.connection.enabled");
    Services.prefs.clearUserPref(
      "app.backgroundNotifications.receivePushMessages.perMessageTimeoutMs"
    );
    Services.prefs.clearUserPref(
      "app.backgroundNotifications.receivePushMessages.totalTimeoutMs"
    );
  }
}

function waitMs(ms) {
  // eslint-disable-next-line mozilla/no-arbitrary-setTimeout
  return new Promise(resolve => setTimeout(resolve, ms));
}

add_task(async function test_per_message_timer_waits_for_the_handshake() {
  await withPushReady(true, async () => {
    let stopped = false;
    let receiving = CommandLineHandler.prototype
      .receivePushMessages()
      .then(() => (stopped = true));

    await waitMs(PER_MESSAGE_TIMEOUT_MS * 2);
    ok(!stopped, "Receiving doesn't stop before the handshake completes");

    let handshakeAt = ChromeUtils.now();
    completeHandshake();
    await receiving;

    isFuzzy(
      ChromeUtils.now() - handshakeAt,
      PER_MESSAGE_TIMEOUT_MS,
      TOLERANCE_MS,
      "The per message timeout starts when the handshake completes"
    );
  });
});

add_task(
  async function test_receive_push_messages_if_handshake_never_completes() {
    await withPushReady(true, async () => {
      let startedAt = ChromeUtils.now();
      await CommandLineHandler.prototype.receivePushMessages();

      isFuzzy(
        ChromeUtils.now() - startedAt,
        TOTAL_TIMEOUT_MS,
        TOLERANCE_MS,
        "Receiving stops at the total timeout if the handshake never completes"
      );
    });
  }
);

add_task(
  async function test_per_message_timer_starts_if_handshake_completed_early() {
    await withPushReady(
      () => completeHandshake(),
      async () => {
        let startedAt = ChromeUtils.now();
        await CommandLineHandler.prototype.receivePushMessages();

        isFuzzy(
          ChromeUtils.now() - startedAt,
          PER_MESSAGE_TIMEOUT_MS,
          TOLERANCE_MS,
          "The per message timeout starts if the handshake completed earlier"
        );
      }
    );
  }
);
