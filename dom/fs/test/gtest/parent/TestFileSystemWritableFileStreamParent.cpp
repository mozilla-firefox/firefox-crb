/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "CanonicalQuotaObject.h"
#include "FileSystemManagerParent.h"
#include "FileSystemParentTestHelpers.h"
#include "FileSystemWritableFileStreamParent.h"
#include "OriginInfo.h"
#include "TestHelpers.h"
#include "datamodel/FileSystemDatabaseManager.h"
#include "mozilla/ScopeExit.h"
#include "mozilla/dom/FileSystemDataManager.h"
#include "mozilla/dom/FileSystemParentTypes.h"
#include "mozilla/dom/quota/QuotaManagerImpl.h"
#include "mozilla/dom/quota/QuotaObject.h"
#include "mozilla/dom/quota/RemoteQuotaObjectParent.h"
#include "mozilla/dom/quota/RemoteQuotaObjectParentTracker.h"
#include "mozilla/dom/quota/test/QuotaManagerDependencyFixture.h"
#include "nsIFile.h"
#include "nsIInterfaceRequestor.h"
#include "nsIInterfaceRequestorUtils.h"

namespace mozilla::dom::fs::test {

class TestFileSystemWritableFileStreamParent
    : public quota::test::QuotaManagerDependencyFixture {
 public:
  static void SetUpTestCase() { ASSERT_NO_FATAL_FAILURE(InitializeFixture()); }
  static void TearDownTestCase() { ASSERT_NO_FATAL_FAILURE(ShutdownFixture()); }

  void TearDown() override {
    ASSERT_NO_FATAL_FAILURE(ClearStoragesForOrigin(GetTestOriginMetadata()));
  }

 protected:
  struct Stream {
    RefPtr<FileSystemWritableFileStreamParent> mWritable;
    RefPtr<quota::RemoteQuotaObjectParent> mRemote;
    RefPtr<quota::QuotaObject> mQuotaObject;
    nsCOMPtr<nsIFile> mFile;
    data::FileSystemDataManager* mDataManager;
    EntryId mEntryId;
    FileId mFileId;

    void Close(bool aAbort = false) {
      bool resolved = false;
      EXPECT_TRUE(mWritable->RecvClose(
          aAbort, [&resolved](const auto&) { resolved = true; }));
      EXPECT_TRUE(resolved);
    }

    void Destroy() {
      if (mWritable) {
        mWritable->ActorDestroy(ipc::IProtocol::AbnormalShutdown);
        mWritable = nullptr;
      }
    }

    void ExpectUpdate(int64_t aSize, bool aExpected) {
      bool allowed = !aExpected;
      EXPECT_TRUE(mRemote->RecvMaybeUpdateSize(aSize, true, &allowed));
      EXPECT_EQ(allowed, aExpected);
    }
  };

  static bool HasLease() {
    return quota::QuotaManager::Get()->WithOriginInfo(
        GetTestOriginMetadata(),
        [](const auto& info) { return info->LockedHasWriteLease(); });
  }

  static int64_t Usage() {
    return quota::QuotaManager::Get()->WithOriginInfo(
        GetTestOriginMetadata(),
        [](const auto& info) { return info->LockedUsage(); });
  }

  template <typename Test>
  void WithStream(Test&& aTest) {
    Registered<data::FileSystemDataManager> dataManager;
    PerformOnBackgroundThread([&] {
      ASSERT_NO_FATAL_FAILURE(
          CreateRegisteredDataManager(GetTestOriginMetadata(), dataManager));
    });
    ASSERT_TRUE(dataManager);
    auto releaseManager = MakeScopeExit([&] {
      PerformOnBackgroundThread([&] {
        RefPtr<data::FileSystemDataManager> manager = dataManager.get();
        dataManager = nullptr;
        EXPECT_TRUE(Await(manager->OnClose()).IsResolve());
      });
    });

    auto lease = PerformOnBackgroundThread([] {
      return Await(quota::QuotaManager::Get()->AcquireWriteLease(
          GetTestOriginMetadata()));
    });
    ASSERT_TRUE(lease.IsResolve());

    PerformOnThread(dataManager->MutableIOTaskQueuePtr(), [&] {
      auto* database = dataManager->MutableDatabaseManagerPtr();
      TEST_TRY_UNWRAP(const EntryId root,
                      data::GetRootHandle(GetTestOriginMetadata().mOrigin));
      TEST_TRY_UNWRAP(const EntryId entry, database->GetOrCreateFile(
                                               {root, u"accounting"_ns}, true));
      TEST_TRY_UNWRAP(const FileId fileId, dataManager->LockShared(entry));
      auto unlock = MakeScopeExit(
          [&] { dataManager->UnlockShared(entry, fileId, true); });

      ContentType type;
      fs::TimeStamp modified;
      Path path;
      nsCOMPtr<nsIFile> file;
      ASSERT_NSEQ(NS_OK,
                  database->GetFile(entry, fileId, FileMode::SHARED_FROM_EMPTY,
                                    type, modified, path, file));

      auto manager =
          MakeRefPtr<FileSystemManagerParent>(dataManager.get(), root);
      Stream stream{
          MakeRefPtr<FileSystemWritableFileStreamParent>(
              manager, entry, fileId, false, std::move(lease.ResolveValue())),
          nullptr,
          nullptr,
          file,
          dataManager.get(),
          entry,
          fileId};
      unlock.release();
      auto destroy = MakeScopeExit([&] { stream.Destroy(); });

      const auto metadata = GetTestOriginMetadata();
      stream.mQuotaObject = quota::QuotaManager::Get()->GetQuotaObject(
          metadata.mPersistenceType, metadata, quota::Client::FILESYSTEM, file);
      ASSERT_TRUE(stream.mQuotaObject);

      nsCOMPtr<quota::RemoteQuotaObjectParentTracker> tracker =
          do_GetInterface(stream.mWritable->GetOrCreateStreamCallbacks());
      ASSERT_TRUE(tracker);
      stream.mRemote = MakeRefPtr<quota::RemoteQuotaObjectParent>(
          stream.mQuotaObject->AsCanonicalQuotaObject(), tracker);

      ipc::Endpoint<quota::PRemoteQuotaObjectParent> parentEndpoint;
      ipc::Endpoint<quota::PRemoteQuotaObjectChild> childEndpoint;
      ASSERT_NSEQ(NS_OK, quota::PRemoteQuotaObject::CreateEndpoints(
                             &parentEndpoint, &childEndpoint));
      ASSERT_TRUE(parentEndpoint.Bind(stream.mRemote));
      tracker->RegisterRemoteQuotaObjectParent(WrapNotNull(stream.mRemote));

      aTest(stream);
      stream.Destroy();
      EXPECT_FALSE(HasLease());
    });
  }
};

TEST_F(TestFileSystemWritableFileStreamParent,
       ReconcilesAndRejectsLateUpdates) {
  WithStream([](Stream& aStream) {
    const auto initial = Usage();
    aStream.ExpectUpdate(100, true);
    ASSERT_NSEQ(NS_OK, aStream.mFile->SetFileSize(80));
    EXPECT_EQ(Usage(), initial + 100);

    EXPECT_EQ(aStream.mRemote->FinishUsageAccounting(), NS_OK);
    EXPECT_EQ(Usage(), initial + 80);
    EXPECT_TRUE(HasLease());
    aStream.ExpectUpdate(200, false);
    EXPECT_EQ(Usage(), initial + 80);

    // A second completion or actor destruction must not reconcile again.
    ASSERT_NSEQ(NS_OK, aStream.mFile->SetFileSize(40));
    EXPECT_EQ(aStream.mRemote->FinishUsageAccounting(), NS_OK);
    EXPECT_EQ(Usage(), initial + 80);
    aStream.Close();
    EXPECT_FALSE(HasLease());
    EXPECT_TRUE(aStream.mRemote->CanSend());
    const auto afterClose = Usage();
    aStream.ExpectUpdate(200, false);
    aStream.Destroy();
    EXPECT_FALSE(aStream.mRemote->CanSend());
    EXPECT_EQ(Usage(), afterClose);
  });
}

TEST_F(TestFileSystemWritableFileStreamParent, CloseFinishesAccounting) {
  WithStream([](Stream& aStream) {
    const auto initial = Usage();
    aStream.ExpectUpdate(100, true);
    ASSERT_NSEQ(NS_OK, aStream.mFile->SetFileSize(80));
    aStream.Close();
    EXPECT_EQ(Usage(), initial + 80);
    EXPECT_FALSE(HasLease());
    EXPECT_TRUE(aStream.mRemote->CanSend());
    const auto usage = Usage();
    aStream.ExpectUpdate(200, false);
    EXPECT_EQ(Usage(), usage);

    auto result = aStream.mDataManager->IsLocked(aStream.mEntryId);
    ASSERT_TRUE(result.isOk());
    EXPECT_FALSE(result.unwrap());
  });
}

TEST_F(TestFileSystemWritableFileStreamParent,
       FailedCheckRetainsLeaseUntilDestroy) {
  WithStream([](Stream& aStream) {
    aStream.ExpectUpdate(100, true);
    ASSERT_NSEQ(NS_OK, aStream.mFile->Remove(false));
    aStream.Close();
    EXPECT_TRUE(HasLease());
    const auto afterClose = Usage();
    aStream.ExpectUpdate(200, false);
    EXPECT_EQ(Usage(), afterClose);

    ASSERT_NSEQ(NS_OK, aStream.mFile->Create(nsIFile::NORMAL_FILE_TYPE, 0600));
    ASSERT_NSEQ(NS_OK, aStream.mFile->SetFileSize(80));
    aStream.Destroy();
    EXPECT_FALSE(HasLease());
    EXPECT_EQ(Usage(), afterClose - 20);
  });
}

TEST_F(TestFileSystemWritableFileStreamParent,
       AbortAfterFailedCheckReleasesLease) {
  for (const bool explicitAbort : {false, true}) {
    WithStream([&](Stream& aStream) {
      ASSERT_NSEQ(NS_OK, aStream.mFile->Remove(false));
      EXPECT_EQ(aStream.mRemote->FinishUsageAccounting(),
                NS_ERROR_FILE_NOT_FOUND);
      EXPECT_TRUE(HasLease());

      if (!explicitAbort) {
        aStream.mDataManager->DeprecateSharedLocks(aStream.mEntryId,
                                                   aStream.mFileId);
        TEST_TRY_UNWRAP(const EntryId root,
                        data::GetRootHandle(GetTestOriginMetadata().mOrigin));
        TEST_TRY_UNWRAP(
            const bool removed,
            aStream.mDataManager->MutableDatabaseManagerPtr()->RemoveFile(
                {root, u"accounting"_ns}));
        ASSERT_TRUE(removed);
      }

      aStream.Close(explicitAbort);
      EXPECT_FALSE(HasLease());
      EXPECT_TRUE(aStream.mRemote->CanSend());
      const auto afterClose = Usage();
      aStream.ExpectUpdate(200, false);
      EXPECT_EQ(Usage(), afterClose);

      // Recreating the path must not cause a retry after the lease is released.
      ASSERT_NSEQ(NS_OK,
                  aStream.mFile->Create(nsIFile::NORMAL_FILE_TYPE, 0600));
      ASSERT_NSEQ(NS_OK, aStream.mFile->SetFileSize(80));
      aStream.Destroy();
      EXPECT_FALSE(aStream.mRemote->CanSend());
      EXPECT_FALSE(HasLease());
      EXPECT_EQ(Usage(), afterClose);
      ASSERT_NSEQ(NS_OK, aStream.mFile->Remove(false));
    });
  }
}

TEST_F(TestFileSystemWritableFileStreamParent,
       QuotaDenialIsNotSuccessfulCompletion) {
  WithStream([](Stream& aStream) {
    const auto initial = Usage();
    ASSERT_TRUE(aStream.mQuotaObject->MaybeSetReservation(
        quota::QuotaManager::Get()->GetGroupLimit() - initial));
    auto unreserve = MakeScopeExit(
        [&] { EXPECT_TRUE(aStream.mQuotaObject->MaybeSetReservation(0)); });
    ASSERT_NSEQ(NS_OK, aStream.mFile->SetFileSize(80));
    EXPECT_EQ(aStream.mRemote->FinishUsageAccounting(),
              NS_ERROR_FILE_NO_DEVICE_SPACE);
    EXPECT_EQ(Usage(), initial);
    aStream.ExpectUpdate(10, false);

    ASSERT_TRUE(aStream.mQuotaObject->MaybeSetReservation(0));
    EXPECT_EQ(aStream.mRemote->FinishUsageAccounting(), NS_OK);
    EXPECT_EQ(Usage(), initial + 80);
    aStream.Close();
    EXPECT_FALSE(HasLease());
  });
}

TEST_F(TestFileSystemWritableFileStreamParent,
       ActorDestructionAbortsOpenStream) {
  WithStream([](Stream& aStream) {
    aStream.ExpectUpdate(100, true);
    ASSERT_NSEQ(NS_OK, aStream.mFile->SetFileSize(80));
    EXPECT_TRUE(HasLease());
    aStream.Destroy();
    EXPECT_FALSE(HasLease());
    EXPECT_FALSE(aStream.mRemote->CanSend());
    bool exists = true;
    EXPECT_EQ(aStream.mFile->Exists(&exists), NS_OK);
    EXPECT_FALSE(exists);
    auto locked = aStream.mDataManager->IsLocked(aStream.mEntryId);
    ASSERT_TRUE(locked.isOk());
    EXPECT_FALSE(locked.unwrap());
  });
}

}  // namespace mozilla::dom::fs::test
