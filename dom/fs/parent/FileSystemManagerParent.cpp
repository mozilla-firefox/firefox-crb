/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "FileSystemManagerParent.h"

#include "FileSystemDatabaseManager.h"
#include "FileSystemEncryptedFileStreams.h"
#include "FileSystemParentTypes.h"
#include "mozilla/Maybe.h"
#include "mozilla/dom/FileBlobImpl.h"
#include "mozilla/dom/FileSystemAccessHandle.h"
#include "mozilla/dom/FileSystemAccessHandleControlParent.h"
#include "mozilla/dom/FileSystemAccessHandleParent.h"
#include "mozilla/dom/FileSystemCipherKeyManager.h"
#include "mozilla/dom/FileSystemDataManager.h"
#include "mozilla/dom/FileSystemLog.h"
#include "mozilla/dom/FileSystemTypes.h"
#include "mozilla/dom/FileSystemWritableFileStreamParent.h"
#include "mozilla/dom/IPCBlobUtils.h"
#include "mozilla/dom/QMResult.h"
#include "mozilla/dom/quota/FileStreams.h"
#include "mozilla/dom/quota/ForwardDecls.h"
#include "mozilla/dom/quota/QuotaCommon.h"
#include "mozilla/dom/quota/QuotaManager.h"
#include "mozilla/dom/quota/ResultExtensions.h"
#include "mozilla/ipc/BackgroundParent.h"
#include "mozilla/ipc/FileDescriptorUtils.h"
#include "mozilla/ipc/RandomAccessStreamUtils.h"
#include "nsNetUtil.h"
#include "nsString.h"
#include "nsTArray.h"

using IPCResult = mozilla::ipc::IPCResult;

