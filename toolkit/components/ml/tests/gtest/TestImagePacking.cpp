/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "gtest/gtest.h"
#include "mozilla/ml/MLImagePacking.h"

using namespace mozilla;
using mozilla::ml::PackRgb;
using mozilla::ml::PackRgbError;
using mozilla::ml::ThrowPackRgbError;

namespace {

nsTArray<uint8_t> Bytes(std::initializer_list<uint8_t> aValues) {
  nsTArray<uint8_t> bytes;
  bytes.AppendElements(aValues.begin(), aValues.size());
  return bytes;
}

// Asserts the call failed, and failed as bad input rather than as an
// allocation failure, which the two report to callers differently.
void ExpectInvalidInput(
    const Result<nsTArray<uint8_t>, PackRgbError>& aResult) {
  ASSERT_TRUE(aResult.isErr());
  EXPECT_EQ(aResult.inspectErr().mKind, PackRgbError::InvalidInput);
  EXPECT_FALSE(aResult.inspectErr().mMessage.IsEmpty());
}

}  // namespace

TEST(MLImagePacking, ThreeChannelsPassThrough)
{
  auto data = Bytes({1, 2, 3, 4, 5, 6});
  auto result = PackRgb(data, 2, 1, 3);
  ASSERT_TRUE(result.isOk());
  EXPECT_EQ(result.inspect(), data);
}

TEST(MLImagePacking, FourChannelsDropAlpha)
{
  // Two pixels, each with an alpha byte that must not survive.
  auto data = Bytes({1, 2, 3, 99, 4, 5, 6, 98});
  auto result = PackRgb(data, 2, 1, 4);
  ASSERT_TRUE(result.isOk());
  EXPECT_EQ(result.inspect(), Bytes({1, 2, 3, 4, 5, 6}));
}

TEST(MLImagePacking, RejectsShortBuffer)
{
  // One byte short of 2x1x3. Accepting this would read past the end.
  auto data = Bytes({1, 2, 3, 4, 5});
  ExpectInvalidInput(PackRgb(data, 2, 1, 3));
}

TEST(MLImagePacking, RejectsLongBuffer)
{
  auto data = Bytes({1, 2, 3, 4, 5, 6, 7});
  ExpectInvalidInput(PackRgb(data, 2, 1, 3));
}

TEST(MLImagePacking, RejectsZeroDimensions)
{
  auto data = Bytes({});
  // A zero dimension expects zero bytes, which any buffer satisfies.
  ExpectInvalidInput(PackRgb(data, 0, 1, 3));
  ExpectInvalidInput(PackRgb(data, 1, 0, 3));
}

TEST(MLImagePacking, RejectsOtherChannelCounts)
{
  auto data = Bytes({1, 2});
  ExpectInvalidInput(PackRgb(data, 1, 1, 1));
  ExpectInvalidInput(PackRgb(data, 1, 1, 2));
  ExpectInvalidInput(PackRgb(data, 1, 1, 5));
}

TEST(MLImagePacking, RejectsDimensionOverflow)
{
  auto data = Bytes({1, 2, 3});
  // width * height * channels overflows size_t rather than wrapping to a
  // small expectation that the buffer happens to satisfy.
  ExpectInvalidInput(PackRgb(data, UINT32_MAX, UINT32_MAX, 4));
}

TEST(MLImagePacking, InvalidInputBecomesATypeError)
{
  ErrorResult rv;
  ThrowPackRgbError({PackRgbError::InvalidInput, nsCString("is empty (0x1)")},
                    2, rv);
  EXPECT_TRUE(rv.ErrorCodeIs(NS_ERROR_INTERNAL_ERRORRESULT_TYPEERROR));
  rv.SuppressException();
}

TEST(MLImagePacking, OutOfMemoryIsNotATypeError)
{
  ErrorResult rv;
  ThrowPackRgbError({PackRgbError::OutOfMemory, nsCString()}, 0, rv);
  EXPECT_TRUE(rv.ErrorCodeIs(NS_ERROR_OUT_OF_MEMORY));
  rv.SuppressException();
}
