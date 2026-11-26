/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "FileSystemWritableFileStreamParent.h"

#include "FileSystemDataManager.h"
#include "FileSystemStreamCallbacks.h"
#include "mozilla/dom/FileSystemLog.h"
#include "mozilla/dom/FileSystemManagerParent.h"
#include "mozilla/dom/quota/RemoteQuotaObjectParent.h"
#include "mozilla/dom/quota/ResultExtensions.h"

namespace mozilla::dom {

class FileSystemWritableFileStreamParent::FileSystemWritableFileStreamCallbacks
    : public FileSystemStreamCallbacks {
 public:
  nsresult FinishUsageAccounting() {
    return mRemoteQuotaObjectParent
               ? mRemoteQuotaObjectParent->FinishUsageAccounting()
               : NS_OK;
  }

  void AbandonUsageAccounting() {
    if (mRemoteQuotaObjectParent) {
      mRemoteQuotaObjectParent->AbandonUsageAccounting();
    }
  }

  void CloseRemoteQuotaObjectParent() {
    if (mRemoteQuotaObjectParent) {
      mRemoteQuotaObjectParent->Close();
    }
  }
};

FileSystemWritableFileStreamParent::FileSystemWritableFileStreamParent(
    RefPtr<FileSystemManagerParent> aManager, const fs::EntryId& aEntryId,
    const fs::FileId& aTemporaryFileId, bool aIsExclusive,
    quota::WriteLease aWriteLease)
    : mManager(std::move(aManager)),
      mEntryId(aEntryId),
      mTemporaryFileId(aTemporaryFileId),
      mWriteLease(std::move(aWriteLease)),
      mIsExclusive(aIsExclusive) {}

FileSystemWritableFileStreamParent::~FileSystemWritableFileStreamParent() {
  MOZ_ASSERT(mClosed);
}

mozilla::ipc::IPCResult FileSystemWritableFileStreamParent::RecvClose(
    bool aAbort, CloseResolver&& aResolver) {
  Close(aAbort);

  aResolver(void_t());

  return IPC_OK();
}

void FileSystemWritableFileStreamParent::ActorDestroy(ActorDestroyReason aWhy) {
  if (mStreamCallbacks) {
    mStreamCallbacks->CloseRemoteQuotaObjectParent();
    mStreamCallbacks = nullptr;
  }

  if (!IsClosed()) {
    Close(/* aAbort */ true);
  }

  mWriteLease = quota::WriteLease();
}

nsIInterfaceRequestor*
FileSystemWritableFileStreamParent::GetOrCreateStreamCallbacks() {
  if (!mStreamCallbacks) {
    if (mClosed) {
      return nullptr;
    }

    mStreamCallbacks = MakeRefPtr<FileSystemWritableFileStreamCallbacks>();
  }

  return mStreamCallbacks.get();
}

void FileSystemWritableFileStreamParent::Close(bool aAbort) {
  LOG(("Closing WritableFileStream"));

  mClosed.Flip();

  // Reconcile even on abort. CanonicalQuotaObject charges OriginInfo for the
  // child's last reported size. UnlockShared records the actual size in Usages
  // through UpdateUsageInDatabase, which does not update the quota object.
  // MergeFileId then subtracts that size via DecreaseUsageForClient.
  // Reconciling with CheckFileAfterClose first makes the amounts agree, so
  // abort removes the temporary file's charge without leaving a size mismatch.
  const nsresult rv =
      mStreamCallbacks ? mStreamCallbacks->FinishUsageAccounting() : NS_OK;
  QM_WARNONLY_TRY(MOZ_TO_RESULT(rv));

  bool discarded = false;
  if (mIsExclusive) {
    mManager->DataManagerStrongRef()->UnlockExclusive(mEntryId);
  } else {
    discarded = mManager->DataManagerStrongRef()->UnlockShared(
        mEntryId, mTemporaryFileId, aAbort);
  }

  if (discarded && mStreamCallbacks) {
    // TODO: Bug 2092188 - If the temporary file was already gone, the quota
    // object still holds the child's last reported size and the abort cleanup
    // subtracted nothing, so the origin stays over-counted until the next
    // rescan. Reconciling the quota object to the tracked usage, without
    // reading the file, would close that gap.
    mStreamCallbacks->AbandonUsageAccounting();
  }

  // Retry failed reconciliation under this lease unless abort discarded usage.
  if (NS_SUCCEEDED(rv) || discarded) {
    mWriteLease = quota::WriteLease();
  }
}

}  // namespace mozilla::dom
