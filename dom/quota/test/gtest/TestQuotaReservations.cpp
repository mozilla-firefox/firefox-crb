/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "CanonicalQuotaObject.h"
#include "DirtyTrackingAutoLock.h"
#include "OriginInfo.h"
#include "QuotaManagerDependencyFixture.h"
#include "QuotaManagerImpl.h"
#include "QuotaManagerTestHelpers.h"
#include "gtest/gtest.h"
#include "mozilla/Casting.h"
#include "mozilla/Preferences.h"
#include "mozilla/ScopeExit.h"
#include "mozilla/TimeStamp.h"
#include "mozilla/dom/quota/QuotaManager.h"
#include "mozilla/dom/quota/QuotaObject.h"
#include "nsIFile.h"
#include "prtime.h"

namespace mozilla::dom::quota::test {
namespace {
constexpr const char* kReservationLimitPref =
    "dom.quotaManager.temporaryStorage.fixedLimit";
constexpr const char* kReservationQuiescencePref =
    "dom.quotaManager.originWriteQuiescentThresholdMs";

OriginMetadata GetSameGroupTestOriginMetadata() {
  return {GetPrincipalMetadata("example.com"_ns, "http://sub.example.com"_ns),
          PERSISTENCE_TYPE_DEFAULT};
}

}  // namespace

class TestQuotaReservations : public QuotaManagerDependencyFixture {
 public:
  static void SetUpTestCase() { ASSERT_NO_FATAL_FAILURE(InitializeFixture()); }
  static void TearDownTestCase() { ASSERT_NO_FATAL_FAILURE(ShutdownFixture()); }

  void SetUp() override {
    if (Preferences::HasUserValue(kReservationLimitPref)) {
      mOldLimit = Some(Preferences::GetInt(kReservationLimitPref));
    }
    if (Preferences::HasUserValue(kReservationQuiescencePref)) {
      mOldQuiescence = Some(Preferences::GetUint(kReservationQuiescencePref));
    }
    Preferences::SetInt(kReservationLimitPref, 50 * 1024);
    Preferences::SetUint(kReservationQuiescencePref, 0);
    ASSERT_NO_FATAL_FAILURE(ShutdownStorage());
    ASSERT_NO_FATAL_FAILURE(InitializeStorage());
    mQuotaManager = QuotaManager::Get();
    ASSERT_TRUE(mQuotaManager);
  }

  void TearDown() override {
    auto restorePrefs = MakeScopeExit([&] {
      if (mOldLimit) {
        Preferences::SetInt(kReservationLimitPref, *mOldLimit);
      } else {
        Preferences::ClearUser(kReservationLimitPref);
      }
      if (mOldQuiescence) {
        Preferences::SetUint(kReservationQuiescencePref, *mOldQuiescence);
      } else {
        Preferences::ClearUser(kReservationQuiescencePref);
      }
    });
    ASSERT_NO_FATAL_FAILURE(ClearStorage());
  }

 protected:
  void InitializeOrigin(const OriginMetadata& aMetadata) {
    ASSERT_NO_FATAL_FAILURE(InitializeTemporaryStorage());
    ASSERT_NO_FATAL_FAILURE(InitializeTemporaryOrigin(aMetadata));
    PerformOnIOThread([&] {
      auto lease = mQuotaManager->AcquireWriteLeaseOnIOThread(aMetadata);
      ASSERT_TRUE(lease.isOk());
      mQuotaManager->UpdateOriginAccessTime(aMetadata, PR_Now());
    });
  }

  void FlushDirtyOriginInfos() {
    ASSERT_NO_FATAL_FAILURE(WaitForCondition([&] {
      PerformOnIOThread([&] { mQuotaManager->FlushDirtyOriginInfos(); });
      return !IsDirtyInMemory(mOriginMetadata);
    }));
  }

