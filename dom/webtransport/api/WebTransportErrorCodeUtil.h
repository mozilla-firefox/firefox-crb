/* -*- Mode: C++; tab-width: 8; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* vim: set ts=8 sts=2 et sw=2 tw=80: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef DOM_WEBTRANSPORT_API_WEBTRANSPORTERRORCODEUTIL_H_
#define DOM_WEBTRANSPORT_API_WEBTRANSPORTERRORCODEUTIL_H_

#include <cstdint>
#include <limits>

namespace mozilla::dom {

// https://datatracker.ietf.org/doc/html/draft-ietf-webtrans-http3-15#section-4.4
// Converts WebTransport application error code to HTTP/3 error code, skipping
// reserved HTTP/3 greasing codepoints.
inline uint64_t WebTransportErrorToHttp3(uint8_t aWebTransportCode) {
  constexpr uint64_t kFirstWebTransportErrorCode = 0x52e4a40fa8db;
  return kFirstWebTransportErrorCode + aWebTransportCode +
         (aWebTransportCode / 0x1e);
}

// https://datatracker.ietf.org/doc/html/draft-ietf-webtrans-http3-15#section-4.4
// Converts HTTP/3 error code back to WebTransport application error code.
// Returns 0 if aHttp3Code is outside the WebTransport range or is a reserved
// HTTP/3 greasing codepoint.
inline uint8_t Http3ErrorToWebTransport(uint64_t aHttp3Code) {
  constexpr uint64_t kFirstWebTransportErrorCode = 0x52e4a40fa8db;
  constexpr uint64_t kLastWebTransportErrorCode = 0x52e5ac983162;

  if (aHttp3Code < kFirstWebTransportErrorCode ||
      aHttp3Code > kLastWebTransportErrorCode) {
    return 0;
  }
  if ((aHttp3Code - 0x21) % 0x1f == 0) {
    return 0;
  }
  uint64_t shifted = aHttp3Code - kFirstWebTransportErrorCode;
  uint64_t result = shifted - shifted / 0x1f;
  if (result > std::numeric_limits<uint8_t>::max()) {
    return 0;
  }
  return static_cast<uint8_t>(result);
}

}  // namespace mozilla::dom

#endif  // DOM_WEBTRANSPORT_API_WEBTRANSPORTERRORCODEUTIL_H_
