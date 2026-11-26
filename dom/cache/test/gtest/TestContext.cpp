/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at http://mozilla.org/MPL/2.0/. */

#include <functional>

#include "gtest/gtest.h"
#include "mozIStorageConnection.h"
#include "mozilla/BasePrincipal.h"
#include "mozilla/Preferences.h"
#include "mozilla/ScopeExit.h"
#include "mozilla/TimeStamp.h"
#include "mozilla/dom/cache/Action.h"
#include "mozilla/dom/cache/Context.h"
#include "mozilla/dom/cache/DBAction.h"
#include "mozilla/dom/cache/Manager.h"
#include "mozilla/dom/cache/ManagerId.h"
#include "mozilla/dom/quota/QuotaManager.h"
#include "mozilla/dom/quota/test/QuotaManagerDependencyFixture.h"
#include "nsNetUtil.h"

namespace mozilla::dom::cache {

class ContextTestPeer {
 public:
  static SafeRefPtr<Context> GetContext(Manager& aManager) {
    return aManager.mContext->SafeRefPtrFromThis();
  }

  static void BeginLease(Context& aContext, Action& aAction) {
    MOZ_RELEASE_ASSERT(!aContext.mWaitingForWriteLease);
    aContext.mWaitingForWriteLease = true;
    aContext.mWriteLeaseAction = &aAction;
  }

  static void RejectLease(Context& aContext, SafeRefPtr<Action> aAction) {
    aContext.OnWriteLeaseAcquired(std::move(aAction), Err(NS_ERROR_FAILURE));
  }

  static const quota::OriginMetadata& Metadata(const Context& aContext) {
    return *aContext.mDirectoryMetadata;
  }

  static bool Waiting(const Context& aContext) {
    return aContext.mWaitingForWriteLease;
  }

  static void Close(Context& aContext) {
    aContext.CancelAll();
    if (aContext.mData) {
      aContext.DoomTargetData();
    }
  }
};

namespace {

class CallbackAction final : public Action {
 public:
  explicit CallbackAction(std::function<void(nsresult)> aComplete,
                          bool aWrite = false)
      : mComplete(std::move(aComplete)), mWrite(aWrite) {}

  void RunOnTarget(SafeRefPtr<Resolver> aResolver,
                   const Maybe<CacheDirectoryMetadata>&, Data*,
                   const Maybe<CipherKey>&) override {
    aResolver->Resolve(NS_OK);
  }

  void CompleteOnInitiatingThread(nsresult aRv) override { mComplete(aRv); }
  bool IsWrite() const override { return mWrite; }

 private:
  std::function<void(nsresult)> mComplete;
  bool mWrite;
};

class QueryDBAction final : public SyncDBAction {
 public:
  explicit QueryDBAction(std::function<void(nsresult)> aComplete)
      : SyncDBAction(DBAction::Existing), mComplete(std::move(aComplete)) {}

  nsresult RunSyncWithDBOnTarget(const CacheDirectoryMetadata&, nsIFile*,
                                 mozIStorageConnection* aConn) override {
    return aConn->ExecuteSimpleSQL("SELECT 1;"_ns);
  }

  void CompleteOnInitiatingThread(nsresult aRv) override { mComplete(aRv); }

 private:
  std::function<void(nsresult)> mComplete;
};

}  // namespace

class TestCacheContext : public quota::test::QuotaManagerDependencyFixture {
 public:
  static void SetUpTestCase() { ASSERT_NO_FATAL_FAILURE(InitializeFixture()); }
  static void TearDownTestCase() { ASSERT_NO_FATAL_FAILURE(ShutdownFixture()); }

  void SetUp() override {
    ASSERT_NO_FATAL_FAILURE(InitializeStorage());
    ASSERT_NO_FATAL_FAILURE(InitializeTemporaryStorage());
    if (Preferences::HasUserValue(kQuiescencePref)) {
      mOldQuiescence = Some(Preferences::GetUint(kQuiescencePref));
    }
    Preferences::SetUint(kQuiescencePref, 0);
  }

  void TearDown() override {
    auto restore = MakeScopeExit([&] {
      if (mOldQuiescence) {
        Preferences::SetUint(kQuiescencePref, *mOldQuiescence);
      } else {
        Preferences::ClearUser(kQuiescencePref);
      }
    });
    ASSERT_NO_FATAL_FAILURE(ClearStorage());
  }

 protected:
  void CreateManagerId(SafeRefPtr<ManagerId>& aId) {
    nsCOMPtr<nsIURI> uri;
    ASSERT_EQ(NS_NewURI(getter_AddRefs(uri), "https://cache.example.com"_ns),
              NS_OK);
    RefPtr<BasePrincipal> principal =
        BasePrincipal::CreateContentPrincipal(uri, {});
    ASSERT_TRUE(principal);
    auto idResult = ManagerId::Create(principal);
    ASSERT_TRUE(idResult.isOk());
    aId = idResult.unwrap();
  }

