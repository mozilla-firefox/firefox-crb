#!/usr/bin/env bash

# Each file holds 48000 frames of mono silence at 48 kHz with single sample
# clicks at frames 100, 2000, 12100, 13500 and 30000, encoded as Opus by
# libopus, which adds 312 frames of pre-skip. The containers signal the
# pre-skip in their own way: the Ogg granule positions, an MP4 edit list, and
# the WebM CodecDelay.
#
# Requires ffmpeg with libopus, mkvmerge, and python3.

set -euo pipefail

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

python3 - "$tmp/clicks.wav" <<'PY'
import struct, sys, wave
frames = [0] * 48000
for click in (100, 2000, 12100, 13500, 30000):
    frames[click] = 30000
with wave.open(sys.argv[1], "wb") as w:
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(48000)
    w.writeframes(struct.pack("<%dh" % len(frames), *frames))
PY

encode() {
    ffmpeg -v error -y -i "$tmp/clicks.wav" -c:a libopus -b:a 64k \
        -map_metadata -1 -fflags +bitexact -flags:a +bitexact "$@"
}

encode opus_clicks.opus
encode opus_clicks.mp4
encode -movflags +frag_keyframe+empty_moov+default_base_moof \
    opus_clicks_frag.mp4
mkvmerge -q --webm --no-date --disable-track-statistics-tags \
    --disable-lacing --timestamp-scale 1000000 -o opus_clicks.webm \
    opus_clicks.opus
