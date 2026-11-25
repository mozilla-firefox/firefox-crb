/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "mozilla/ml/MLImagePacking.h"

#include "mozilla/CheckedInt.h"
#include "nsPrintfCString.h"

namespace mozilla::ml {

static PackRgbError InvalidInput(const nsACString& aMessage) {
  return PackRgbError{PackRgbError::InvalidInput, nsCString(aMessage)};
}

Result<nsTArray<uint8_t>, PackRgbError> PackRgb(Span<const uint8_t> aData,
                                                uint32_t aWidth,
                                                uint32_t aHeight,
                                                uint32_t aChannels) {
  if (aChannels != 3 && aChannels != 4) {
    return Err(InvalidInput(nsPrintfCString(
        "has %u channels, expected 3 (RGB) or 4 (RGBA)", aChannels)));
  }
  // Without this an empty image expects zero bytes, which any buffer satisfies.
  if (aWidth == 0 || aHeight == 0) {
    return Err(
        InvalidInput(nsPrintfCString("is empty (%ux%u)", aWidth, aHeight)));
  }

  CheckedInt<size_t> expected(aWidth);
  expected *= aHeight;
  expected *= aChannels;
  if (!expected.isValid()) {
    return Err(InvalidInput(nsPrintfCString("dimensions overflow (%ux%ux%u)",
                                            aWidth, aHeight, aChannels)));
  }
  if (aData.Length() != expected.value()) {
    return Err(InvalidInput(
        nsPrintfCString("has %zu bytes, expected %zu (%ux%ux%u)",
                        aData.Length(), expected.value(), aWidth, aHeight,
                        aChannels)));
  }

  const size_t numPixels = size_t(aWidth) * aHeight;
  nsTArray<uint8_t> rgb;
  if (!rgb.SetLength(numPixels * 3, fallible)) {
    return Err(PackRgbError{PackRgbError::OutOfMemory, nsCString()});
  }
  if (aChannels == 3) {
    memcpy(rgb.Elements(), aData.Elements(), numPixels * 3);
  } else {
    for (size_t p = 0; p < numPixels; ++p) {
      rgb[p * 3 + 0] = aData[p * 4 + 0];
      rgb[p * 3 + 1] = aData[p * 4 + 1];
      rgb[p * 3 + 2] = aData[p * 4 + 2];
    }
  }
  return rgb;
}

void ThrowPackRgbError(const PackRgbError& aError, size_t aIndex,
                       ErrorResult& aRv) {
  if (aError.mKind == PackRgbError::OutOfMemory) {
    aRv.Throw(NS_ERROR_OUT_OF_MEMORY);
    return;
  }
  aRv.ThrowTypeError(
      nsPrintfCString("image %zu %s", aIndex, aError.mMessage.get()));
}

}  // namespace mozilla::ml
