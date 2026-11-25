/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

#include "StreamFunctions.h"
#include "nsZipDataStream.h"
#include "nsStringStream.h"
#include "nsISeekableStream.h"
#include "nsDeflateConverter.h"
#include "nsNetUtil.h"
#include "nsComponentManagerUtils.h"
#include "mozilla/EndianUtils.h"
#include "mozilla/Maybe.h"
#include "mozilla/Result.h"
#include "mozilla/ResultExtensions.h"
#include "mozilla/Try.h"

#include <algorithm>

#define ZIP_METHOD_STORE 0
#define ZIP_METHOD_DEFLATE 8

using namespace mozilla;

/**
 * nsZipDataStream handles the writing an entry's into the zip file.
 * It is set up to wither write the data as is, or in the event that compression
 * has been requested to pass it through a stream converter.
 * Currently only the deflate compression method is supported.
 * The CRC checksum for the entry's data is also generated here.
 */
NS_IMPL_ISUPPORTS(nsZipDataStream, nsIStreamListener, nsIRequestObserver)

nsresult nsZipDataStream::Init(nsZipWriter* aWriter, nsIOutputStream* aStream,
                               nsZipHeader* aHeader, int32_t aCompression,
                               bool aGzip) {
  mWriter = aWriter;
  mHeader = aHeader;
  mStream = aStream;
  mHeader->mCRC = crc32(0L, Z_NULL, 0);

  nsresult rv =
      NS_NewSimpleStreamListener(getter_AddRefs(mOutput), aStream, nullptr);
  NS_ENSURE_SUCCESS(rv, rv);

  if (aGzip) {
    mGzip = true;
    mHeader->mMethod = ZIP_METHOD_DEFLATE;
  } else if (aCompression > 0) {
    mHeader->mMethod = ZIP_METHOD_DEFLATE;
    nsCOMPtr<nsIStreamConverter> converter =
        new nsDeflateConverter(aCompression);
    NS_ENSURE_TRUE(converter, NS_ERROR_OUT_OF_MEMORY);

    rv = converter->AsyncConvertData("uncompressed", "rawdeflate", mOutput,
                                     nullptr);
    NS_ENSURE_SUCCESS(rv, rv);

    mOutput = converter;
  } else {
    mHeader->mMethod = ZIP_METHOD_STORE;
  }

  return NS_OK;
}

NS_IMETHODIMP nsZipDataStream::OnDataAvailable(nsIRequest* aRequest,
                                               nsIInputStream* aInputStream,
                                               uint64_t aOffset,
                                               uint32_t aCount) {
  if (!mOutput) return NS_ERROR_NOT_INITIALIZED;

  auto buffer = std::make_unique<char[]>(aCount);
  NS_ENSURE_TRUE(buffer, NS_ERROR_OUT_OF_MEMORY);

  nsresult rv = ZW_ReadData(aInputStream, buffer.get(), aCount);
  NS_ENSURE_SUCCESS(rv, rv);

  return ProcessData(aRequest, nullptr, buffer.get(), aOffset, aCount);
}

NS_IMETHODIMP nsZipDataStream::OnStartRequest(nsIRequest* aRequest) {
  if (!mOutput) return NS_ERROR_NOT_INITIALIZED;

  nsCOMPtr<nsIStreamListener> output = mOutput;
  return output->OnStartRequest(aRequest);
}

NS_IMETHODIMP nsZipDataStream::OnStopRequest(nsIRequest* aRequest,
                                             nsresult aStatusCode) {
  if (!mOutput) return NS_ERROR_NOT_INITIALIZED;

  nsCOMPtr<nsIStreamListener> output = mOutput;
  nsresult rv = output->OnStopRequest(aRequest, aStatusCode);
  mOutput = nullptr;
  if (NS_SUCCEEDED(rv)) {
    rv = aStatusCode;
  }
  if (NS_SUCCEEDED(rv) && mGzip) {
    rv = FinishGzipData();
  }
  if (NS_FAILED(rv)) {
    mWriter->EntryCompleteCallback(mHeader, rv);
  } else {
    rv = CompleteEntry();
    rv = mWriter->EntryCompleteCallback(mHeader, rv);
  }

  mStream = nullptr;
  mWriter = nullptr;
  mHeader = nullptr;

  return rv;
}

inline nsresult nsZipDataStream::CompleteEntry() {
  nsresult rv;
  nsCOMPtr<nsISeekableStream> seekable = do_QueryInterface(mStream, &rv);
  NS_ENSURE_SUCCESS(rv, rv);
  int64_t pos;
  rv = seekable->Tell(&pos);
  NS_ENSURE_SUCCESS(rv, rv);

  mHeader->mCSize = pos - mHeader->mOffset - mHeader->GetFileHeaderLength();
  mHeader->mWriteOnClose = true;
  return NS_OK;
}

nsresult nsZipDataStream::WriteData(nsIRequest* aRequest,
                                    Span<const char> aData) {
  if (aData.IsEmpty()) {
    return NS_OK;
  }

  MOZ_ASSERT(aData.Length() <= INT32_MAX);
  nsCOMPtr<nsIInputStream> stream;
  nsresult rv = NS_NewByteInputStream(getter_AddRefs(stream), aData,
                                      NS_ASSIGNMENT_DEPEND);
  NS_ENSURE_SUCCESS(rv, rv);

  nsCOMPtr<nsIStreamListener> output = mOutput;
  return output->OnDataAvailable(aRequest, stream, 0, aData.Length());
}

