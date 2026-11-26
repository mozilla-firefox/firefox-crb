import time

# SSE endpoint that includes a connection ID in every event. Each new
# connection (or reconnection) increments the ID, so a test can detect
# whether the browser kept the original connection alive across BFCache
# or dropped and re-established it.
#
# Query parameters:
#   uuid=<uuid>   Identifies the logical stream (required).
#
# Events carry `connectionId` in their data field. The first connection
# for a given uuid gets id 1, a reconnect gets 2, etc.


def main(request, response):
    uuid = request.GET.first(b"uuid").decode()
    with request.server.stash.lock:
        count = request.server.stash.take(uuid) or 0
        count += 1
        request.server.stash.put(uuid, count)

    response.headers.set(b"Content-Type", b"text/event-stream")
    response.headers.set(b"Cache-Control", b"no-store")
    response.write_status_headers()

    for i in range(30):
        data = "data: connectionId=%d seq=%d" % (count, i)
        response.writer.write(f"{data}\n\n")
        time.sleep(0.5)
