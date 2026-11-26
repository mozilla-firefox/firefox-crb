# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

"""Condprofile scenario that populates origins for storage initialization tests.

Creates N origins (each with its own synthetic hostname) and writes data
via localStorage, IndexedDB, or Cache API through mitmproxy-served pages.
Optionally kills the browser process for dirty-shutdown testing.
"""

import asyncio
import base64
import hashlib
import os
import re

DEFAULT_CUSTOMIZATION = "qm_init"
PROXY_MODE = "intercept"
PLAYBACK_VERSION = "8.1.1"

LS_BODY = b"""
<!doctype html>
<head>
<meta charset="utf-8">
<title>LocalStorage Variant</title>
<script>
function trySetItem() {
    try {
        localStorage.setItem("wait", "0");
        localStorage.setItem("now", String(Date.now()));
    } catch (e) { console.warn(e); }
}
</script>
</head>
<body onload="trySetItem()">
</body>
"""

IDB_BODY = b"""
<!doctype html>
<head>
<meta charset="utf-8">
<title>IndexedDB Variant</title>
<script>
async function trySetItem() {
    await new Promise((resolve, reject) => {
        const request = indexedDB.open('now', 1);
        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            const objectStore = db.createObjectStore('now', { keyPath: 'id' });
            objectStore.put({ id: 'now', value: String(Date.now()) });
        };
        request.onsuccess = () => {
            resolve();
        };
        request.onerror = () => {
            reject(request.error);
        };
    }).catch((e) => { console.warn(e); });
}
</script>
</head>
<body onload="trySetItem()">
</body>
"""

CACHE_BODY = b"""
<!doctype html>
<head>
<meta charset="utf-8">
<title>Cache API Variant</title>
<script>
async function trySetItem() {
  try {
    const cache = await caches.open('now');
    await cache.put('/now', new Response(String(Date.now())));
  } catch (e) { console.warn(e); }
}
</script>
</head>
<body onload="trySetItem()">
</body>
"""

BODY_MAP = {
    "ls": LS_BODY,
    "idb": IDB_BODY,
    "cache": CACHE_BODY,
}

DEFAULT_HEADERS = {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "public, max-age=31536000, immutable",
}


class TestHTMLProvider:
    def __init__(self):
        self.urls = re.compile(r"^test-.*\.org$")
        self.http = None

    def load(self, loader):
        from mitmproxy import http

        self.http = http

    def request(self, flow) -> None:
        host = flow.request.pretty_host
        match = self.urls.match(host)
        if not match:
            return

        if flow.request.method != "GET":
            return

        if (
            not flow.request.path_components
            or flow.request.path_components[0] not in BODY_MAP
        ):
            flow.response = self.http.Response.make(
                404,
                b"Please specify ls, idb or cache resource in the URL path.",
                DEFAULT_HEADERS,
            )
            return

        first = flow.request.path_components[0]
        body = BODY_MAP.get(first)

        flow.response = self.http.Response.make(200, body, DEFAULT_HEADERS)


addons = [TestHTMLProvider()]


def get_reproducible_string16(nonce: bytes, counter: int) -> str:
    """Derive the Nth synthetic hostname from a nonce.

    Origins are generated rather than recorded, so the set is stable across
    runs for a given nonce. Changing the nonce changes every hostname, which
    also invalidates the `test_url` hardcoded in the raptor manifests.
    """
    data = nonce + str(counter).encode("utf-8")
    hash_digest = hashlib.sha256(data).digest()
    hash_b32 = base64.b32encode(hash_digest).decode("ascii").lower()
    return hash_b32[:16]


def _do_dirty_shutdown_desktop(session, logger, profile_dir):
    import psutil

    from condprof.helpers import detach_session

    processes = _firefox_processes(profile_dir)
    if not processes:
        raise Exception(
            "Dirty shutdown requested but no Firefox process using the profile "
            f"{profile_dir} was found; the profile would only reflect a clean "
            "shutdown"
        )
    detach_session(session)
    for process in processes:
        logger.info(f"Killing Firefox process {process.pid}")
        try:
            process.kill()
            process.wait(timeout=10)
        except psutil.NoSuchProcess:
            continue
        except psutil.TimeoutExpired:
            if process.status() == psutil.STATUS_ZOMBIE:
                logger.info("Firefox is zombie (reaped by geckodriver), proceeding")
            else:
                logger.warning("Firefox did not die within 10s after SIGKILL")
                raise


def _firefox_processes(profile_dir):
    """Firefox processes started with profile_dir on their command line,
    parents before their children.

    Walking down from geckodriver does not work everywhere: on Windows the
    launcher process exits once the browser runs, so the browser is no
    longer a child of geckodriver.
    """
    import psutil

    wanted = os.path.normcase(os.path.normpath(profile_dir))
    found = []
    for process in psutil.process_iter(["pid", "ppid", "name", "cmdline"]):
        info = process.info
        if "firefox" not in (info["name"] or "").lower():
            continue
        args = info["cmdline"] or []
        if any(wanted in os.path.normcase(os.path.normpath(arg)) for arg in args):
            found.append(process)
    pids = {process.pid for process in found}
    found.sort(key=lambda process: process.info["ppid"] in pids)
    return found


def _do_dirty_shutdown_android(session, logger, app_name):
    from mozdevice import ADBDeviceFactory

    from condprof.helpers import detach_session

    logger.info(f"Force-stopping Android app: {app_name}")
    detach_session(session)
    # ADBDeviceFactory hands back the device AndroidEnv already created.
    ADBDeviceFactory(logger_name="adb").stop_application(app_name)


def do_dirty_shutdown(session, logger, options):
    from condprof.helpers import is_mobile

    if is_mobile(options.get("platform", "")):
        app_name = options.get("app_name")
        _do_dirty_shutdown_android(session, logger, app_name)
    else:
        _do_dirty_shutdown_desktop(session, logger, options["profile_dir"])


async def storage_initialization(session, options):
    from condprof.helpers import TabSwitcher
    from condprof.util import logger

    max_urls = options.get("max_urls", 1000)
    nonce = options.get("nonce", "abcd1234efgh5678").encode("utf-8")
    storage_api = options.get("storage_api", "ls")
    idle_time_ms = options.get("idle_time_ms", 1000)
    dirty_shutdown = options.get("dirty_shutdown", False)

    tabs = TabSwitcher(session, options)
    await tabs.create_windows()

    for i in range(max_urls):
        if i > 0:
            await asyncio.wait_for(tabs.switch(), 5)

        host = get_reproducible_string16(nonce, i)
        url = f"https://test-{host}.org/{storage_api}/"
        logger.info(f"{i + 1}/{max_urls} {url}")
        await asyncio.wait_for(session.get(url), 30)

    if idle_time_ms is not None:
        logger.info(f"Idling for {idle_time_ms} ms")
        await asyncio.sleep(idle_time_ms * 0.001)

    if dirty_shutdown:
        do_dirty_shutdown(session, logger, options)

    return {}
