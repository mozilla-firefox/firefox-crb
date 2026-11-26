/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// HttpLog.h should generally be included first
#include "ConnectionAttempt.h"

#include "HttpLog.h"
#include "mozilla/DebugOnly.h"
#include "mozilla/TimeStamp.h"
#include "nsHttpConnectionInfo.h"
#include "nsHttpTransaction.h"

namespace mozilla::net {

NS_IMPL_ISUPPORTS0(ConnectionAttempt)

ConnectionAttempt::ConnectionAttempt(nsHttpConnectionInfo* ci,
                                     nsAHttpTransaction* trans, uint32_t caps,
                                     bool speculative, bool urgentStart)
    : mConnInfo(ci),
      mTransaction(trans),
      mCaps(caps),
      mSpeculative(speculative),
      mUrgentStart(urgentStart) {}

void ConnectionAttempt::ForgetRealTransaction() { mTransaction = nullptr; }

bool ConnectionAttempt::AcceptsTransaction(nsHttpTransaction* trans) const {
  // When marked as urgent start, only accept urgent start marked transactions.
  // Otherwise, accept any kind of transaction.
  return !mUrgentStart || (trans->Caps() & nsIClassOfService::UrgentStart);
}

void ConnectionAttempt::Unclaim() {
  MOZ_ASSERT(!mSpeculative && !mFreeToUse);
  // We will keep the backup-timer running. Most probably this halfOpen will
  // be used by a transaction from which this transaction took the halfOpen.
  // (this is happening because of the transaction priority.)
  mFreeToUse = true;
}

uint32_t ConnectionAttempt::UnconnectedUDPConnsLength() const {
  if (mConnInfo->IsHttp3()) {
    return 1;
  }

  return 0;
}

void ConnectionAttempt::SetupAttemptTimer(uint64_t aTimeoutUs,
                                          nsITimerCallback* aCallback) {
  if (!aTimeoutUs) {
    MOZ_ASSERT(false, "aTimeoutUs should not be 0");
    return;
  }

  LOG(("ConnectionAttempt::SetupAttemptTimer %p to %" PRIu64 "us", this,
       aTimeoutUs));

  if (!mTimer) {
    // This can only fail on OOM and we'd crash.
    mTimer = NS_NewTimer();
  }

  // Only possible if the timer thread already shut down, and there is nothing
  // meaningful to do about that.
  DebugOnly<nsresult> rv = mTimer->InitHighResolutionWithCallback(
      aCallback,
      TimeDuration::FromMicroseconds(static_cast<double>(aTimeoutUs)),
      nsITimer::TYPE_ONE_SHOT);
  MOZ_ASSERT(NS_SUCCEEDED(rv));
}

void ConnectionAttempt::CancelAttemptTimer() {
  if (mTimer) {
    mTimer->Cancel();
    mTimer = nullptr;
  }
}

}  // namespace mozilla::net