  Maybe<WriteLease> AcquireWriteLease(const OriginMetadata& aMetadata) {
    auto lease = mQuotaManager->AcquireWriteLeaseOnIOThread(aMetadata);
    if (lease.isErr()) {
      return Nothing();
    }
    return Some(lease.unwrap());
  }

  bool IsDirtyInMemory(const OriginMetadata& aMetadata) {
    return mQuotaManager->WithOriginInfo(
        aMetadata, [](const auto& info) { return info->LockedDirty(); });
  }

  int64_t UsageInMemory(const OriginMetadata& aOriginMetadata) {
    return mQuotaManager->WithOriginInfo(
        aOriginMetadata,
        [](const auto& aOriginInfo) { return aOriginInfo->LockedUsage(); });
  }

  int64_t ReservedUsageInMemory(const OriginMetadata& aOriginMetadata) {
    return mQuotaManager->WithOriginInfo(
        aOriginMetadata, [](const auto& aOriginInfo) {
          return aOriginInfo->LockedReservedUsage();
        });
  }

  RefPtr<QuotaObject> GetTestQuotaObject(const OriginMetadata& aOriginMetadata,
                                         const nsAString& aFileName) {
    auto directory = mQuotaManager->GetOriginDirectory(aOriginMetadata);
    if (directory.isErr()) {
      return nullptr;
    }
    if (NS_FAILED(directory.inspect()->Append(u"sdb"_ns)) ||
        NS_FAILED(directory.inspect()->Append(aFileName))) {
      return nullptr;
    }

    return mQuotaManager->GetQuotaObject(
        aOriginMetadata.mPersistenceType, aOriginMetadata, Client::SDB,
        directory.inspect(), /* aFileSize */ 0);
  }

  RefPtr<QuotaObject> CreateUnregisteredQuotaObject(
      const RefPtr<OriginInfo>& aOriginInfo) {
    return new CanonicalQuotaObject(aOriginInfo, Client::SDB,
                                    u"expired.sqlite"_ns, 0);
  }

