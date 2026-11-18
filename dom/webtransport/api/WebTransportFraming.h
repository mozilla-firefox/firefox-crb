/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* vim:set ts=2 sw=2 sts=2 et cindent: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef mozilla_dom_WebTransportFraming_h
#define mozilla_dom_WebTransportFraming_h

#include "nsTArray.h"

namespace mozilla::dom {

struct PendingWriteEntry;  // Forward declaration

#define WEBTRANSPORT_FRAME_MAX_HEADER_SIZE 9

// The type byte and the 4-byte length that start every frame.  The length
// counts everything after them, including an atomic id or abort code, so a
// whole frame is this plus the length.
#define WEBTRANSPORT_FRAME_PREFIX_SIZE 5

// Upper bound on a single frame's payload length, as declared in the frame
// header by the (untrusted) content process. Bounds the parent's reassembly
// buffer and prevents the size arithmetic below from overflowing size_t on
// 32-bit platforms.
#define WEBTRANSPORT_FRAME_MAX_PAYLOAD (128 * 1024 * 1024)

// Frame types for WebTransport DataPipe protocol
enum class WebTransportFrameType : uint8_t {
  Regular = 0x00,  // Regular write() chunk
  Atomic = 0x01,   // atomicWrite() chunk
  Abort = 0x02,    // abort(): 4-byte stream error code, then no more frames
};

// Result of attempting to parse a frame header out of the (untrusted,
// content-process-supplied) reassembly buffer.
enum class WebTransportFrameParseResult : uint8_t {
  Success,       // A complete, well-formed frame was parsed.
  NeedMoreData,  // The buffer doesn't yet hold a full header/frame; wait for
                 // more bytes.
  Malformed,     // The buffered bytes can never form a valid frame; the
                 // caller must abort the stream rather than wait for more
                 // data.
};

// Frame a chunk for transmission over DataPipe
// Frame format: [1 byte type][4 bytes length big-endian]{[4 bytes big-endian
// Atomic Id or Abort code]}[data]
// An Abort frame has no data; its length is 4.
inline uint32_t FrameWebTransportChunkHeader(uint8_t (&aHeader)[9],
                                             WebTransportFrameType aType,
                                             uint32_t aAtomicId,
                                             const nsTArray<uint8_t>& aData) {
  // Type byte
  aHeader[0] = static_cast<uint8_t>(aType);

  // Length (4 bytes, big-endian)
  uint32_t length =
      aData.Length() + (aType != WebTransportFrameType::Regular ? 4 : 0);
  aHeader[1] = (length >> 24) & 0xFF;
  aHeader[2] = (length >> 16) & 0xFF;
  aHeader[3] = (length >> 8) & 0xFF;
  aHeader[4] = length & 0xFF;

  if (aType != WebTransportFrameType::Regular) {
    aHeader[5] = (aAtomicId >> 24) & 0xFF;
    aHeader[6] = (aAtomicId >> 16) & 0xFF;
    aHeader[7] = (aAtomicId >> 8) & 0xFF;
    aHeader[8] = aAtomicId & 0xFF;
    return 9;
  }
  return 5;
}

// Parse frame header (first 5 or 9 bytes). aAtomicId receives the atomic write
// id of an Atomic frame, or the stream error code of an Abort frame.
WebTransportFrameParseResult ParseWebTransportFrameHeader(
    nsTArray<uint8_t>& aBuffer, WebTransportFrameType& aType,
    uint32_t& aAtomicId, nsTArray<uint8_t>& aPayload, size_t& aLength);

// Initialize the header for a PendingWriteEntry
// Should be called once when the entry is created
void InitializePendingWriteEntryHeader(PendingWriteEntry& aEntry);

}  // namespace mozilla::dom

#endif  // mozilla_dom_WebTransportFraming_h
