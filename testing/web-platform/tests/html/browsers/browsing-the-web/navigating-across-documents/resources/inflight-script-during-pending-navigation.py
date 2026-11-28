"""Serves responses that a test can hold open, see pending-navigation-helpers.js.

Query parameters:
  action=test-page  The page under test. It posts "ready" to its opener once
                    loaded, or with parser-blocking-script=<url>, posts "ready"
                    and then blocks its parser on a script loaded from <url>.
  action=hold       Responds with |kind| once action=release is sent for |id|.
  action=immediate  Responds with |kind| at once.
  action=wait       Returns once the held response for |id| was requested.
  action=release    Releases the held response for |id|.

Kinds, for action=hold and action=immediate:
  script       A script that sets window.scriptExecuted.
  navigation   A page that posts "navigated" to its opener once loaded.
  no-content   An HTTP 204, a navigation to which never commits.
  attachment   A Content-Disposition: attachment download, a navigation to
               which never commits.
"""

import html
import time


def wait_for_signal(stash, key, path):
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        if stash.take(key, path=path):
            return True
        time.sleep(0.01)
    return False


def main(request, response):
    response.headers.set(b"Cache-Control", b"no-store")
    action = request.GET.first(b"action")
    key = request.GET.first(b"id", b"")
    kind = request.GET.first(b"kind", b"")
    stash = request.server.stash
    started_path = request.url_parts.path + "/started"
    release_path = request.url_parts.path + "/release"
    timeout_path = request.url_parts.path + "/timeout"

    if action == b"test-page":
        response.headers.set(b"Content-Type", b"text/html")
        parser_blocking_script = request.GET.first(b"parser-blocking-script", b"")
        if parser_blocking_script:
            return (
                '<!DOCTYPE html>'
                '<script>opener.postMessage("ready", location.origin)</script>'
                '<script src="' + html.escape(parser_blocking_script.decode("utf-8"), quote=True)
                + '" onload="opener.postMessage(\'parser-script-load\', location.origin)"'
                ' onerror="opener.postMessage(\'parser-script-error\', location.origin)">'
                '</script>'
            ).encode("utf-8")
        return (
            b'<!DOCTYPE html><script>addEventListener("load", () => '
            b'opener.postMessage("ready", location.origin));</script>'
        )

    if action == b"release":
        if stash.take(key, path=timeout_path):
            response.status = 504
            return b"Response timed out before it was released"
        stash.put(key, True, path=release_path)
        return b""

    if action == b"wait":
        if not wait_for_signal(stash, key, started_path):
            response.status = 504
        return b""

    if action == b"hold":
        stash.put(key, True, path=started_path)
        if not wait_for_signal(stash, key, release_path):
            stash.put(key, True, path=timeout_path)
            response.status = 504
            return b"Response was not released"
    elif action != b"immediate":
        response.status = 400
        return b"Unknown action " + action

    if kind == b"script":
        response.headers.set(b"Content-Type", b"application/javascript")
        return b"window.scriptExecuted = true;"

    if kind == b"navigation":
        response.headers.set(b"Content-Type", b"text/html")
        return (
            b"<!DOCTYPE html><body onload=\"opener.postMessage('navigated', '*')\">"
            b"Navigated</body>"
        )

    if kind == b"no-content":
        response.status = 204
        return b""

    if kind == b"attachment":
        response.headers.set(b"Content-Type", b"application/octet-stream")
        response.headers.set(b"Content-Disposition", b"attachment; filename=test.bin")
        return b"download-body"

    response.status = 400
    return b"Unknown kind " + kind
