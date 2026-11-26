/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "FileSystemManagerParent.h"
#include "FileSystemParentTestHelpers.h"
#include "FileSystemWritableFileStreamParent.h"
#include "OriginInfo.h"
#include "TestHelpers.h"
#include "datamodel/FileSystemDatabaseManager.h"
#include "mozilla/Monitor.h"
#include "mozilla/Preferences.h"
#include "mozilla/dom/FileSystemAccessHandle.h"
#include "mozilla/dom/FileSystemDataManager.h"
#include "mozilla/dom/quota/QuotaManagerImpl.h"
#include "mozilla/dom/quota/test/QuotaManagerDependencyFixture.h"
#include "nsIQuotaArtificialFailure.h"

namespace mozilla::dom::fs::test {

class TestFileSystemWriteLeaseOrdering
    : public quota::test::QuotaManagerDependencyFixture {
 public:
  static void SetUpTestCase() { ASSERT_NO_FATAL_FAILURE(InitializeFixture()); }
  static void TearDownTestCase() { ASSERT_NO_FATAL_FAILURE(ShutdownFixture()); }

  void SetUp() override {
    Preferences::SetUint("dom.quotaManager.originWriteQuiescentThresholdMs",
                         100);
    PerformOnBackgroundThread([&] {
      ASSERT_NO_FATAL_FAILURE(
          CreateRegisteredDataManager(GetTestOriginMetadata(), mRegistration));
      mDataManager = mRegistration.get();
    });
    ASSERT_TRUE(mDataManager);
    PerformOnThread(mDataManager->MutableIOTaskQueuePtr(), [&] {
      TEST_TRY_UNWRAP(mRoot,
                      data::GetRootHandle(GetTestOriginMetadata().mOrigin));
      mActor = MakeRefPtr<FileSystemManagerParent>(mDataManager, mRoot);
      ipc::Endpoint<PFileSystemManagerParent> parent;
      ASSERT_NSEQ(NS_OK, PFileSystemManager::CreateEndpoints(&parent, &mChild));
      ASSERT_TRUE(parent.Bind(mActor));
    });
  }

  void TearDown() override {
    SetFailure(0);
    if (mDataManager) {
      PerformOnThread(mDataManager->MutableIOTaskQueuePtr(), [&] {
        if (mActor && mActor->CanSend()) {
          mActor->Close();
        }
        mActor = nullptr;
        mChild = {};
      });
      PerformOnBackgroundThread([&] {
        if (mRegistration) {
          mRegistration = nullptr;
          EXPECT_TRUE(Await(mDataManager->OnClose()).IsResolve());
        }
        mDataManager = nullptr;
      });
    }
    Preferences::ClearUser("dom.quotaManager.originWriteQuiescentThresholdMs");
    ASSERT_NO_FATAL_FAILURE(ClearStoragesForOrigin(GetTestOriginMetadata()));
  }

 protected:
  static void SetFailure(uint32_t aCategory) {
    Preferences::SetUint("dom.quotaManager.artificialFailure.categories",
                         aCategory);
    Preferences::SetUint("dom.quotaManager.artificialFailure.probability", 100);
    Preferences::SetUint("dom.quotaManager.artificialFailure.errorCode",
                         static_cast<uint32_t>(NS_ERROR_FILE_ACCESS_DENIED));
    if (!aCategory) {
      Preferences::ClearUser("dom.quotaManager.artificialFailure.categories");
      Preferences::ClearUser("dom.quotaManager.artificialFailure.probability");
      Preferences::ClearUser("dom.quotaManager.artificialFailure.errorCode");
    }
  }

  static bool HasLease() {
    return quota::QuotaManager::Get()->WithOriginInfo(
        GetTestOriginMetadata(),
        [](const auto& info) { return info->LockedHasWriteLease(); });
  }

  void Settle() {
    ASSERT_NO_FATAL_FAILURE(WaitForCondition([] {
      PerformOnBackgroundThread([] {
        ASSERT_TRUE(
            Await(quota::QuotaManager::Get()->FlushDirtyOriginInfosForTesting())
                .IsResolve());
      });
      return !HasLease() && !quota::QuotaManager::Get()->WithOriginInfo(
                                GetTestOriginMetadata(), [](const auto& info) {
                                  return info->LockedDirtyOnDisk();
                                });
    }));
  }

  template <typename Response>
  static void CheckResponse(const Response& aResponse, nsresult aExpected) {
    EXPECT_EQ(aResponse.type() == Response::Tnsresult ? aResponse.get_nsresult()
                                                      : NS_OK,
              aExpected);
  }

  RefPtr<BoolPromise> GetHandle(const Name& aName, bool aCreate,
                                bool aDirectory = false,
                                nsresult aExpected = NS_OK) {
    auto done = MakeRefPtr<BoolPromise::Private>(__func__);
    auto resolver = [done,
                     aExpected](const FileSystemGetHandleResponse& response) {
      CheckResponse(response, aExpected);
      done->Resolve(true, __func__);
    };
    FileSystemGetHandleRequest request({mRoot, aName}, aCreate);
    if (aDirectory) {
      EXPECT_TRUE(mActor->RecvGetDirectoryHandle(std::move(request),
                                                 std::move(resolver)));
    } else {
      EXPECT_TRUE(
          mActor->RecvGetFileHandle(std::move(request), std::move(resolver)));
    }
    return done;
  }

  void ExpectEntry(const Name& aName, bool aExists, bool aDirectory = false,
                   const EntryId& aParent = {}) {
    auto* database = mDataManager->MutableDatabaseManagerPtr();
    FileSystemChildMetadata child(aParent.IsEmpty() ? mRoot : aParent, aName);
    auto result = aDirectory ? database->GetOrCreateDirectory(child, false)
                             : database->GetOrCreateFile(child, false);
    if (aExists) {
      EXPECT_TRUE(result.isOk());
    } else {
      ASSERT_TRUE(result.isErr());
      EXPECT_EQ(ToNSResult(result.unwrapErr()), NS_ERROR_DOM_NOT_FOUND_ERR);
    }
  }

  template <typename Request, typename Observe, typename BeforeRelease>
  void RunGated(Request&& aRequest, Observe&& aObserve,
                BeforeRelease&& aBeforeRelease) {
    ASSERT_NO_FATAL_FAILURE(Settle());
    Monitor monitor{"TestFileSystemWriteLeaseOrdering"};
    bool ioWaiting = false;
    bool requestStarted = false;
    bool release = false;
    ASSERT_NSEQ(NS_OK, quota::QuotaManager::Get()->IOThread()->Dispatch(
                           NS_NewRunnableFunction("GateQuotaIO", [&] {
                             MonitorAutoLock lock(monitor);
                             ioWaiting = true;
                             lock.NotifyAll();
                             while (!release) {
                               lock.Wait();
                             }
                           })));
    {
      MonitorAutoLock lock(monitor);
      while (!ioWaiting) {
        lock.Wait();
      }
    }

    auto done =
        InvokeAsync(mDataManager->MutableIOTaskQueuePtr(), __func__, [&] {
          {
            MonitorAutoLock lock(monitor);
            requestStarted = true;
            lock.NotifyAll();
          }
          RefPtr<BoolPromise> result = aRequest();
          // No continuation can run between the handler and the following
          // lookup.
          aObserve();
          return result;
        });
    {
      MonitorAutoLock lock(monitor);
      while (!requestStarted) {
        lock.Wait();
      }
    }
    aBeforeRelease();
    {
      MonitorAutoLock lock(monitor);
      release = true;
      lock.NotifyAll();
    }
    EXPECT_TRUE(Await(done).IsResolve());
    PerformOnIOThread([] {});
  }

  template <typename Request, typename Observe>
  void RunGated(Request&& aRequest, Observe&& aObserve) {
    RunGated(std::forward<Request>(aRequest), std::forward<Observe>(aObserve),
             [] {});
  }

  Registered<data::FileSystemDataManager> mRegistration;
  RefPtr<data::FileSystemDataManager> mDataManager;
  RefPtr<FileSystemManagerParent> mActor;
  ipc::Endpoint<PFileSystemManagerChild> mChild;
  EntryId mRoot;
};

TEST_F(TestFileSystemWriteLeaseOrdering, CreateBeforeLookup) {
  for (const bool directory : {false, true}) {
    const Name name = directory ? u"directory"_ns : u"file"_ns;
    RunGated([&] { return GetHandle(name, true, directory); },
             [&] { GetHandle(name, false, directory); });
    EXPECT_FALSE(HasLease());
  }
}

TEST_F(TestFileSystemWriteLeaseOrdering, AcquisitionFailureLeavesQueueUsable) {
  for (const auto category :
       {nsIQuotaArtificialFailure::CATEGORY_ACQUIRE_WRITE_LEASE_DISPATCH,
        nsIQuotaArtificialFailure::CATEGORY_FLAG_ORIGIN_INFO_AS_DIRTY}) {
    SetFailure(category);
    RunGated(
        [&] {
          return GetHandle(u"file"_ns, true, false,
                           NS_ERROR_FILE_ACCESS_DENIED);
        },
        [&] { ExpectEntry(u"file"_ns, false); });
    EXPECT_FALSE(HasLease());
    SetFailure(0);
    RunGated([&] { return GetHandle(u"file"_ns, true); },
             [&] { ExpectEntry(u"file"_ns, true); });
    PerformOnThread(mDataManager->MutableIOTaskQueuePtr(), [&] {
      auto lease = mDataManager->AcquireWriteLease();
      ASSERT_TRUE(lease.isOk());
      EXPECT_TRUE(mDataManager->MutableDatabaseManagerPtr()
                      ->RemoveFile({mRoot, u"file"_ns})
                      .isOk());
    });
  }
}

TEST_F(TestFileSystemWriteLeaseOrdering, RemoveBeforeLookup) {
  PerformOnThread(mDataManager->MutableIOTaskQueuePtr(),
                  [&] { GetHandle(u"file"_ns, true); });
  RunGated(
      [&] {
        auto done = MakeRefPtr<BoolPromise::Private>(__func__);
        EXPECT_TRUE(mActor->RecvRemoveEntry({{mRoot, u"file"_ns}, false},
                                            [done](const auto& response) {
                                              CheckResponse(response, NS_OK);
                                              done->Resolve(true, __func__);
                                            }));
        return done;
      },
      [&] { ExpectEntry(u"file"_ns, false); });
  EXPECT_FALSE(HasLease());
}

TEST_F(TestFileSystemWriteLeaseOrdering, MoveAndRenameBeforeLookup) {
  EntryId file;
  EntryId directory;
  PerformOnThread(mDataManager->MutableIOTaskQueuePtr(), [&] {
    auto lease = mDataManager->AcquireWriteLease();
    ASSERT_TRUE(lease.isOk());
    auto* database = mDataManager->MutableDatabaseManagerPtr();
    TEST_TRY_UNWRAP(file, database->GetOrCreateFile({mRoot, u"file"_ns}, true));
    TEST_TRY_UNWRAP(directory, database->GetOrCreateDirectory(
                                   {mRoot, u"directory"_ns}, true));
  });
  RunGated(
      [&] {
        auto done = MakeRefPtr<BoolPromise::Private>(__func__);
        EXPECT_TRUE(mActor->RecvRenameEntry(
            {{file, u"file"_ns, false}, u"renamed"_ns},
            [done, &file](const auto& response) {
              CheckResponse(response, NS_OK);
              if (response.type() == FileSystemMoveEntryResponse::TEntryId) {
                file = response.get_EntryId();
              }
              done->Resolve(true, __func__);
            }));
        return done;
      },
      [&] {
        ExpectEntry(u"file"_ns, false);
        ExpectEntry(u"renamed"_ns, true);
      });
  RunGated(
      [&] {
        auto done = MakeRefPtr<BoolPromise::Private>(__func__);
        EXPECT_TRUE(mActor->RecvMoveEntry(
            {{file, u"renamed"_ns, false}, {directory, u"moved"_ns}},
            [done](const auto& response) {
              CheckResponse(response, NS_OK);
              done->Resolve(true, __func__);
            }));
        return done;
      },
      [&] {
        ExpectEntry(u"renamed"_ns, false);
        ExpectEntry(u"moved"_ns, true, false, directory);
      });
  EXPECT_FALSE(HasLease());
}

TEST_F(TestFileSystemWriteLeaseOrdering, WritableLocksBeforeNextRequest) {
  EntryId file;
  PerformOnThread(mDataManager->MutableIOTaskQueuePtr(), [&] {
    auto lease = mDataManager->AcquireWriteLease();
    ASSERT_TRUE(lease.isOk());
    TEST_TRY_UNWRAP(file,
                    mDataManager->MutableDatabaseManagerPtr()->GetOrCreateFile(
                        {mRoot, u"file"_ns}, true));
  });
  RefPtr<FileSystemWritableFileStreamParent> writable;
  RunGated(
      [&] {
        auto done = MakeRefPtr<BoolPromise::Private>(__func__);
        EXPECT_TRUE(mActor->RecvGetWritable(
            {file, false}, [done, &writable](auto&& response) {
              CheckResponse(response, NS_OK);
              if (response.type() ==
                  FileSystemGetWritableFileStreamResponse::
                      TFileSystemWritableFileStreamProperties) {
                writable = static_cast<FileSystemWritableFileStreamParent*>(
                    response.get_FileSystemWritableFileStreamProperties()
                        .writableFileStream()
                        .AsParent()
                        .get());
              }
              done->Resolve(true, __func__);
            }));
        return done;
      },
      [&] {
        auto locked = mDataManager->IsLocked(file);
        ASSERT_TRUE(locked.isOk());
        EXPECT_TRUE(locked.unwrap());
        EXPECT_TRUE(HasLease());
      });
  PerformOnThread(mDataManager->MutableIOTaskQueuePtr(), [&] {
    ASSERT_TRUE(writable);
    EXPECT_TRUE(writable->RecvClose(true, [](const auto&) {}));
    writable = nullptr;
    auto locked = mDataManager->IsLocked(file);
    ASSERT_TRUE(locked.isOk());
    EXPECT_FALSE(locked.unwrap());
  });
  EXPECT_FALSE(HasLease());
}

TEST_F(TestFileSystemWriteLeaseOrdering,
       LazyFileInitializationBeforeNextRequest) {
  EntryId file;
  PerformOnThread(mDataManager->MutableIOTaskQueuePtr(), [&] {
    auto lease = mDataManager->AcquireWriteLease();
    ASSERT_TRUE(lease.isOk());
    auto* database = mDataManager->MutableDatabaseManagerPtr();
    TEST_TRY_UNWRAP(file, database->GetOrCreateFile({mRoot, u"file"_ns}, true));
    EXPECT_TRUE(database->GetFileId(file).isErr());
  });
  RunGated(
      [&] {
        auto done = MakeRefPtr<BoolPromise::Private>(__func__);
        EXPECT_TRUE(mActor->RecvGetFile({file}, [done](auto&& response) {
          CheckResponse(response, NS_OK);
          done->Resolve(true, __func__);
        }));
        return done;
      },
      [&] {
        EXPECT_TRUE(
            mDataManager->MutableDatabaseManagerPtr()->GetFileId(file).isOk());
      });
  EXPECT_FALSE(HasLease());
}

TEST_F(TestFileSystemWriteLeaseOrdering, AccessHandleLocksBeforeNextRequest) {
  EntryId file;
  PerformOnThread(mDataManager->MutableIOTaskQueuePtr(), [&] {
    auto lease = mDataManager->AcquireWriteLease();
    ASSERT_TRUE(lease.isOk());
    TEST_TRY_UNWRAP(file,
                    mDataManager->MutableDatabaseManagerPtr()->GetOrCreateFile(
                        {mRoot, u"file"_ns}, true));
  });
  RunGated(
      [&] {
        return FileSystemAccessHandle::Create(mDataManager, file)
            ->Then(
                GetCurrentSerialEventTarget(), __func__,
                [](FileSystemAccessHandle::CreatePromise::ResolveOrRejectValue&&
                       value) {
                  EXPECT_TRUE(value.IsResolve());
                  if (value.IsReject()) {
                    return BoolPromise::CreateAndResolve(true, __func__);
                  }
                  auto& handle = value.ResolveValue().first;
                  return handle->BeginClose();
                });
      },
      [&] {
        auto locked = mDataManager->IsLocked(file);
        ASSERT_TRUE(locked.isOk());
        EXPECT_TRUE(locked.unwrap());
        EXPECT_TRUE(HasLease());
      });
  EXPECT_FALSE(HasLease());
}

TEST_F(TestFileSystemWriteLeaseOrdering,
       StorageShutdownDrainsPendingAcquisition) {
  RefPtr<BoolPromise> close;
  RefPtr<BoolPromise> shutdown;
  RunGated([&] { return GetHandle(u"file"_ns, true); },
           [&] { ExpectEntry(u"file"_ns, true); },
           [&] {
             EXPECT_EQ(mDataManager->MutableIOTaskQueuePtr()->Dispatch(
                           NS_NewRunnableFunction("CloseManagerActor",
                                                  [&] {
                                                    mActor->Close();
                                                    mActor = nullptr;
                                                    mChild = {};
                                                  })),
                       NS_OK);
             PerformOnBackgroundThread([&] {
               mRegistration = nullptr;
               close = mDataManager->OnClose();
               shutdown = quota::QuotaManager::Get()->ShutdownStorage();
             });
           });
  ASSERT_TRUE(close);
  ASSERT_TRUE(shutdown);
  EXPECT_TRUE(Await(close).IsResolve());
  EXPECT_TRUE(Await(shutdown).IsResolve());
  PerformOnBackgroundThread(
      [] { EXPECT_TRUE(data::FileSystemDataManager::IsShutdownCompleted()); });
  ASSERT_NO_FATAL_FAILURE(AssertStorageNotInitialized());
  // The queue is shut down, so TearDown must not dispatch to it again.
  PerformOnBackgroundThread([&] { mDataManager = nullptr; });
}

}  // namespace mozilla::dom::fs::test
