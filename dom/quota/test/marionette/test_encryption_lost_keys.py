# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

import os
import sys
from pathlib import Path

sys.path.append(os.fspath(Path(__file__).parents[0]))
from quota_test_case import QuotaTestCase

QM_ENCRYPTION_PREF = "dom.quotaManager.encryption.enabled"
UNLOCK_PREF = "security.lockstore.unlock.enabled"

# Keep in step with security/lockstore/ProfileKek.h.
PW_KEK = "lockstore::kek::password:profile"
LOCAL_KEK = "lockstore::kek::local:profile"

PASSWORD = "password"
NEW_PASSWORD = "new password"

IDB_OPEN = """
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("LostKeysDB", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("store");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
"""

IDB_WRITE = (
    IDB_OPEN
    + """
    await new Promise((resolve, reject) => {
      const transaction = db.transaction("store", "readwrite");
      transaction.objectStore("store").put(arguments[0], "key");
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
    db.close();
"""
)

IDB_READ = (
    IDB_OPEN
    + """
    const value = await new Promise((resolve, reject) => {
      const request = db.transaction("store").objectStore("store").get("key");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return value;
"""
)

LS_WRITE = """
    localStorage.setItem("key", arguments[0]);
    // The write is sent to the parent when the task that made it ends.
    await new Promise(resolve => setTimeout(resolve));
"""

LS_READ = """
    return localStorage.getItem("key");
"""

CACHE_WRITE = """
    const cache = await caches.open("LostKeysCache");
    await cache.put(
      new Request("https://example.com/lost-keys"),
      new Response(arguments[0])
    );
"""

CACHE_READ = """
    const cache = await caches.open("LostKeysCache");
    const response = await cache.match("https://example.com/lost-keys");
    return response && (await response.text());
"""


