"""Minimal mitmproxy addon for testing intercept proxy mode."""

import re

from mitmproxy import http

URLS = re.compile(r"test-.*\.org")

BODY = """<!doctype html>
<meta charset="utf-8">
<title>Intercept Test</title>
<p>Hello from intercept addon</p>
"""

TEST_RESPONSE = http.Response.make(
    200,
    BODY.encode("utf-8"),
    {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
    },
)


class TestInterceptAddon:
    def request(self, flow) -> None:
        if not URLS.match(flow.request.pretty_host):
            return
        if flow.request.method != "GET":
            return
        flow.response = TEST_RESPONSE


addons = [TestInterceptAddon()]
