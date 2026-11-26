import time

# Serves a response whose body is held until a separate "release" request
# arrives with the same uuid.  This lets a test start a request, navigate
# away into BFCache, navigate back, *then* unblock the response and
# verify the full body was received.
#
# Query parameters:
#   uuid=<uuid>     Identifies the request (required).
#   release=1       Unblocks the waiting request with the same uuid.
#   size=<bytes>    Body size in bytes (default 65536).
#   (otherwise)     Blocks until released, then sends a deterministic body.
#
# The body is repeating ASCII (a-z cycling), so the test can verify every
# byte.


def make_body(size):
    base = bytearray(range(ord(b"a"), ord(b"z") + 1))
    body = base * (size // len(base)) + base[: size % len(base)]
    return bytes(body)


def main(request, response):
    uuid = request.GET.first(b"uuid").decode()
    if b"release" in request.GET:
        try:
            request.server.stash.put(uuid, True)
        except Exception:
            pass
        return (200, [(b"Content-Type", b"text/plain")], b"ok")

    size = int(request.GET.first(b"size", b"65536"))
    body = make_body(size)

    response.headers.set(b"Content-Type", b"application/octet-stream")
    response.headers.set(b"Content-Length", str(len(body)).encode())
    response.headers.set(b"Cache-Control", b"no-store")
    response.write_status_headers()

    remaining = 30  # ~30s safety timeout
    firstHalf = body[: size // 2]
    secondHalf = body[size // 2 :]
    response.writer.write_content(firstHalf)
    while remaining > 0 and not request.server.stash.take(uuid):
        time.sleep(1)
        remaining -= 1

    response.writer.write_content(secondHalf)