namespace mozilla::dom {

FileSystemManagerParent::FileSystemManagerParent(
    RefPtr<fs::data::FileSystemDataManager> aDataManager,
    const EntryId& aRootEntry)
    : mDataManager(std::move(aDataManager)), mRootResponse(aRootEntry) {}

FileSystemManagerParent::~FileSystemManagerParent() {
  LOG(("Destroying FileSystemManagerParent %p", this));
  MOZ_ASSERT(!mRegistered);
}

void FileSystemManagerParent::AssertIsOnIOTarget() const {
  MOZ_ASSERT(mDataManager);

  mDataManager->AssertIsOnIOTarget();
}

bool FileSystemManagerParent::IsAlive() const {
  mozilla::ipc::AssertIsOnBackgroundThread();

  return !!mDataManager;
}

const RefPtr<fs::data::FileSystemDataManager>&
FileSystemManagerParent::DataManagerStrongRef() const {
  MOZ_ASSERT(!mActorDestroyed);
  MOZ_ASSERT(mDataManager);

  return mDataManager;
}

IPCResult FileSystemManagerParent::RecvGetRootHandle(
    GetRootHandleResolver&& aResolver) {
  AssertIsOnIOTarget();

  aResolver(mRootResponse);

  return IPC_OK();
}

void FileSystemManagerParent::WithWriteLease(
    MoveOnlyFunction<void(mozilla::Result<quota::WriteLease, nsresult>)>
        aBody) {
  AssertIsOnIOTarget();
  MOZ_ASSERT(mDataManager);

  quota::QuotaManager* quotaManager = quota::QuotaManager::Get();
  if (!quotaManager) {
    aBody(Err(NS_ERROR_ILLEGAL_DURING_SHUTDOWN));
    return;
  }

  const quota::OriginMetadata& originMetadata =
      mDataManager->OriginMetadataRef();

  if (Maybe<quota::WriteLease> lease =
          quotaManager->TryAcquireWriteLease(originMetadata)) {
    aBody(std::move(*lease));
    return;
  }

  quotaManager->AcquireWriteLease(originMetadata)
      ->Then(GetCurrentSerialEventTarget(), __func__,
             [body = std::move(aBody)](
                 quota::QuotaManager::WriteLeasePromise::ResolveOrRejectValue&&
                     aValue) mutable {
               if (aValue.IsReject()) {
                 body(Err(aValue.RejectValue()));
                 return;
               }

               body(std::move(aValue.ResolveValue()));
             });
}

IPCResult FileSystemManagerParent::RecvGetDirectoryHandle(
    FileSystemGetHandleRequest&& aRequest,
    GetDirectoryHandleResolver&& aResolver) {
  LOG(("GetDirectoryHandle %s ",
       NS_ConvertUTF16toUTF8(aRequest.handle().childName()).get()));
  AssertIsOnIOTarget();
  MOZ_ASSERT(!aRequest.handle().parentId().IsEmpty());
  MOZ_ASSERT(mDataManager);

  auto entryId =
      mDataManager->MutableDatabaseManagerPtr()->GetOrCreateDirectory(
          aRequest.handle(), /* aCreate */ false);
  if (entryId.isOk()) {
    aResolver(FileSystemGetHandleResponse(entryId.unwrap()));
    return IPC_OK();
  }
  if (!aRequest.create() ||
      ToNSResult(entryId.inspectErr()) != NS_ERROR_DOM_NOT_FOUND_ERR) {
    aResolver(FileSystemGetHandleResponse(ToNSResult(entryId.unwrapErr())));
    return IPC_OK();
  }

  auto body =
      [self = RefPtr(this), request = std::move(aRequest),
       resolver = std::move(aResolver)](
          mozilla::Result<quota::WriteLease, nsresult> aWriteLease) mutable {
        if (!self->CanSend()) {
          return;
        }

        // Without the dirty flag recorded on disk nothing may be written.
        if (aWriteLease.isErr()) {
          resolver(FileSystemGetHandleResponse(aWriteLease.unwrapErr()));
          return;
        }

        auto reportError = [&resolver](const QMResult& aRv) {
          FileSystemGetHandleResponse response(ToNSResult(aRv));
          resolver(response);
        };

        QM_TRY_UNWRAP(
            fs::EntryId entryId,
            self->mDataManager->MutableDatabaseManagerPtr()
                ->GetOrCreateDirectory(request.handle(), request.create()),
            QM_VOID, reportError);
        MOZ_ASSERT(!entryId.IsEmpty());

        FileSystemGetHandleResponse response(entryId);
        resolver(response);
      };

  WithWriteLease(std::move(body));

  return IPC_OK();
}

IPCResult FileSystemManagerParent::RecvGetFileHandle(
    FileSystemGetHandleRequest&& aRequest, GetFileHandleResolver&& aResolver) {
  AssertIsOnIOTarget();
  MOZ_ASSERT(!aRequest.handle().parentId().IsEmpty());
  MOZ_ASSERT(mDataManager);

  auto entryId = mDataManager->MutableDatabaseManagerPtr()->GetOrCreateFile(
      aRequest.handle(), /* aCreate */ false);
  if (entryId.isOk()) {
    aResolver(FileSystemGetHandleResponse(entryId.unwrap()));
    return IPC_OK();
  }
  if (!aRequest.create() ||
      ToNSResult(entryId.inspectErr()) != NS_ERROR_DOM_NOT_FOUND_ERR) {
    aResolver(FileSystemGetHandleResponse(ToNSResult(entryId.unwrapErr())));
    return IPC_OK();
  }

  auto body =
      [self = RefPtr(this), request = std::move(aRequest),
       resolver = std::move(aResolver)](
          mozilla::Result<quota::WriteLease, nsresult> aWriteLease) mutable {
        if (!self->CanSend()) {
          return;
        }

        // Without the dirty flag recorded on disk nothing may be written.
        if (aWriteLease.isErr()) {
          resolver(FileSystemGetHandleResponse(aWriteLease.unwrapErr()));
          return;
        }

        auto reportError = [&resolver](const QMResult& aRv) {
          FileSystemGetHandleResponse response(ToNSResult(aRv));
          resolver(response);
        };

        QM_TRY_UNWRAP(
            fs::EntryId entryId,
            self->mDataManager->MutableDatabaseManagerPtr()->GetOrCreateFile(
                request.handle(), request.create()),
            QM_VOID, reportError);
        MOZ_ASSERT(!entryId.IsEmpty());

        FileSystemGetHandleResponse response(entryId);
        resolver(response);
      };

  WithWriteLease(std::move(body));

  return IPC_OK();
}

// Could use a template, but you need several types
mozilla::ipc::IPCResult FileSystemManagerParent::RecvGetAccessHandle(
    FileSystemGetAccessHandleRequest&& aRequest,
    GetAccessHandleResolver&& aResolver) {
  AssertIsOnIOTarget();
  MOZ_ASSERT(mDataManager);

  EntryId entryId = aRequest.entryId();

  FileSystemAccessHandle::Create(mDataManager, entryId)
      ->Then(
          GetCurrentSerialEventTarget(), __func__,
          [self = RefPtr(this), request = std::move(aRequest),
           resolver = std::move(aResolver)](
              FileSystemAccessHandle::CreatePromise::ResolveOrRejectValue&&
                  aValue) {
            if (!self->CanSend()) {
              return;
            }

            if (aValue.IsReject()) {
              resolver(aValue.RejectValue());
              return;
            }

            FileSystemAccessHandle::CreateResult result =
                std::move(aValue.ResolveValue());

            fs::Registered<FileSystemAccessHandle> accessHandle =
                std::move(result.first);

            RandomAccessStreamParams streamParams = std::move(result.second);

            auto accessHandleParent = MakeRefPtr<FileSystemAccessHandleParent>(
                accessHandle.inspect());

            auto resolveAndReturn = [&resolver](nsresult rv) { resolver(rv); };

            ManagedEndpoint<PFileSystemAccessHandleChild>
                accessHandleChildEndpoint =
                    self->OpenPFileSystemAccessHandleEndpoint(
                        accessHandleParent);
            QM_TRY(MOZ_TO_RESULT(accessHandleChildEndpoint.IsValid()),
                   resolveAndReturn);

            accessHandle->RegisterActor(WrapNotNull(accessHandleParent));

            auto accessHandleControlParent =
                MakeRefPtr<FileSystemAccessHandleControlParent>(
                    accessHandle.inspect());

            Endpoint<PFileSystemAccessHandleControlParent>
                accessHandleControlParentEndpoint;
            Endpoint<PFileSystemAccessHandleControlChild>
                accessHandleControlChildEndpoint;
            MOZ_ALWAYS_SUCCEEDS(PFileSystemAccessHandleControl::CreateEndpoints(
                &accessHandleControlParentEndpoint,
                &accessHandleControlChildEndpoint));

            accessHandleControlParentEndpoint.Bind(accessHandleControlParent);

            accessHandle->RegisterControlActor(
                WrapNotNull(accessHandleControlParent));

            resolver(FileSystemAccessHandleProperties(
                std::move(streamParams), std::move(accessHandleChildEndpoint),
                std::move(accessHandleControlChildEndpoint)));
          });

  return IPC_OK();
}

mozilla::ipc::IPCResult FileSystemManagerParent::RecvGetWritable(
    FileSystemGetWritableRequest&& aRequest, GetWritableResolver&& aResolver) {
  AssertIsOnIOTarget();
  MOZ_ASSERT(mDataManager);

  const fs::FileMode mode = mDataManager->GetMode(aRequest.keepData());

  // Locking the entry starts usage tracking, which already writes to the file
  // system database, and the child then writes to the file directly, so the
  // origin must be marked dirty on disk before any of that.
  WithWriteLease(
      [self = RefPtr(this), request = std::move(aRequest),
       resolver = std::move(aResolver),
       mode](mozilla::Result<quota::WriteLease, nsresult> aWriteLease) mutable {
        self->FinishGetWritable(request, resolver, mode,
                                std::move(aWriteLease));
      });

  return IPC_OK();
}

void FileSystemManagerParent::FinishGetWritable(
    const FileSystemGetWritableRequest& aRequest,
    GetWritableResolver& aResolver, fs::FileMode aMode,
    mozilla::Result<quota::WriteLease, nsresult> aWriteLease) {
  if (!CanSend()) {
    return;
  }

  AssertIsOnIOTarget();
  MOZ_ASSERT(mDataManager);

  // Without the dirty flag recorded on disk nothing may be written.
  if (aWriteLease.isErr()) {
    aResolver(aWriteLease.unwrapErr());
    return;
  }

  auto reportError = [&aResolver](const auto& aRv) {
    aResolver(ToNSResult(aRv));
  };

  // TODO: Get rid of mode and switching based on it, have the right unlocking
  // automatically
  const fs::EntryId& entryId = aRequest.entryId();
  QM_TRY_UNWRAP(
      fs::FileId fileId,
      (aMode == fs::FileMode::EXCLUSIVE ? mDataManager->LockExclusive(entryId)
                                        : mDataManager->LockShared(entryId)),
      QM_VOID, reportError);
  MOZ_ASSERT(!fileId.IsEmpty());

  auto autoUnlock = MakeScopeExit(
      [self = RefPtr<FileSystemManagerParent>(this), &entryId, &fileId, aMode] {
        if (aMode == fs::FileMode::EXCLUSIVE) {
          self->mDataManager->UnlockExclusive(entryId);
        } else {
          self->mDataManager->UnlockShared(entryId, fileId, /* aAbort */ true);
        }
      });

  fs::ContentType type;
  fs::TimeStamp lastModifiedMilliSeconds;
  fs::Path path;
  nsCOMPtr<nsIFile> file;
  QM_TRY(
      MOZ_TO_RESULT(mDataManager->MutableDatabaseManagerPtr()->GetFile(
          entryId, fileId, aMode, type, lastModifiedMilliSeconds, path, file)),
      QM_VOID, reportError);

  if (LOG_ENABLED()) {
    nsAutoString path;
    if (NS_SUCCEEDED(file->GetPath(path))) {
      LOG(("Opening Writable %s", NS_ConvertUTF16toUTF8(path).get()));
    }
  }

  const auto& originMetadata = mDataManager->OriginMetadataRef();

  const RefPtr<fs::FileSystemCipherKeyManager> cipherKeyManager =
      mDataManager->MaybeCipherKeyManager();
  MOZ_ASSERT(!originMetadata.mIsPrivate || cipherKeyManager);

  QM_TRY_UNWRAP(nsCOMPtr<nsIRandomAccessStream> stream,
                originMetadata.mIsPrivate
                    ? fs::CreateEncryptedFileRandomAccessStream(
                          originMetadata, *cipherKeyManager, fileId, file)
                    : CreateFileRandomAccessStream(
                          originMetadata.mPersistenceType, originMetadata,
                          quota::Client::FILESYSTEM, file, -1, -1,
                          nsIFileRandomAccessStream::DEFER_OPEN),
                QM_VOID, reportError);

  auto writableFileStreamParent =
      MakeNotNull<RefPtr<FileSystemWritableFileStreamParent>>(
          this, entryId, fileId, aMode == fs::FileMode::EXCLUSIVE,
          aWriteLease.unwrap());

  RandomAccessStreamParams streamParams =
      mozilla::ipc::SerializeRandomAccessStream(
          WrapMovingNotNullUnchecked(std::move(stream)),
          writableFileStreamParent->GetOrCreateStreamCallbacks());

  // Release the auto unlock helper just before calling
  // SendPFileSystemWritableFileStreamConstructor which is responsible for
  // destroying the actor if the sending fails (we call `UnlockExclusive` when
  // the actor is destroyed).
  autoUnlock.release();

  if (!SendPFileSystemWritableFileStreamConstructor(writableFileStreamParent)) {
    aResolver(NS_ERROR_FAILURE);
    return;
  }

  aResolver(FileSystemWritableFileStreamProperties(std::move(streamParams),
                                                   writableFileStreamParent));
}

IPCResult FileSystemManagerParent::RecvGetFile(
    FileSystemGetFileRequest&& aRequest, GetFileResolver&& aResolver) {
  AssertIsOnIOTarget();
  MOZ_ASSERT(mDataManager);

  // TODO: The implementation should support PBM.
  if (mDataManager->OriginMetadataRef().mIsPrivate) {
    aResolver(NS_ERROR_DOM_NOT_SUPPORTED_ERR);
    return IPC_OK();
  }

  // XXX Spec https://www.w3.org/TR/FileAPI/#dfn-file wants us to snapshot the
  // state of the file at getFile() time

  // You can create a File with getFile() even if the file is locked
  // XXX factor out this part of the code for accesshandle/ and getfile

  QM_TRY_UNWRAP(auto properties,
                GetFileProperties(aRequest.entryId(), /* aCreate */ false),
                IPC_OK(),
                [&aResolver](const auto& aRv) { aResolver(ToNSResult(aRv)); });
  if (properties) {
    aResolver(std::move(*properties));
    return IPC_OK();
  }

  // The entry exists, but its file id or backing file needs to be created.
  WithWriteLease(
      [self = RefPtr(this), request = std::move(aRequest),
       resolver = std::move(aResolver)](
          mozilla::Result<quota::WriteLease, nsresult> aWriteLease) mutable {
        if (!self->CanSend()) {
          return;
        }

        // Without the dirty flag recorded on disk nothing may be written.
        if (aWriteLease.isErr()) {
          resolver(aWriteLease.unwrapErr());
          return;
        }

        auto reportError = [&resolver](const auto& rv) {
          LOG(("getFile() Failed!"));
          resolver(ToNSResult(rv));
        };

        QM_TRY_UNWRAP(
            auto properties,
            self->GetFileProperties(request.entryId(), /* aCreate */ true),
            QM_VOID, reportError);
        MOZ_ASSERT(properties);
        resolver(std::move(*properties));
      });

  return IPC_OK();
}

Result<Maybe<fs::FileSystemFileProperties>, nsresult>
FileSystemManagerParent::GetFileProperties(const fs::EntryId& aEntryId,
                                           bool aCreate) {
  AssertIsOnIOTarget();

  auto* databaseManager = mDataManager->MutableDatabaseManagerPtr();
  auto fileId = aCreate ? databaseManager->EnsureFileId(aEntryId)
                        : databaseManager->GetFileId(aEntryId);
  if (fileId.isErr()) {
    const nsresult rv = ToNSResult(fileId.unwrapErr());
    if (aCreate || rv != NS_ERROR_DOM_NOT_FOUND_ERR) {
      return Err(rv);
    }

    QM_TRY_UNWRAP(const bool exists,
                  databaseManager->DoesFileExist(aEntryId).mapErr(
                      [](const auto& aRv) { return ToNSResult(aRv); }));
    if (!exists) {
      return Err(NS_ERROR_DOM_NOT_FOUND_ERR);
    }
    return Maybe<FileSystemFileProperties>();
  }

  fs::ContentType type;
  fs::TimeStamp lastModifiedMilliSeconds;
  fs::Path path;
  nsCOMPtr<nsIFile> fileObject;
  const nsresult rv = databaseManager->GetFile(
      aEntryId, fileId.unwrap(), fs::FileMode::EXCLUSIVE, type,
      lastModifiedMilliSeconds, path, fileObject, aCreate);
  if (!aCreate && rv == NS_ERROR_FILE_NOT_FOUND) {
    return Maybe<FileSystemFileProperties>();
  }
  QM_TRY(MOZ_TO_RESULT(rv));

  if (LOG_ENABLED()) {
    nsAutoString path;
    if (NS_SUCCEEDED(fileObject->GetPath(path))) {
      LOG(("Opening File as blob: %s", NS_ConvertUTF16toUTF8(path).get()));
    }
  }

  // TODO: Currently, there is no way to assign type and it is empty.
  // See bug 1826780.
  RefPtr<BlobImpl> blob = MakeRefPtr<FileBlobImpl>(
      fileObject, path.LastElement(), NS_ConvertUTF8toUTF16(type));

  IPCBlob ipcBlob;
  QM_TRY(MOZ_TO_RESULT(IPCBlobUtils::Serialize(blob, ipcBlob)));

  return Some(
      FileSystemFileProperties(lastModifiedMilliSeconds, ipcBlob, type, path));
}

IPCResult FileSystemManagerParent::RecvResolve(
    FileSystemResolveRequest&& aRequest, ResolveResolver&& aResolver) {
  AssertIsOnIOTarget();
  MOZ_ASSERT(!aRequest.endpoints().parentId().IsEmpty());
  MOZ_ASSERT(!aRequest.endpoints().childId().IsEmpty());
  MOZ_ASSERT(mDataManager);

  fs::Path filePath;
  if (aRequest.endpoints().parentId() == aRequest.endpoints().childId()) {
    FileSystemResolveResponse response(Some(FileSystemPath(filePath)));
    aResolver(response);

    return IPC_OK();
  }

  auto reportError = [&aResolver](const QMResult& aRv) {
    FileSystemResolveResponse response(ToNSResult(aRv));
    aResolver(response);
  };

  QM_TRY_UNWRAP(
      filePath,
      mDataManager->MutableDatabaseManagerPtr()->Resolve(aRequest.endpoints()),
      IPC_OK(), reportError);

  if (LOG_ENABLED()) {
    nsString path;
    for (auto& entry : filePath) {
      path.Append(entry);
    }
    LOG(("Resolve path: %s", NS_ConvertUTF16toUTF8(path).get()));
  }

  if (filePath.IsEmpty()) {
    FileSystemResolveResponse response(Nothing{});
    aResolver(response);

    return IPC_OK();
  }

  FileSystemResolveResponse response(Some(FileSystemPath(filePath)));
  aResolver(response);

  return IPC_OK();
}

IPCResult FileSystemManagerParent::RecvGetEntries(
    FileSystemGetEntriesRequest&& aRequest, GetEntriesResolver&& aResolver) {
  AssertIsOnIOTarget();
  MOZ_ASSERT(!aRequest.parentId().IsEmpty());
  MOZ_ASSERT(mDataManager);

  auto reportError = [&aResolver](const QMResult& aRv) {
    FileSystemGetEntriesResponse response(ToNSResult(aRv));
    aResolver(response);
  };

  QM_TRY_UNWRAP(FileSystemDirectoryListing entries,
                mDataManager->MutableDatabaseManagerPtr()->GetDirectoryEntries(
                    aRequest.parentId(), aRequest.page()),
                IPC_OK(), reportError);

  FileSystemGetEntriesResponse response(entries);
  aResolver(response);

  return IPC_OK();
}

IPCResult FileSystemManagerParent::RecvRemoveEntry(
    FileSystemRemoveEntryRequest&& aRequest, RemoveEntryResolver&& aResolver) {
  LOG(("RemoveEntry %s",
       NS_ConvertUTF16toUTF8(aRequest.handle().childName()).get()));
  AssertIsOnIOTarget();
  MOZ_ASSERT(!aRequest.handle().parentId().IsEmpty());
  MOZ_ASSERT(mDataManager);

  WithWriteLease(
      [self = RefPtr(this), request = std::move(aRequest),
       resolver = std::move(aResolver)](
          mozilla::Result<quota::WriteLease, nsresult> aWriteLease) mutable {
        if (!self->CanSend()) {
          return;
        }

        // Without the dirty flag recorded on disk nothing may be written.
        if (aWriteLease.isErr()) {
          resolver(FileSystemRemoveEntryResponse(aWriteLease.unwrapErr()));
          return;
        }

        auto reportError = [&resolver](const QMResult& aRv) {
          FileSystemRemoveEntryResponse response(ToNSResult(aRv));
          resolver(response);
        };

        QM_TRY_UNWRAP(
            bool isDeleted,
            self->mDataManager->MutableDatabaseManagerPtr()->RemoveFile(
                request.handle()),
            QM_VOID, reportError);

        if (isDeleted) {
          FileSystemRemoveEntryResponse response(void_t{});
          resolver(response);

          return;
        }

        QM_TRY_UNWRAP(
            isDeleted,
            self->mDataManager->MutableDatabaseManagerPtr()->RemoveDirectory(
                request.handle(), request.recursive()),
            QM_VOID, reportError);

        if (!isDeleted) {
          FileSystemRemoveEntryResponse response(NS_ERROR_DOM_NOT_FOUND_ERR);
          resolver(response);

          return;
        }

        FileSystemRemoveEntryResponse response(void_t{});
        resolver(response);
      });

  return IPC_OK();
}

IPCResult FileSystemManagerParent::RecvMoveEntry(
    FileSystemMoveEntryRequest&& aRequest, MoveEntryResolver&& aResolver) {
  LOG(("MoveEntry %s to %s",
       NS_ConvertUTF16toUTF8(aRequest.handle().entryName()).get(),
       NS_ConvertUTF16toUTF8(aRequest.destHandle().childName()).get()));
  MOZ_ASSERT(!aRequest.handle().entryId().IsEmpty());
  MOZ_ASSERT(!aRequest.destHandle().parentId().IsEmpty());
  MOZ_ASSERT(mDataManager);

  WithWriteLease(
      [self = RefPtr(this), request = std::move(aRequest),
       resolver = std::move(aResolver)](
          mozilla::Result<quota::WriteLease, nsresult> aWriteLease) mutable {
        if (!self->CanSend()) {
          return;
        }

        // Without the dirty flag recorded on disk nothing may be written.
        if (aWriteLease.isErr()) {
          resolver(FileSystemMoveEntryResponse(aWriteLease.unwrapErr()));
          return;
        }

        auto reportError = [&resolver](const QMResult& aRv) {
          FileSystemMoveEntryResponse response(ToNSResult(aRv));
          resolver(response);
        };

        QM_TRY_INSPECT(
            const EntryId& newId,
            self->mDataManager->MutableDatabaseManagerPtr()->MoveEntry(
                request.handle(), request.destHandle()),
            QM_VOID, reportError);

        fs::FileSystemMoveEntryResponse response(newId);
        resolver(response);
      });

  return IPC_OK();
}

IPCResult FileSystemManagerParent::RecvRenameEntry(
    FileSystemRenameEntryRequest&& aRequest, MoveEntryResolver&& aResolver) {
  // if destHandle's parentId is empty, then we're renaming in the same
  // directory
  LOG(("RenameEntry %s to %s",
       NS_ConvertUTF16toUTF8(aRequest.handle().entryName()).get(),
       NS_ConvertUTF16toUTF8(aRequest.name()).get()));
  MOZ_ASSERT(!aRequest.handle().entryId().IsEmpty());
  MOZ_ASSERT(mDataManager);

  WithWriteLease(
      [self = RefPtr(this), request = std::move(aRequest),
       resolver = std::move(aResolver)](
          mozilla::Result<quota::WriteLease, nsresult> aWriteLease) mutable {
        if (!self->CanSend()) {
          return;
        }

        // Without the dirty flag recorded on disk nothing may be written.
        if (aWriteLease.isErr()) {
          resolver(FileSystemMoveEntryResponse(aWriteLease.unwrapErr()));
          return;
        }

        auto reportError = [&resolver](const QMResult& aRv) {
          FileSystemMoveEntryResponse response(ToNSResult(aRv));
          resolver(response);
        };

        QM_TRY_INSPECT(
            const EntryId& newId,
            self->mDataManager->MutableDatabaseManagerPtr()->RenameEntry(
                request.handle(), request.name()),
            QM_VOID, reportError);

        fs::FileSystemMoveEntryResponse response(newId);
        resolver(response);
      });

  return IPC_OK();
}

void FileSystemManagerParent::RequestAllowToClose() {
  ::mozilla::ipc::AssertIsOnBackgroundThread();

  if (mRequestedAllowToClose) {
    return;
  }

  mRequestedAllowToClose.Flip();

  InvokeAsync(mDataManager->MutableIOTaskQueuePtr(), __func__,
              [self = RefPtr<FileSystemManagerParent>(this)]() {
                return self->SendCloseAll();
              })
      ->Then(mDataManager->MutableIOTaskQueuePtr(), __func__,
             [self = RefPtr<FileSystemManagerParent>(this)](
                 const CloseAllPromise::ResolveOrRejectValue& aValue) {
               self->Close();

               return BoolPromise::CreateAndResolve(true, __func__);
             });
}

void FileSystemManagerParent::ActorDestroy(ActorDestroyReason aWhy) {
  AssertIsOnIOTarget();
  MOZ_ASSERT(!mActorDestroyed);

  DEBUGONLY(mActorDestroyed = true);

  InvokeAsync(mDataManager->MutableBackgroundTargetPtr(), __func__,
              [self = RefPtr<FileSystemManagerParent>(this)]() {
                if (self->mRegistered) {
                  self->mDataManager->UnregisterActor(WrapNotNull(self));
                }

                self->mDataManager = nullptr;

                return BoolPromise::CreateAndResolve(true, __func__);
              });
}

}  // namespace mozilla::dom