  OriginMetadata mOriginMetadata = GetTestOriginMetadata();
  QuotaManager* mQuotaManager = nullptr;
  Maybe<int32_t> mOldLimit;
  Maybe<uint32_t> mOldQuiescence;
};

// Reservations count against the limits but are not part of the origin usage
// until they are committed, and they do not make the origin dirty.
TEST_F(TestQuotaReservations, QuotaObject_ReservationIsNotUsageUntilCommitted) {
  ASSERT_NO_FATAL_FAILURE(InitializeOrigin(mOriginMetadata));

  ASSERT_NO_FATAL_FAILURE(FlushDirtyOriginInfos());
  EXPECT_FALSE(IsDirtyInMemory(mOriginMetadata));

  PerformOnIOThread([this]() {
    const int64_t initialUsage = UsageInMemory(mOriginMetadata);
    EXPECT_EQ(ReservedUsageInMemory(mOriginMetadata), 0);

    auto quotaObject =
        GetTestQuotaObject(mOriginMetadata, u"reservation-test.sqlite"_ns);
    ASSERT_TRUE(quotaObject);

    ASSERT_TRUE(quotaObject->MaybeSetReservation(1000));
    EXPECT_EQ(UsageInMemory(mOriginMetadata), initialUsage);
    EXPECT_EQ(ReservedUsageInMemory(mOriginMetadata), 1000);
    EXPECT_FALSE(IsDirtyInMemory(mOriginMetadata));

    EXPECT_TRUE(quotaObject->MaybeSetReservation(600));
    EXPECT_EQ(ReservedUsageInMemory(mOriginMetadata), 600);

    // Committing modifies the origin metadata, so it needs a write lease.
    auto lease = AcquireWriteLease(mOriginMetadata);
    ASSERT_TRUE(lease);
    quotaObject->CommitReservation(500, 100);
    EXPECT_EQ(UsageInMemory(mOriginMetadata), initialUsage + 500);
    EXPECT_EQ(ReservedUsageInMemory(mOriginMetadata), 100);
    EXPECT_TRUE(IsDirtyInMemory(mOriginMetadata));
    lease.reset();

    // Dropping the quota object releases what is left of the reservation.
    quotaObject = nullptr;
    EXPECT_EQ(UsageInMemory(mOriginMetadata), initialUsage + 500);
    EXPECT_EQ(ReservedUsageInMemory(mOriginMetadata), 0);
  });

  ASSERT_NO_FATAL_FAILURE(FlushDirtyOriginInfos());
  EXPECT_FALSE(IsDirtyInMemory(mOriginMetadata));
}

// A reservation is counted against the group limit like usage is, both for
// later usage updates and for later reservations, and is no longer counted
// once released or once its origin is removed.
TEST_F(TestQuotaReservations, QuotaObject_ReservationCountsAgainstGroupLimit) {
  auto sameGroupOriginMetadata = GetSameGroupTestOriginMetadata();

  ASSERT_NO_FATAL_FAILURE(InitializeOrigin(mOriginMetadata));
  ASSERT_NO_FATAL_FAILURE(InitializeOrigin(sameGroupOriginMetadata));

  ASSERT_NO_FATAL_FAILURE(FlushDirtyOriginInfos());

  RefPtr<QuotaObject> quotaObjectB;
  RefPtr<OriginInfo> removedOriginInfo;
  PerformOnIOThread([this, sameGroupOriginMetadata, &quotaObjectB,
                     &removedOriginInfo]() {
    const int64_t groupLimit =
        AssertedCast<int64_t>(mQuotaManager->GetGroupLimit());
    EXPECT_EQ(groupLimit, 10 * 1024 * 1024);

    RefPtr<QuotaObject> quotaObjectA =
        GetTestQuotaObject(mOriginMetadata, u"a.sqlite"_ns);
    quotaObjectB = GetTestQuotaObject(sameGroupOriginMetadata, u"b.sqlite"_ns);
    ASSERT_TRUE(quotaObjectA && quotaObjectB);

    const int64_t initialUsageB = UsageInMemory(sameGroupOriginMetadata);

    ASSERT_TRUE(quotaObjectA->MaybeSetReservation(groupLimit - 1024));

    auto lease = AcquireWriteLease(sameGroupOriginMetadata);
    ASSERT_TRUE(lease);

    // The group check fails without attempting eviction.
    EXPECT_FALSE(quotaObjectB->MaybeUpdateSize(2048, /* aTruncate */ false));
    EXPECT_EQ(UsageInMemory(sameGroupOriginMetadata), initialUsageB);
    EXPECT_FALSE(quotaObjectB->MaybeSetReservation(2048));
    EXPECT_EQ(ReservedUsageInMemory(sameGroupOriginMetadata), 0);

    EXPECT_TRUE(quotaObjectA->MaybeSetReservation(0));
    EXPECT_EQ(ReservedUsageInMemory(mOriginMetadata), 0);

    EXPECT_TRUE(quotaObjectB->MaybeUpdateSize(2048, /* aTruncate */ false));
    EXPECT_EQ(UsageInMemory(sameGroupOriginMetadata), initialUsageB + 2048);
    EXPECT_TRUE(quotaObjectB->MaybeSetReservation(2048));

    // Dropping the first quota object releases its outstanding reservation.
    EXPECT_TRUE(quotaObjectA->MaybeSetReservation(groupLimit - 8192));
    EXPECT_FALSE(quotaObjectB->MaybeSetReservation(10240));
    quotaObjectA = nullptr;
    EXPECT_EQ(ReservedUsageInMemory(mOriginMetadata), 0);
    EXPECT_TRUE(quotaObjectB->MaybeSetReservation(10240));
    EXPECT_EQ(ReservedUsageInMemory(sameGroupOriginMetadata), 10240);
    // Keep the detached OriginInfo alive to exercise late reservation release.
    removedOriginInfo = mQuotaManager->WithOriginInfo(
        sameGroupOriginMetadata,
        [](const auto& aOriginInfo) { return aOriginInfo; });
  });

  ASSERT_NO_FATAL_FAILURE(ClearStoragesForOrigin(sameGroupOriginMetadata));

  // Removing the origin subtracted its remaining accounting from the group,
  // so the whole group limit is available again.
  PerformOnIOThread([this, &quotaObjectB, &removedOriginInfo]() {
    const int64_t groupLimit =
        AssertedCast<int64_t>(mQuotaManager->GetGroupLimit());

    RefPtr<QuotaObject> quotaObjectA =
        GetTestQuotaObject(mOriginMetadata, u"a.sqlite"_ns);
    ASSERT_TRUE(quotaObjectA);

    const int64_t available = groupLimit - UsageInMemory(mOriginMetadata);
    EXPECT_TRUE(quotaObjectA->MaybeSetReservation(available));
    EXPECT_FALSE(quotaObjectA->MaybeSetReservation(available + 1));

    quotaObjectB = nullptr;
    EXPECT_EQ(ReservedUsageInMemory(mOriginMetadata), available);
    EXPECT_FALSE(quotaObjectA->MaybeSetReservation(available + 1));
    removedOriginInfo = nullptr;
    quotaObjectA = nullptr;
    EXPECT_EQ(ReservedUsageInMemory(mOriginMetadata), 0);
  });
}

// Committing a negative delta records a usage decrease while the whole
// reservation stays in place until it is released.
TEST_F(TestQuotaReservations, QuotaObject_NegativeCommit) {
  ASSERT_NO_FATAL_FAILURE(InitializeOrigin(mOriginMetadata));

  PerformOnIOThread([this]() {
    RefPtr<QuotaObject> quotaObject =
        GetTestQuotaObject(mOriginMetadata, u"negative-commit.sqlite"_ns);
    ASSERT_TRUE(quotaObject);

    const int64_t initialUsage = UsageInMemory(mOriginMetadata);

    auto lease = AcquireWriteLease(mOriginMetadata);
    ASSERT_TRUE(lease);

    ASSERT_TRUE(quotaObject->MaybeUpdateSize(800, /* aTruncate */ false));
    EXPECT_EQ(UsageInMemory(mOriginMetadata), initialUsage + 800);

    EXPECT_TRUE(quotaObject->MaybeSetReservation(1000));
    EXPECT_EQ(ReservedUsageInMemory(mOriginMetadata), 1000);

    quotaObject->CommitReservation(-300, 1000);
    EXPECT_EQ(UsageInMemory(mOriginMetadata), initialUsage + 500);
    EXPECT_EQ(ReservedUsageInMemory(mOriginMetadata), 1000);

    quotaObject = nullptr;
    EXPECT_EQ(UsageInMemory(mOriginMetadata), initialUsage + 500);
    EXPECT_EQ(ReservedUsageInMemory(mOriginMetadata), 0);
  });

  ASSERT_NO_FATAL_FAILURE(FlushDirtyOriginInfos());
  EXPECT_FALSE(IsDirtyInMemory(mOriginMetadata));
}

// Reservations of a persisted origin count against the global limit only,
// like its usage, so they leave the group limit to the other origins.
TEST_F(TestQuotaReservations, QuotaObject_ReservationOnPersistedOrigin) {
  auto sameGroupOriginMetadata = GetSameGroupTestOriginMetadata();

  ASSERT_NO_FATAL_FAILURE(InitializeOrigin(mOriginMetadata));
  ASSERT_NO_FATAL_FAILURE(InitializeOrigin(sameGroupOriginMetadata));

  PerformOnIOThread([this]() {
    auto writeLease =
        mQuotaManager->AcquireWriteLeaseOnIOThread(mOriginMetadata);
    ASSERT_TRUE(writeLease.isOk());

    mQuotaManager->PersistOrigin(mOriginMetadata);
  });

  PerformOnIOThread([this, sameGroupOriginMetadata]() {
    const int64_t groupLimit =
        AssertedCast<int64_t>(mQuotaManager->GetGroupLimit());

    RefPtr<QuotaObject> quotaObjectA =
        GetTestQuotaObject(mOriginMetadata, u"a.sqlite"_ns);
    RefPtr<QuotaObject> quotaObjectB =
        GetTestQuotaObject(sameGroupOriginMetadata, u"b.sqlite"_ns);
    ASSERT_TRUE(quotaObjectA && quotaObjectB);

    const int64_t initialUsageA = UsageInMemory(mOriginMetadata);

    ASSERT_TRUE(quotaObjectA->MaybeSetReservation(groupLimit - 1024));
    EXPECT_TRUE(quotaObjectB->MaybeSetReservation(2048));

    auto lease = AcquireWriteLease(mOriginMetadata);
    ASSERT_TRUE(lease);

    quotaObjectA->CommitReservation(groupLimit - 1024, 0);
    EXPECT_EQ(UsageInMemory(mOriginMetadata),
              initialUsageA + groupLimit - 1024);
    EXPECT_EQ(ReservedUsageInMemory(mOriginMetadata), 0);

    EXPECT_TRUE(quotaObjectB->MaybeSetReservation(4096));

    quotaObjectA = nullptr;
    quotaObjectB = nullptr;
    EXPECT_EQ(ReservedUsageInMemory(sameGroupOriginMetadata), 0);
  });

  ASSERT_NO_FATAL_FAILURE(ClearStoragesForOrigin(sameGroupOriginMetadata));
}

TEST(DirtyTrackingAutoLock, ReservationWithoutOrigin)
{
  Mutex mutex("ReservationWithoutOrigin");
  {
    DirtyTrackingAutoLock lock(mutex, nullptr,
                               DirtyTrackingAutoLock::ReservationOnly{});
    EXPECT_FALSE(lock.IsValid());
    mutex.AssertNotCurrentThreadOwns();
  }
  MutexAutoLock lock(mutex);
  mutex.AssertCurrentThreadOwns();
}

TEST_F(TestQuotaReservations, ExpiredOriginDoesNotAffectReplacement) {
  ASSERT_NO_FATAL_FAILURE(InitializeOrigin(mOriginMetadata));
  RefPtr<QuotaObject> object;
  ThreadSafeWeakPtr<OriginInfo> weakOrigin;
  PerformOnIOThread([&] {
    auto origin = mQuotaManager->WithOriginInfo(
        mOriginMetadata, [](const auto& info) { return info; });
    weakOrigin = origin;
    // Registered objects must normally be closed before their origin dies.
    object = CreateUnregisteredQuotaObject(origin);
    ASSERT_TRUE(object->MaybeSetReservation(1000));
  });
  ASSERT_TRUE(object);
  ASSERT_NO_FATAL_FAILURE(ClearStoragesForOrigin(mOriginMetadata));
  PerformOnIOThread([&] {
    mQuotaManager->FlushDirtyOriginInfos();
    ASSERT_FALSE(RefPtr<OriginInfo>(weakOrigin));
    EXPECT_TRUE(object->MaybeSetReservation(2000));
    EXPECT_TRUE(object->MaybeSetReservation(500));
    object->CommitReservation(100, 400);
  });

  ASSERT_NO_FATAL_FAILURE(InitializeOrigin(mOriginMetadata));
  PerformOnIOThread([&] {
    const auto initialUsage = UsageInMemory(mOriginMetadata);
    EXPECT_EQ(ReservedUsageInMemory(mOriginMetadata), 0);
    EXPECT_TRUE(object->MaybeSetReservation(3000));
    object->CommitReservation(-100, 3000);
    object = nullptr;
    EXPECT_EQ(UsageInMemory(mOriginMetadata), initialUsage);
    EXPECT_EQ(ReservedUsageInMemory(mOriginMetadata), 0);
  });
}

}  // namespace mozilla::dom::quota::test