// The gzip member format, see
// https://datatracker.ietf.org/doc/html/rfc1952#section-2.3
static constexpr size_t kGzipHeaderSize = 10;
static constexpr size_t kGzipTrailerSize = 8;
static constexpr uint8_t kGzipFlagHeaderCRC = 0x02;
static constexpr uint8_t kGzipFlagExtra = 0x04;
static constexpr uint8_t kGzipFlagName = 0x08;
static constexpr uint8_t kGzipFlagComment = 0x10;
static constexpr uint8_t kGzipFlagsReserved = 0xe0;

/**
 * Returns the length of the gzip header at the start of aData, or Nothing()
 * if aData doesn't hold the whole header yet. See section 2.3 of
 * https://datatracker.ietf.org/doc/html/rfc1952
 */
static Result<Maybe<size_t>, nsresult> ParseGzipHeader(
    Span<const uint8_t> aData) {
  if (aData.Length() < kGzipHeaderSize) {
    return Maybe<size_t>();
  }

  // Check the fixed fields of the header. The flags are checked separately.
  if (aData[0] != 0x1f || aData[1] != 0x8b || aData[2] != Z_DEFLATED ||
      (aData[3] & kGzipFlagsReserved)) {
    return Err(NS_ERROR_FILE_CORRUPTED);
  }

  const uint8_t flags = aData[3];
  size_t length = kGzipHeaderSize;
  if (flags & kGzipFlagExtra) {
    if (aData.Length() < length + 2) {
      return Maybe<size_t>();
    }
    length += 2 + LittleEndian::readUint16(&aData[length]);
  }
  for (uint8_t flag : {kGzipFlagName, kGzipFlagComment}) {
    if (!(flags & flag)) {
      continue;
    }
    // A zero terminated string.
    if (length >= aData.Length()) {
      return Maybe<size_t>();
    }
    auto rest = aData.From(length);
    auto end = std::find(rest.begin(), rest.end(), 0);
    if (end == rest.end()) {
      return Maybe<size_t>();
    }
    length += end - rest.begin() + 1;
  }
  if (flags & kGzipFlagHeaderCRC) {
    length += 2;
  }
  if (length > aData.Length()) {
    return Maybe<size_t>();
  }
  return Some(length);
}

nsresult nsZipDataStream::ProcessGzipData(nsIRequest* aRequest,
                                          Span<const char> aData) {
  mGzipPending.AppendElements(AsBytes(aData));

  if (!mGzipHeaderParsed) {
    Maybe<size_t> headerLength = MOZ_TRY(ParseGzipHeader(mGzipPending));
    if (!headerLength) {
      return NS_OK;
    }
    mGzipPending.RemoveElementsAt(0, *headerLength);
    mGzipHeaderParsed = true;
  }

  // Everything but the last kGzipTrailerSize bytes is deflate data.
  if (mGzipPending.Length() > kGzipTrailerSize) {
    size_t length = mGzipPending.Length() - kGzipTrailerSize;
    nsresult rv = WriteData(aRequest, AsChars(Span(mGzipPending).To(length)));
    NS_ENSURE_SUCCESS(rv, rv);
    mGzipPending.RemoveElementsAt(0, length);
  }
  return NS_OK;
}

nsresult nsZipDataStream::FinishGzipData() {
  if (!mGzipHeaderParsed || mGzipPending.Length() != kGzipTrailerSize) {
    return NS_ERROR_FILE_CORRUPTED;
  }
  // The trailer holds the CRC32 and size modulo 2^32 of the uncompressed data.
  mHeader->mCRC = LittleEndian::readUint32(&mGzipPending[0]);
  mHeader->mUSize = LittleEndian::readUint32(&mGzipPending[4]);
  mGzipPending.Clear();
  return NS_OK;
}

nsresult nsZipDataStream::ProcessData(nsIRequest* aRequest,
                                      nsISupports* aContext, char* aBuffer,
                                      uint64_t aOffset, uint32_t aCount) {
  if (mGzip) {
    return ProcessGzipData(aRequest, Span(aBuffer, aCount));
  }

  mHeader->mCRC = crc32(
      mHeader->mCRC, reinterpret_cast<const unsigned char*>(aBuffer), aCount);

  nsresult rv = WriteData(aRequest, Span(aBuffer, aCount));
  mHeader->mUSize += aCount;

  return rv;
}

nsresult nsZipDataStream::ReadStream(nsIInputStream* aStream) {
  if (!mOutput) return NS_ERROR_NOT_INITIALIZED;

  nsresult rv = OnStartRequest(nullptr);
  NS_ENSURE_SUCCESS(rv, rv);

  auto buffer = std::make_unique<char[]>(4096);
  NS_ENSURE_TRUE(buffer, NS_ERROR_OUT_OF_MEMORY);

  uint32_t read = 0;
  uint32_t offset = 0;
  do {
    rv = aStream->Read(buffer.get(), 4096, &read);
    if (NS_FAILED(rv)) {
      OnStopRequest(nullptr, rv);
      return rv;
    }

    if (read > 0) {
      rv = ProcessData(nullptr, nullptr, buffer.get(), offset, read);
      if (NS_FAILED(rv)) {
        OnStopRequest(nullptr, rv);
        return rv;
      }
      offset += read;
    }
  } while (read > 0);

  return OnStopRequest(nullptr, NS_OK);
}
