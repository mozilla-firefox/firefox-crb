/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const userAgentID = "6a1c4f3e-9d2b-4e55-8c0a-3b7f1d2e9a41";
const channelID = "b3f1a7c2-5d84-4b0e-9a63-1e2c7d4f8a90";

const HANDSHAKE_COMPLETE_TOPIC = "push-service-handshake-complete";

function run_test() {
  do_get_profile();
  setPrefs({
    userAgentID,
    requestTimeout: 1000,
    retryBaseInterval: 150,
  });
  run_next_test();
}

add_task(async function test_handshake_complete_notification() {
  let db = PushServiceWebSocket.newPushDB();
  registerCleanupFunction(() => {
    return db.drop().then(_ => db.close());
  });

  let uaidAtNotification = null;
  let handshakeObserved = promiseObserverNotification(
    HANDSHAKE_COMPLETE_TOPIC,
    () => {
      uaidAtNotification = PushServiceWebSocket._UAID;
      return true;
    }
  );

  PushServiceWebSocket._generateID = () => channelID;
  PushService.init({
    serverURI: "wss://push.example.org/",
    db,
    makeWebSocket(uri) {
      return new MockWebSocket(uri, {
        onHello() {
          this.serverSendMsg(
            JSON.stringify({
              messageType: "hello",
              status: 200,
              uaid: userAgentID,
            })
          );
        },
        onRegister() {
          this.serverSendMsg(
            JSON.stringify({
              messageType: "register",
              status: 200,
              channelID,
              uaid: userAgentID,
              pushEndpoint: "https://example.com/update/1",
            })
          );
        },
      });
    },
  });

  await PushService.register({
    scope: "https://example.org/1",
    originAttributes: ChromeUtils.originAttributesToSuffix({
      inIsolatedMozBrowser: false,
    }),
  });

  await handshakeObserved;
  equal(
    uaidAtNotification,
    userAgentID,
    "The notification is sent once the hello reply has been processed"
  );
});
