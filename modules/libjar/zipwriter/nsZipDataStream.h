/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

#ifndef _nsZipDataStream_h_
#define _nsZipDataStream_h_

#include "nsZipWriter.h"
#include "nsIOutputStream.h"
#include "nsIStreamListener.h"
#include "nsTArray.h"
#include "mozilla/Span.h"

class nsZipDataStream final : public nsIStreamListener {
 public:
  NS_DECL_THREADSAFE_ISUPPORTS
  NS_DECL_NSIREQUESTOBSERVER
  NS_DECL_NSISTREAMLISTENER

  nsZipDataStream() = default;

  nsresult Init(nsZipWriter* aWriter, nsIOutputStream* aStream,
                nsZipHeader* aHeader, int32_t aCompression, bool aGzip = false);

  nsresult ReadStream(nsIInputStream* aStream);

 private:
  ~nsZipDataStream() = default;

  nsCOMPtr<nsIStreamListener> mOutput;
  nsCOMPtr<nsIOutputStream> mStream;
  RefPtr<nsZipWriter> mWriter;
  RefPtr<nsZipHeader> mHeader;

  // It is possible to send in already compressed data to the zip writer, 
  // in which case we need to parse the gzip header and trailer.
  bool mGzip = false;
  bool mGzipHeaderParsed = false;
  // Gzip data that hasn't been written yet. This is the header until it has
  // been parsed, then the last bytes seen, which may be the trailer.
  nsTArray<uint8_t> mGzipPending;

  nsresult CompleteEntry();
  nsresult WriteData(nsIRequest* aRequest, mozilla::Span<const char> aData);
  nsresult ProcessGzipData(nsIRequest* aRequest,
                           mozilla::Span<const char> aData);
  nsresult FinishGzipData();
  nsresult ProcessData(nsIRequest* aRequest, nsISupports* aContext,
                       char* aBuffer, uint64_t aOffset, uint32_t aCount);
};

#endif
