/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef mozilla_ml_MLImagePacking_h
#define mozilla_ml_MLImagePacking_h

#include <cstdint>

#include "mozilla/ErrorResult.h"
#include "mozilla/Result.h"
#include "mozilla/ResultVariant.h"
#include "mozilla/Span.h"
#include "nsTArray.h"
#include "nsString.h"

namespace mozilla::ml {

/**
 * Why PackRgb failed. Running out of memory is not a caller mistake, so it is
 * reported apart from the input checks. mMessage describes what was wrong with
 * the input and is set for InvalidInput only.
 */
struct PackRgbError {
  enum Kind : uint8_t { InvalidInput, OutOfMemory };

  Kind mKind;
  nsCString mMessage;
};

/**
 * Validates aData against the given dimensions and returns it as tightly
 * packed RGB, exactly aWidth * aHeight * 3 bytes, which is the layout
 * mtmd_bitmap_init requires. aChannels must be 3 (passed through) or 4 (alpha
 * dropped).
 */
Result<nsTArray<uint8_t>, PackRgbError> PackRgb(Span<const uint8_t> aData,
                                                uint32_t aWidth,
                                                uint32_t aHeight,
                                                uint32_t aChannels);

/**
 * Reports aError on aRv: a TypeError naming the image at aIndex for bad input,
 * NS_ERROR_OUT_OF_MEMORY for an allocation failure.
 */
void ThrowPackRgbError(const PackRgbError& aError, size_t aIndex,
                       ErrorResult& aRv);

}  // namespace mozilla::ml

#endif
