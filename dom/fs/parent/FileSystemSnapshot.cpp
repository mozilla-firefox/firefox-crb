/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "FileSystemSnapshot.h"

#include "mozilla/ErrorResult.h"
#include "nsIFile.h"

namespace mozilla::dom::fs {

NS_IMPL_ISUPPORTS(SnapshotInputStream, nsIInputStream,
                  nsICloneableInputStream, nsISeekableStream,
                  nsITellableStream)

SnapshotInputStream::SnapshotInputStream(nsIInputStream* aInner,
                                         RefPtr<SnapshotState> aState)
    : SnapshotInputStream(aInner, std::move(aState), NS_OK) {}

SnapshotInputStream::SnapshotInputStream(nsIInputStream* aInner,
                                         RefPtr<SnapshotState> aState,
                                         nsresult aStatus)
    : mInner(aInner), mState(std::move(aState)), mStatus(aStatus) {
  MOZ_ASSERT(mInner);
  MOZ_ASSERT(mState);
  MOZ_ASSERT(nsCOMPtr<nsICloneableInputStream>(do_QueryInterface(mInner)));
  MOZ_ASSERT(nsCOMPtr<nsISeekableStream>(do_QueryInterface(mInner)));
}

NS_IMETHODIMP SnapshotInputStream::Close() { return mInner->Close(); }

NS_IMETHODIMP SnapshotInputStream::Available(uint64_t* aResult) {
  if (NS_FAILED(mStatus)) {
    return mStatus;
  }
  return mInner->Available(aResult);
}

NS_IMETHODIMP SnapshotInputStream::StreamStatus() {
  if (NS_FAILED(mStatus)) {
    return mStatus;
  }
  return mInner->StreamStatus();
}

NS_IMETHODIMP SnapshotInputStream::Read(char* aBuf, uint32_t aCount,
                                        uint32_t* aResult) {
  if (NS_FAILED(mStatus)) {
    *aResult = 0;
    return mStatus;
  }
  return mInner->Read(aBuf, aCount, aResult);
}

NS_IMETHODIMP SnapshotInputStream::ReadSegments(nsWriteSegmentFun aWriter,
                                                void* aClosure,
                                                uint32_t aCount,
                                                uint32_t* aResult) {
  if (NS_FAILED(mStatus)) {
    *aResult = 0;
    return mStatus;
  }
  return mInner->ReadSegments(aWriter, aClosure, aCount, aResult);
}

NS_IMETHODIMP SnapshotInputStream::IsNonBlocking(bool* aNonBlocking) {
  return mInner->IsNonBlocking(aNonBlocking);
}

NS_IMETHODIMP SnapshotInputStream::GetCloneable(bool* aCloneable) {
  *aCloneable = true;
  return NS_OK;
}

NS_IMETHODIMP SnapshotInputStream::Clone(nsIInputStream** aResult) {
  nsCOMPtr<nsICloneableInputStream> cloneable = do_QueryInterface(mInner);
  MOZ_ASSERT(cloneable);

  nsCOMPtr<nsIInputStream> innerClone;
  nsresult rv = cloneable->Clone(getter_AddRefs(innerClone));
  if (NS_WARN_IF(NS_FAILED(rv))) {
    return rv;
  }

  RefPtr<SnapshotInputStream> clone =
      new SnapshotInputStream(innerClone, mState, mState->Status());
  clone.forget(aResult);
  return NS_OK;
}

NS_IMETHODIMP SnapshotInputStream::Seek(int32_t aWhence, int64_t aOffset) {
  if (NS_FAILED(mStatus)) {
    return mStatus;
  }
  nsCOMPtr<nsISeekableStream> seekable = do_QueryInterface(mInner);
  return seekable->Seek(aWhence, aOffset);
}

NS_IMETHODIMP SnapshotInputStream::SetEOF() {
  if (NS_FAILED(mStatus)) {
    return mStatus;
  }
  nsCOMPtr<nsISeekableStream> seekable = do_QueryInterface(mInner);
  return seekable->SetEOF();
}

NS_IMETHODIMP SnapshotInputStream::Tell(int64_t* aResult) {
  if (NS_FAILED(mStatus)) {
    return mStatus;
  }
  nsCOMPtr<nsITellableStream> tellable = do_QueryInterface(mInner);
  return tellable->Tell(aResult);
}

SnapshotBlobImpl::SnapshotBlobImpl(nsIFile* aFile, const nsAString& aName,
                                   const nsAString& aContentType,
                                   uint64_t aLength,
                                   int64_t aLastModifiedMilliSeconds,
                                   RefPtr<SnapshotState> aState)
    : FileBlobImpl(aName, aContentType, aLength, aFile,
                   aLastModifiedMilliSeconds),
      mState(std::move(aState)) {
  MOZ_ASSERT(mState);
}

void SnapshotBlobImpl::CreateInputStream(nsIInputStream** aStream,
                                         ErrorResult& aRv) const {
  nsCOMPtr<nsIInputStream> inner;
  FileBlobImpl::CreateInputStream(getter_AddRefs(inner), aRv);
  if (aRv.Failed()) {
    return;
  }

  RefPtr<SnapshotInputStream> stream = new SnapshotInputStream(inner, mState);
  stream.forget(aStream);
}

void SnapshotBlobImpl::GetBlobImplType(nsAString& aBlobImplType) const {
  aBlobImplType = u"SnapshotBlobImpl"_ns;
}

}  // namespace mozilla::dom::fs