class EncryptionPrimaryPassword(QuotaTestCase):
    """
    The keys of encrypted origins are wrapped by the profile KEK, which follows
    the primary password: a password KEK while there is one, a local KEK
    otherwise. The storage clients share the code that picks the KEK, so
    IndexedDB stands in for all of them, except where a client has its own way
    of failing without a key or of cleaning up after itself.
    """

    def setUp(self):
        super().setUp()

        self.url = self.marionette.absolute_url("empty.html")

        # QuotaManager reads encryption.enabled once at startup, so write it to
        # the profile and restart before touching storage.
        self.restartWithCleanStorage({QM_ENCRYPTION_PREF: True, UNLOCK_PREF: True})

        # Keys outlive the storage they belong to, and one left by an earlier
        # test would be picked up instead of a new one being created.
        self.runInChrome(
            """
            for (const name of await originDeks()) {
              await lockstore.deleteDek(name);
            }
            return true;
            """
        )

        self.marionette.navigate(self.url)

    def tearDown(self):
        # First, so the cleanup below also runs after a test that left Firefox
        # crashed or without a session.
        self.restartWithCleanStorage({QM_ENCRYPTION_PREF: False, UNLOCK_PREF: False})

        # A password KEK left behind makes a later startup with the link
        # enabled prompt for its password. Not through ProfileKekPassword: a
        # test it failed must still clean up for the ones after it.
        self.runInChrome(
            """
            if (await lockstore.kekExists(args[0])) {
              for (const name of await lockstore.listDeks()) {
                if ((await lockstore.listKeks(name)).includes(args[0])) {
                  await lockstore.deleteDek(name);
                }
              }
              await lockstore.deleteKek(args[0]);
            }
            return true;
            """,
            PW_KEK,
        )

        super().tearDown()

    def test_keys_use_local_kek_without_password(self):
        self.runInContent(IDB_WRITE, "before")

        self.assertEqual(self.originKeks(), [LOCAL_KEK])

    def test_new_keys_use_password_kek(self):
        self.runProfileKekPassword("update", "", PASSWORD)

        self.runInContent(IDB_WRITE, "before")

        self.assertEqual(self.originKeks(), [PW_KEK])

    def test_setting_password_protects_indexedDB(self):
        self.checkSettingPassword(IDB_WRITE, IDB_READ)

    def test_setting_password_protects_localStorage(self):
        self.checkSettingPassword(LS_WRITE, LS_READ)

    def test_setting_password_protects_cache(self):
        self.checkSettingPassword(CACHE_WRITE, CACHE_READ)

    def checkSettingPassword(self, write, read):
        self.runInContent(write, "before")

        self.runProfileKekPassword("update", "", PASSWORD)
        self.assertEqual(self.originKeks(), [PW_KEK])

        # With the link disabled, nothing unlocks the password KEK at startup.
        self.restart({UNLOCK_PREF: False})
        self.assertTrue(
            str(self.runInContent(read)).startswith("error: "),
            "Data was readable while the password KEK was locked",
        )

        self.unlockPasswordKek(PASSWORD)
        self.assertEqual(
            self.runInContent(read),
            "before",
            "Data was not readable after the password KEK was unlocked",
        )

    def test_changing_password_keeps_data(self):
        self.runInContent(IDB_WRITE, "before")
        self.runProfileKekPassword("update", "", PASSWORD)

        self.runProfileKekPassword("update", PASSWORD, NEW_PASSWORD)
        self.assertEqual(self.originKeks(), [PW_KEK])

        self.restart({UNLOCK_PREF: False})
        self.unlockPasswordKek(NEW_PASSWORD)
        self.assertEqual(self.runInContent(IDB_READ), "before")

    def test_removing_password_keeps_data(self):
        self.runInContent(IDB_WRITE, "before")
        self.runProfileKekPassword("update", "", PASSWORD)

        self.runProfileKekPassword("update", PASSWORD, "")
        self.assertEqual(self.originKeks(), [LOCAL_KEK])

        self.restart()
        self.assertEqual(self.runInContent(IDB_READ), "before")

    def test_reset_while_unlocked_keeps_data(self):
        self.runInContent(IDB_WRITE, "before")
        self.runProfileKekPassword("update", "", PASSWORD)

        self.runProfileKekPassword("discard")
        self.assertEqual(self.originKeks(), [LOCAL_KEK])

        self.restart()
        self.assertEqual(self.runInContent(IDB_READ), "before")

    def test_reset_while_locked_clears_indexedDB(self):
        self.checkResetWhileLocked(IDB_WRITE, IDB_READ)

    def test_reset_while_locked_clears_localStorage(self):
        self.checkResetWhileLocked(LS_WRITE, LS_READ)

    def test_reset_while_locked_clears_cache(self):
        self.checkResetWhileLocked(CACHE_WRITE, CACHE_READ)

    def checkResetWhileLocked(self, write, read):
        """
        A reset with the password KEK locked deletes the origin's keys, since
        nothing can unwrap them again. The data they protected has to go with
        them, or the storage client it belongs to fails instead of starting
        over.
        """
        self.runInContent(write, "before")

        self.restart()
        self.assertEqual(
            self.runInContent(read),
            "before",
            "Encrypted data did not survive a restart with its keys in place",
        )

        self.runProfileKekPassword("update", "", PASSWORD)

        # With the link disabled, nothing unlocks the password KEK at startup.
        self.restart({UNLOCK_PREF: False})

        self.runProfileKekPassword("discard")

        self.assertIsNone(
            self.runInContent(read),
            "Data encrypted with a discarded key was not dropped",
        )
        self.runInContent(write, "after")

        self.restart()
        self.assertEqual(
            self.runInContent(read),
            "after",
            "Data written after the keys were discarded did not survive a restart",
        )

    def unlockPasswordKek(self, password):
        self.runInChrome(
            """
            await lockstore.unlockKek(args[0], args[1], Number.MAX_SAFE_INTEGER);
            return true;
            """,
            PW_KEK,
            password,
        )

    def restart(self, prefs=None):
        if prefs:
            self.marionette.instance.profile.set_preferences(prefs)

        self.marionette.restart(in_app=True)
        self.marionette.navigate(self.url)

    def runInContent(self, body, *args):
        """
        Run the body of an async function in the page. Returns what it returns,
        or a string starting with "error: " if it throws.
        """
        return self.marionette.execute_async_script(
            """
            const resolve = arguments[arguments.length - 1];
            (async () => {
            """
            + body
            + """
            })().then(
              value => resolve(value === undefined ? null : value),
              e => resolve("error: " + e)
            );
            """,
            script_args=args,
        )

    def runInChrome(self, body, *args):
        """
        Run the body of an async function in the parent process, with the
        lockstore, the arguments as `args` and `originDeks()`, which resolves
        to the names of the keys of the test page's origin.
        """
        origin = self.marionette.absolute_url("")[:-1]

        with self.marionette.using_context(self.marionette.CONTEXT_CHROME):
            return self.executeAsyncScript(
                """
                const [origin, ...args] = Array.prototype.slice.call(
                  arguments, 0, -1
                );

                const lockstore = Cc[
                  "@mozilla.org/security/lockstore;1"
                ].getService(Ci.nsILockstore);

                async function originDeks() {
                  return (await lockstore.listDeks()).filter(
                    name => name.startsWith("dom-quota:") && name.includes(origin)
                  );
                }

                async function main() {
                """
                + body
                + """
                }
                """,
                script_args=(origin, *args),
            )

    def runProfileKekPassword(self, method, *args):
        return self.runInChrome(
            """
            const { ProfileKekPassword } = ChromeUtils.importESModule(
              "resource://gre/modules/ProfileKekPassword.sys.mjs"
            );
            await ProfileKekPassword[args[0]](...args.slice(1));

            return true;
            """,
            method,
            *args,
        )

    def originKeks(self):
        """
        The KEKs that wrap the keys of the test page's origin.
        """
        return self.runInChrome(
            """
            const keks = new Set();
            for (const name of await originDeks()) {
              for (const kek of await lockstore.listKeks(name)) {
                keks.add(kek);
              }
            }

            return [...keks].sort();
            """
        )
