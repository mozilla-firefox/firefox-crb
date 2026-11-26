/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef DOM_FS_PARENT_FILESYSTEMSNAPSHOT_H_
#define DOM_FS_PARENT_FILESYSTEMSNAPSHOT_H_

#include "mozilla/Atomics.h"
#include "mozilla/RefPtr.h"
#include "mozilla/dom/FileBlobImpl.h"
#include "nsCOMPtr.h"
#include "nsICloneableInputStream.h"
#include "nsIInputStream.h"
#include "nsISeekableStream.h"

class nsIFile;

namespace mozilla::dom::fs {

/**
 * The File API snapshot state shared by the Files one getFile() call returned
 * and the slices made from them. It starts out valid and the first
 * modification of the main file turns it into the error that reads started
 * afterwards fail with. Written on the file system IO target, read on the
 * threads that serve blob data.
 */
class SnapshotState final {
 public:
  NS_INLINE_DECL_THREADSAFE_REFCOUNTING(SnapshotState)

  SnapshotState() = default;

  nsresult Status() const { return mStatus; }

  void Invalidate(nsresult aStatus) {
    MOZ_ASSERT(NS_FAILED(aStatus));
    mStatus = aStatus;
  }

  // True once only the registry of the data manager holds a reference.
  bool IsUnused() const { return mRefCnt == 1; }

 private:
  ~SnapshotState() = default;

  Atomic<nsresult> mStatus{NS_OK};
};

/**
 * Stream of a getFile() snapshot over the main file. The snapshot state is
 * checked when the stream is cloned, which is how every read of a blob stored
 * in the parent begins, so a read in progress runs to completion like it would
 * on a file descriptor and the next read fails. Because the file is read in
 * place, a read that began just before a sync access handle writes returns a
 * mix of old and new bytes; this is inherent to reading without a copy and
 * matches other engines, which validate the snapshot only when a read starts.
 * The class deliberately does not implement nsIIPCSerializableInputStream: the
 * data is then piped to the content process instead of handing over a file
 * descriptor that could not be revoked.
 */
class SnapshotInputStream final : public nsIInputStream,
                                  public nsICloneableInputStream,
                                  public nsISeekableStream {
 public:
  NS_DECL_THREADSAFE_ISUPPORTS
  NS_DECL_NSIINPUTSTREAM
  NS_DECL_NSICLONEABLEINPUTSTREAM
  NS_DECL_NSISEEKABLESTREAM
  NS_DECL_NSITELLABLESTREAM

  // aInner must be cloneable and seekable.
  SnapshotInputStream(nsIInputStream* aInner, RefPtr<SnapshotState> aState);

 private:
  SnapshotInputStream(nsIInputStream* aInner, RefPtr<SnapshotState> aState,
                      nsresult aStatus);

  ~SnapshotInputStream() = default;

  const nsCOMPtr<nsIInputStream> mInner;
  const RefPtr<SnapshotState> mState;
  // The snapshot state when this clone was made.
  const nsresult mStatus;
};

class SnapshotBlobImpl final : public FileBlobImpl {
 public:
  SnapshotBlobImpl(nsIFile* aFile, const nsAString& aName,
                   const nsAString& aContentType, uint64_t aLength,
                   int64_t aLastModifiedMilliSeconds,
                   RefPtr<SnapshotState> aState);

  void CreateInputStream(nsIInputStream** aStream,
                         ErrorResult& aRv) const override;

  void GetBlobImplType(nsAString& aBlobImplType) const override;

 private:
  ~SnapshotBlobImpl() override = default;

  const RefPtr<SnapshotState> mState;
};

}  // namespace mozilla::dom::fs

#endif  // DOM_FS_PARENT_FILESYSTEMSNAPSHOT_H_
