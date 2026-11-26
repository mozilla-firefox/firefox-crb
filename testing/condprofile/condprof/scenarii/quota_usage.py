# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

"""Condprofile scenario that populates storage for quota usage testing.

Navigates to a synthetic URL served by mitmproxy, creates data of a
configurable size in the requested storage types, then idles to let
QuotaManager flush metadata.
"""

import asyncio
import re

DEFAULT_CUSTOMIZATION = "qm_use"
PROXY_MODE = "intercept"
PLAYBACK_VERSION = "8.1.1"

CREATE_BODY = b"""
<!doctype html>
<html>
<head><meta charset="utf-8"><title>Quota Usage - Create</title></head>
<body>
<script>
async function createStorageData(types, size) {
    const data = 'x'.repeat(size);
    const errors = [];

    if (types.includes('ls')) {
        try {
            localStorage.setItem('k', data);
        } catch (e) { errors.push('localStorage: ' + e); }
    }

    if (types.includes('idb-v')) {
        await new Promise((resolve, reject) => {
            const req = indexedDB.open('quota_test_v', 1);
            req.onupgradeneeded = e => {
                const db = e.target.result;
                const store = db.createObjectStore('data', { keyPath: 'id' });
                store.put({ id: 'k', value: data });
            };
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
        }).catch(e => errors.push('IndexedDB value: ' + e));
    }

    if (types.includes('idb-eb')) {
        await new Promise((resolve, reject) => {
            const req = indexedDB.open('quota_test_eb', 1);
            req.onupgradeneeded = e => {
                const db = e.target.result;
                const store = db.createObjectStore('data', { keyPath: 'id' });
                store.put({ id: 'k', value: new Blob([data]) });
            };
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
        }).catch(e => errors.push('IndexedDB blob: ' + e));
    }

    if (types.includes('cache')) {
        try {
            const cache = await caches.open('quota_test');
            await cache.put('/k', new Response(data));
        } catch (e) { errors.push('Cache API: ' + e); }
    }

    if (types.includes('fs')) {
        try {
            const root = await navigator.storage.getDirectory();
            const fh = await root.getFileHandle('k', { create: true });
            const writable = await fh.createWritable();
            await writable.write(data);
            await writable.close();
        } catch (e) { errors.push('OPFS: ' + e); }
    }

    document.title = errors.length ? 'FAILED: ' + errors.join('; ') : 'DONE';
}

const params = new URLSearchParams(location.search);
const types = (params.get('types') || 'ls,idb-v,idb-eb,cache,fs').split(',');
const size = parseInt(params.get('size') || '1', 10);
createStorageData(types, size);
</script>
</body>
</html>
"""

CHECK_BODY = b"""
<!doctype html>
<html>
<head><meta charset="utf-8"><title>Quota Usage - Check</title></head>
<body>
<script>
document.title = 'READY';
</script>
</body>
</html>
"""

DEFAULT_HEADERS = {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
}


class QuotaTestHTMLProvider:
    def __init__(self):
        self.pattern = re.compile(r"^test-quota-usage\.org$")
        self.http = None

    def load(self, loader):
        from mitmproxy import http

        self.http = http

    def request(self, flow) -> None:
        host = flow.request.pretty_host
        if not self.pattern.match(host):
            return

        if flow.request.method != "GET":
            return

        path = flow.request.path
        if path.startswith("/create"):
            body = CREATE_BODY
        else:
            body = CHECK_BODY

        flow.response = self.http.Response.make(200, body, DEFAULT_HEADERS)


addons = [QuotaTestHTMLProvider()]


async def quota_usage(session, options):
    from condprof.util import logger

    storage_types = options.get(
        "storage_types", ["ls", "idb-v", "idb-eb", "cache", "fs"]
    )
    idle_time_ms = options.get("idle_time_ms", 2000)
    data_size_bytes = options.get("data_size_bytes", 1)

    types_param = ",".join(storage_types)
    url = f"https://test-quota-usage.org/create?types={types_param}&size={data_size_bytes}"
    logger.info(f"Navigating to {url}")
    await asyncio.wait_for(session.get(url), 30)

    for _ in range(60):
        title = await session.execute_script("return document.title;")
        if title == "DONE":
            break
        if title.startswith("FAILED"):
            raise Exception(f"Storage data creation failed: {title}")
        await asyncio.sleep(0.5)
    else:
        raise Exception("Storage data creation did not complete within 30s")

    logger.info(f"Data creation complete, idling for {idle_time_ms} ms")
    await asyncio.sleep(idle_time_ms * 0.001)

    return {}
