#!/usr/bin/env bash

# Each file holds 24576 frames (24 AAC packets) of mono silence at 48 kHz with a
# single sample click.
# The AAC files are fragmented, with the init segment and the media segment in
# one file, and signal the encoder's 1024 frames of priming with an edit list
# of media_time 1024 and segment_duration 0, as shaka-packager writes it.
# The FLAC file has no codec delay and serves as a reference.
#
# Requires ffmpeg, MP4Box (GPAC) and python3.

set -euo pipefail

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

click_wav() {
    python3 - "$1" "$2" <<'EOF'
import struct, sys, wave
rate = 48000
frames = [0] * 24576
frames[int(sys.argv[2])] = 30000
with wave.open(sys.argv[1], "wb") as w:
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(rate)
    w.writeframes(struct.pack("<%dh" % len(frames), *frames))
EOF
}

aac_with_priming_edit() {
    local wav="$1" bitrate="$2" out="$3"
    ffmpeg -v error -y -i "$wav" -c:a aac -b:a "$bitrate" -map_metadata -1 \
        -fflags +bitexact -flags:a +bitexact "$tmp/plain.mp4"
    rm -rf "$tmp/dash" && mkdir "$tmp/dash"
    MP4Box -quiet -dash 10000 -frag 10000 -rap -segment-name s_ \
        -out "$tmp/dash/o.mpd" "$tmp/plain.mp4"
    cat "$tmp/dash/s_init.mp4" "$tmp/dash/s_1.m4s" > "$out"
}

click_wav "$tmp/click-500.wav" 500
click_wav "$tmp/click-2400.wav" 2400
click_wav "$tmp/click-21600.wav" 21600
click_wav "$tmp/click-24000.wav" 24000

aac_with_priming_edit "$tmp/click-2400.wav" 64k aac_priming_click.mp4
# A different init segment, as from another encode, with the click in the first
# frame after the priming.
aac_with_priming_edit "$tmp/click-500.wav" 96k aac_priming_click_start_96k.mp4
# The same packets in fragments of one packet, except the last fragment,
# which holds two.
rm -rf "$tmp/dash" && mkdir "$tmp/dash"
MP4Box -quiet -dash 21 -frag 21 -rap -segment-name s_ \
    -out "$tmp/dash/o.mpd" "$tmp/plain.mp4"
cat "$tmp/dash/s_init.mp4" $(ls "$tmp"/dash/s_*.m4s | sort -t_ -k2 -n) \
    > aac_priming_click_start_96k_frags.mp4
# The click lies after mehd - media_time, but within the presentation.
aac_with_priming_edit "$tmp/click-24000.wav" 64k aac_priming_click_end.mp4
# The edit list skips 2112 frames, the historical QuickTime value, so the first
# 1088 frames after the priming are skipped as well.
python3 - aac_priming_click.mp4 aac_priming_2112_click.mp4 <<'EOF'
import struct, sys
data = bytearray(open(sys.argv[1], "rb").read())
elst = data.index(b"elst")
# version and flags, entry_count, segment_duration, then media_time.
assert data[elst + 4] == 0 and struct.unpack_from(">I", data, elst + 8)[0] == 1
struct.pack_into(">i", data, elst + 16, 2112)
open(sys.argv[2], "wb").write(data)
EOF

ffmpeg -v error -y -i "$tmp/click-21600.wav" -c:a flac -map_metadata -1 \
    -fflags +bitexact -flags:a +bitexact \
    -movflags frag_keyframe+empty_moov+default_base_moof flac_click_48k.mp4
