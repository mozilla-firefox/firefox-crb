/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* vim:set ts=2 sw=2 sts=2 et cindent: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "mozilla/dom/WebTransportFraming.h"

#include "mozilla/dom/WebTransportLog.h"
#include "mozilla/dom/WebTransportSendStream.h"

namespace mozilla::dom {

void InitializePendingWriteEntryHeader(PendingWriteEntry& aEntry) {
  if (aEntry.mAtomicWriteId) {
    aEntry.mHeaderLen = FrameWebTransportChunkHeader(
        aEntry.mHeader, WebTransportFrameType::Atomic, *aEntry.mAtomicWriteId,
        aEntry.mData);
  } else {
    aEntry.mHeaderLen = FrameWebTransportChunkHeader(
        aEntry.mHeader, WebTransportFrameType::Regular, 0, aEntry.mData);
  }
}

// Returns true if successful and all the data is in the buffer, false otherwise
bool ParseWebTransportFrameHeader(nsTArray<uint8_t>& aBuffer,
                                  WebTransportFrameType& aType,
                                  uint32_t& aAtomicId,
                                  nsTArray<uint8_t>& aPayload,
                                  size_t& aLength) {
  // NOTE: be careful, this is data from a content process
  auto len = aBuffer.Length();
  if (len > 0) {
    WebTransportFrameType type = static_cast<WebTransportFrameType>(aBuffer[0]);
    switch (type) {
      case WebTransportFrameType::Regular:
        if (len < 5) {
          return false;
        }
        break;
      case WebTransportFrameType::Atomic:
        if (len < 9) {
          return false;
        }
        break;
      default:
        // Invalid frame type from content process - reject gracefully
        return false;
    }
    aType = static_cast<WebTransportFrameType>(type);
    aLength = (static_cast<uint32_t>(aBuffer[1]) << 24) |
              (static_cast<uint32_t>(aBuffer[2]) << 16) |
              (static_cast<uint32_t>(aBuffer[3]) << 8) |
              static_cast<uint32_t>(aBuffer[4]);
    // Reject implausibly large frames before using aLength in size arithmetic
    // (aLength + 5 could otherwise overflow size_t on 32-bit platforms).
    if (aLength > WEBTRANSPORT_FRAME_MAX_PAYLOAD) {
      return false;
    }
    // aLength includes atomic id if it's Atomic
    if (aBuffer.Length() < aLength + 5) {
      // not enough data yet
      return false;
    }
    if (aType == WebTransportFrameType::Atomic) {
      aAtomicId = (static_cast<uint32_t>(aBuffer[5]) << 24) |
                  (static_cast<uint32_t>(aBuffer[6]) << 16) |
                  (static_cast<uint32_t>(aBuffer[7]) << 8) |
                  static_cast<uint32_t>(aBuffer[8]);
      // Atomic frame payload length must include 4-byte atomic ID
      if (aLength < 4) {
        return false;
      }
      // Use Elements() + offset rather than &aBuffer[offset] to avoid the
      // bounds-check in ElementAt(): when aLength == 4 (zero-length payload)
      // the offset equals the array length, which ElementAt() rejects even
      // for a 0-byte AppendElements call.
      aPayload.AppendElements(aBuffer.Elements() + 9, (size_t)(aLength - 4));
    } else {
      // Same reasoning as above for zero-length regular frames.
      aPayload.AppendElements(aBuffer.Elements() + 5, (size_t)aLength);
    }
    return true;
  }
  return false;
}

}  // namespace mozilla::dom
