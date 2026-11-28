import struct
import time
import zlib

# Serves a PNG image whose response is held until a separate "release"
# request arrives with the same uuid.
#
# Query parameters:
#   uuid=<uuid>     Identifies the request (required).
#   release=1       Unblocks the waiting request with the same uuid.
#   (otherwise)     Blocks until released, then sends the full PNG.


def make_png(width=64, height=64):
    """Generate a minimal valid RGBA PNG (solid red)."""

    def chunk(chunk_type, data):
        c = chunk_type + data
        return (
            struct.pack(">I", len(data))
            + c
            + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)
        )

    header = b"\x89PNG\r\n\x1a\n"
    ihdr = chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))

    raw = b""
    for y in range(height):
        raw += b"\x00"  # filter byte
        raw += b"\xff\x00\x00" * width  # red pixels

    idat = chunk(b"IDAT", zlib.compress(raw))
    iend = chunk(b"IEND", b"")
    return header + ihdr + idat + iend


def main(request, response):
    uuid = request.GET.first(b"uuid").decode()
    if b"release" in request.GET:
        try:
            request.server.stash.put(uuid, True)
        except Exception:
            pass
        return (200, [(b"Content-Type", b"text/plain")], b"ok")

    body = make_png()

    response.headers.set(b"Content-Type", b"image/png")
    response.headers.set(b"Content-Length", str(len(body)).encode())
    response.headers.set(b"Cache-Control", b"no-store")
    response.write_status_headers()

    remaining = 30
    while remaining > 0 and not request.server.stash.take(uuid):
        time.sleep(1)
        remaining -= 1

    response.writer.write_content(body)
