import time

# Serves a large response. Most of the response is held until a "release"
# request arrives. 80 bytes are sent before blocking so that tests that
# reliably want to see some data received before entering bfcache can do so.
# The release request itself blocks until the data response has finished
# sending, so the caller can `await fetch(releaseURL)` to know both the
# release and the data delivery are complete.
#
# Query parameters:
#   uuid=<uuid>       Identifies the request pair (required).
#   done=<uuid>       A second UUID used to signal completion (required).
#   release=1         Signals the data request to start sending.
#                     Blocks until the data request has finished.
#   size=<bytes>      Body size in bytes (default 1100000, ~1074 KB).


def make_body(size):
    base = bytearray(range(ord(b"a"), ord(b"z") + 1))
    body = base * (size // len(base)) + base[: size % len(base)]
    return bytes(body)


def main(request, response):
    uuid = request.GET.first(b"uuid").decode()
    done_uuid = request.GET.first(b"done").decode()

    if b"release" in request.GET:
        # Signal the data request to start sending.
        request.server.stash.put(uuid, True)

        # Wait until the data request signals completion.
        remaining = 30
        bytes_written = 0
        while remaining > 0:
            done = request.server.stash.take(done_uuid)
            if done:
                bytes_written = done
                break
            time.sleep(1)
            remaining -= 1

        return (200, [(b"Content-Type", b"text/plain")], str(bytes_written).encode())

    # Data request: wait for the release signal, then send a large body.
    size = int(request.GET.first(b"size", b"1100000"))
    body = make_body(size)

    response.headers.set(b"Content-Type", b"application/octet-stream")
    response.headers.set(b"Content-Length", str(len(body)).encode())
    response.headers.set(b"Cache-Control", b"no-store")
    response.write_status_headers()

    response.writer.write_content(body[0:80])

    # Wait for release.
    remaining = 30
    while remaining > 0 and not request.server.stash.take(uuid):
        time.sleep(1)
        remaining -= 1

    response.writer.write_content(body[80:])

    # Give the network stack time to deliver the data to the client.
    time.sleep(2)

    # Signal the release request that we're done, passing the byte count.
    try:
        request.server.stash.put(done_uuid, len(body))
    except Exception:
        pass
