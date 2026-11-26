/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef DOM_QUOTA_CANONICALQUOTAOBJECT_H_
#define DOM_QUOTA_CANONICALQUOTAOBJECT_H_

// Local includes
#include "Client.h"

// Global includes
#include <cstdint>

#include "mozilla/AlreadyAddRefed.h"
#include "mozilla/FunctionRef.h"
#include "mozilla/RefPtr.h"
#include "mozilla/ThreadSafeWeakPtr.h"
#include "mozilla/dom/quota/Assertions.h"
#include "mozilla/dom/quota/QuotaObject.h"
#include "nsCOMPtr.h"
#include "nsISupports.h"
#include "nsStringFwd.h"

// XXX Avoid including this here by moving function bodies to the cpp file.
#include "mozilla/dom/quota/QuotaCommon.h"

namespace mozilla::dom::quota {

namespace test {
class TestQuotaReservations;
}

class DirtyTrackingAutoLock;

class OriginInfo;
class QuotaManager;

class CanonicalQuotaObject final : public QuotaObject {
  friend class OriginInfo;
  friend class QuotaManager;
  friend class test::TestQuotaReservations;

  class StoragePressureRunnable;

 public:
  NS_IMETHOD_(MozExternalRefCountType) AddRef() override;

  NS_IMETHOD_(MozExternalRefCountType) Release() override;

  const nsAString& Path() const override { return mPath; }

  [[nodiscard]] bool MaybeUpdateSize(int64_t aSize, bool aTruncate) override;

  bool IncreaseSize(int64_t aDelta) override;

  [[nodiscard]] bool MaybeSetReservation(int64_t aSize) override;

  void CommitReservation(int64_t aDelta,
                         int64_t aRemainingReservation) override;

  void DisableQuotaCheck() override;

  void EnableQuotaCheck() override;

 private:
  CanonicalQuotaObject(const RefPtr<OriginInfo>& aOriginInfo,
                       Client::Type aClientType, const nsAString& aPath,
                       int64_t aSize);

  MOZ_COUNTED_DTOR(CanonicalQuotaObject)

  already_AddRefed<QuotaObject> LockedAddRef() {
    AssertCurrentThreadOwnsQuotaMutex();

    ++mRefCnt;

    RefPtr<QuotaObject> result = dont_AddRef(this);
    return result.forget();
  }

  bool LockedMaybeUpdateSize(int64_t aSize, bool aTruncate,
                             DirtyTrackingAutoLock& aProofOfLock);

  // Evicts origins to make room for aDelta bytes and then calls aRetry, which
  // must recheck the group limit and apply the change. Drops and reacquires
  // the quota mutex several times.
  bool LockedEvictAndRetry(OriginInfo& aOriginInfo, uint64_t aDelta,
                           DirtyTrackingAutoLock& aProofOfLock,
                           FunctionRef<bool()> aRetry);

  mozilla::ThreadSafeAutoRefCnt mRefCnt;

  ThreadSafeWeakPtr<OriginInfo> mOriginInfo;
  nsString mPath;
  int64_t mSize;
  // Space reserved for uncommitted writes. Always nonnegative.
  int64_t mReservedSize = 0;
  Client::Type mClientType;
  bool mQuotaCheckDisabled;
  bool mWritingDone;
};

}  // namespace mozilla::dom::quota

#endif  // DOM_QUOTA_CANONICALQUOTAOBJECT_H_
