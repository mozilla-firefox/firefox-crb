#!/usr/bin/env bash

# Each file holds 23500 frames of mono silence at 48 kHz with a single sample
# click, encoded as Opus in WebM. With the 312 frames of pre-skip, they take 25
# packets of 960 frames, and the DiscardPadding of the last block discards the
# last 188 frames. mkvmerge writes the block timestamps exactly, where ffmpeg's
# WebM muxer rounds them 1 ms late after the first block.
#
# Requires ffmpeg with libopus, mkvmerge, and python3.

set -euo pipefail

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

opus_click() {
    python3 - "$tmp/click.wav" "$1" <<'EOF'
import struct, sys, wave
frames = [0] * 23500
frames[int(sys.argv[2])] = 30000
with wave.open(sys.argv[1], "wb") as w:
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(48000)
    w.writeframes(struct.pack("<%dh" % len(frames), *frames))
EOF
    ffmpeg -v error -y -i "$tmp/click.wav" -c:a libopus -b:a 64k \
        -map_metadata -1 -fflags +bitexact -flags:a +bitexact "$tmp/click.opus"
    mkvmerge -q --webm --no-date --disable-track-statistics-tags \
        --disable-lacing --timestamp-scale 1000000 -o "$2" "$tmp/click.opus"
}

# The click is in the first packet.
opus_click 500 opus_click_start.webm
# The click is in a packet that the CodecDelay doesn't trim.
opus_click 12000 opus_click_middle.webm
# The click is in the last packet, before the padding it discards.
opus_click 23400 opus_click_end.webm