  void CheckDispatchAfterDoomTargetData() {
    SafeRefPtr<ManagerId> id;
    ASSERT_NO_FATAL_FAILURE(CreateManagerId(id));

    PerformOnBackgroundThread([&] {
      auto result = Manager::AcquireCreateIfNonExistent(id);
      ASSERT_TRUE(result.isOk());
      auto manager = result.unwrap();
      auto context = ContextTestPeer::GetContext(*manager);
      auto cleanup = MakeScopeExit([&] {
        manager->NoteClosing();
        ContextTestPeer::Close(*context);
      });

      RefPtr<BoolPromise::Private> ready = new BoolPromise::Private(__func__);
      context->Dispatch(MakeSafeRefPtr<CallbackAction>([ready](nsresult aRv) {
        EXPECT_EQ(aRv, NS_OK);
        ready->Resolve(true, __func__);
      }));
      auto readyResult = Await(RefPtr<BoolPromise>(ready));
      ASSERT_TRUE(readyResult.IsResolve());

      manager->NoteClosing();
      context->AllowToClose();

      RefPtr<BoolPromise::Private> done = new BoolPromise::Private(__func__);
      context->Dispatch(MakeSafeRefPtr<QueryDBAction>([done](nsresult aRv) {
        EXPECT_EQ(aRv, NS_OK);
        done->Resolve(true, __func__);
      }));
      auto doneResult = Await(RefPtr<BoolPromise>(done));
      ASSERT_TRUE(doneResult.IsResolve());
    });
  }

  void CheckReentrantCompletion(bool aQueuedWriter, bool aCancel) {
    SafeRefPtr<ManagerId> id;
    ASSERT_NO_FATAL_FAILURE(CreateManagerId(id));

    PerformOnBackgroundThread([&] {
      auto result = Manager::AcquireCreateIfNonExistent(id);
      ASSERT_TRUE(result.isOk());
      auto manager = result.unwrap();
      auto context = ContextTestPeer::GetContext(*manager);
      auto cleanup = MakeScopeExit([&] {
        manager->NoteClosing();
        ContextTestPeer::Close(*context);
      });

      RefPtr<BoolPromise::Private> ready = new BoolPromise::Private(__func__);
      context->Dispatch(MakeSafeRefPtr<CallbackAction>([ready](nsresult aRv) {
        EXPECT_EQ(aRv, NS_OK);
        ready->Resolve(true, __func__);
      }));
      auto readyResult = Await(RefPtr<BoolPromise>(ready));
      ASSERT_TRUE(readyResult.IsResolve());
      ASSERT_NO_FATAL_FAILURE(WaitForCondition([&] {
        PerformOnIOThread(
            [] { quota::QuotaManager::Get()->FlushDirtyOriginInfos(); });
        return !quota::QuotaManager::Get()->TryAcquireWriteLease(
            ContextTestPeer::Metadata(*context));
      }));

      nsTArray<uint32_t> completed;
      RefPtr<BoolPromise::Private> done = new BoolPromise::Private(__func__);
      const auto onComplete = [&](uint32_t aIndex, nsresult aRv) {
        EXPECT_EQ(aRv, aCancel ? NS_ERROR_ABORT : NS_OK);
        completed.AppendElement(aIndex);
        if (completed.Length() == 3) {
          done->Resolve(true, __func__);
        }
      };
      auto rejected = MakeSafeRefPtr<CallbackAction>([&](nsresult aRv) {
        EXPECT_EQ(aRv, NS_ERROR_FAILURE);
        context->Dispatch(MakeSafeRefPtr<CallbackAction>(
            [&](nsresult rv) { onComplete(3, rv); }));
        if (aCancel) {
          context->CancelAll();
        }
      });
      ContextTestPeer::BeginLease(*context, *rejected);
      context->Dispatch(MakeSafeRefPtr<CallbackAction>(
          [&](nsresult rv) { onComplete(1, rv); }));
      context->Dispatch(MakeSafeRefPtr<CallbackAction>(
          [&](nsresult rv) { onComplete(2, rv); }, aQueuedWriter));
      ContextTestPeer::RejectLease(*context, std::move(rejected));
      EXPECT_EQ(ContextTestPeer::Waiting(*context), aQueuedWriter && !aCancel);
      auto doneResult = Await(RefPtr<BoolPromise>(done));
      ASSERT_TRUE(doneResult.IsResolve());
      EXPECT_EQ(completed, (nsTArray<uint32_t>{1, 2, 3}));
    });
  }

 private:
  static constexpr const char* kQuiescencePref =
      "dom.quotaManager.originWriteQuiescentThresholdMs";
  Maybe<uint32_t> mOldQuiescence;
};

TEST_F(TestCacheContext, ReentrantCompletionPreservesQueue) {
  CheckReentrantCompletion(false, false);
}

TEST_F(TestCacheContext, ReentrantCompletionWaitsForNextLease) {
  CheckReentrantCompletion(true, false);
}

TEST_F(TestCacheContext, ReentrantCompletionCanCancelQueue) {
  CheckReentrantCompletion(true, true);
}

TEST_F(TestCacheContext, DispatchDBActionAfterDoomTargetData) {
  CheckDispatchAfterDoomTargetData();
}

}  // namespace mozilla::dom::cache
