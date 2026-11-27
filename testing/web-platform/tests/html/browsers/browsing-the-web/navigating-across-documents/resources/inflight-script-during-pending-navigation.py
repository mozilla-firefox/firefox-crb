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

    if action == b"observer":
        response.headers.set(b"Content-Type", b"text/html")
        parser = request.GET.first(b"parser", b"")
        if parser:
            return (
                '<!DOCTYPE html>'
                '<script>opener.postMessage("ready", location.origin)</script>'
                '<script src="' + html.escape(parser.decode("utf-8"), quote=True)
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

    if action == b"control" or kind == b"script":
        response.headers.set(b"Content-Type", b"application/javascript")
        return b"window.scriptExecuted = true;"

    if kind == b"no-content":
        response.status = 204
        return b""

    if kind == b"attachment":
        response.headers.set(b"Content-Type", b"application/octet-stream")
        response.headers.set(b"Content-Disposition", b"attachment; filename=test.bin")
        return b"download-body"

    response.headers.set(b"Content-Type", b"text/html")
    return (
        b"<!DOCTYPE html><body onload=\"opener.postMessage('navigated', '*')\">"
        b"Navigated</body>"
    )
