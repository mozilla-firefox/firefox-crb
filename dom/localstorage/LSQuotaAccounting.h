/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef mozilla_dom_LSQuotaAccounting_h
#define mozilla_dom_LSQuotaAccounting_h

#include <algorithm>
#include <cstdint>

#include "mozilla/Assertions.h"
#include "mozilla/CheckedInt.h"
#include "mozilla/DebugOnly.h"
#include "mozilla/Maybe.h"

namespace mozilla::dom {

// Owning-thread accounting; dispatched writes retain coverage until completion.
class LSQuotaAccounting {
  int64_t mCommittedUsage;
  int64_t mRequestedUsage;
  Maybe<int64_t> mFlushUsage;

 public:
  explicit LSQuotaAccounting(int64_t aUsage = 0)
      : mCommittedUsage(aUsage), mRequestedUsage(aUsage) {
    MOZ_ASSERT(aUsage >= 0);
  }

  int64_t ReservationFor(int64_t aRequestedUsage) const {
    MOZ_ASSERT(aRequestedUsage >= 0);
    int64_t upperBound = std::max(mCommittedUsage, aRequestedUsage);
    if (mFlushUsage) {
      upperBound = std::max(upperBound, *mFlushUsage);
    }
    const auto reservation = CheckedInt64(upperBound) - mCommittedUsage;
    MOZ_RELEASE_ASSERT(reservation.isValid());
    return reservation.value();
  }

  int64_t Reservation() const { return ReservationFor(mRequestedUsage); }

  int64_t CommittedUsage() const { return mCommittedUsage; }

  void SetRequestedUsage(int64_t aUsage) {
    MOZ_ASSERT(aUsage >= 0);
    mRequestedUsage = aUsage;
  }

  void BeginFlush(int64_t aDelta) {
    MOZ_ASSERT(!mFlushUsage);
    const DebugOnly<int64_t> oldReservation = Reservation();
    const auto usage = CheckedInt64(mCommittedUsage) + aDelta;
    MOZ_RELEASE_ASSERT(usage.isValid());
    MOZ_ASSERT(usage.value() >= 0);
    mFlushUsage = Some(usage.value());
    MOZ_ASSERT(Reservation() == oldReservation);
  }

  Maybe<int64_t> CompleteFlush(bool aCommitted) {
    MOZ_ASSERT(mFlushUsage);
    Maybe<int64_t> delta;
    if (aCommitted) {
      delta = Some(*mFlushUsage - mCommittedUsage);
      mCommittedUsage = *mFlushUsage;
    }
    mFlushUsage.reset();
    return delta;
  }
};

}  // namespace mozilla::dom

#endif  // mozilla_dom_LSQuotaAccounting_h
