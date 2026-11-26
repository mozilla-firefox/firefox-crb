/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "mozilla/PlatformConditionVariable.h"
#include "mozilla/PlatformMutex.h"
#include "mozilla/Futex.h"

// Synchronization of the protected state is done by unlocking and locking the
// mutex. The only thing that needs stronger ordering is mWaiters vs. the
// notification counter: notifiers skip the wake-up syscall when there are no
// waiters, so a waiter must either be seen by the notifier, or see the
// notifier's counter increment and not go to sleep. Both sides use seq_cst
// for that.

mozilla::detail::ConditionVariableImpl::ConditionVariableImpl() = default;
mozilla::detail::ConditionVariableImpl::~ConditionVariableImpl() = default;

void mozilla::detail::ConditionVariableImpl::notify_one() {
  mFutex.mValue.fetch_add(1, std::memory_order_seq_cst);
  if (mWaiters.load(std::memory_order_seq_cst)) {
    mFutex.wake();
  }
}

void mozilla::detail::ConditionVariableImpl::notify_all() {
  mFutex.mValue.fetch_add(1, std::memory_order_seq_cst);
  if (mWaiters.load(std::memory_order_seq_cst)) {
    mFutex.wakeAll();
  }
}

void mozilla::detail::ConditionVariableImpl::wait(MutexImpl& lock) {
  wait_for(lock, TimeDuration::Forever());
}

mozilla::CVStatus mozilla::detail::ConditionVariableImpl::wait_for(
    MutexImpl& lock, const mozilla::TimeDuration& rel_time) {
  mWaiters.fetch_add(1, std::memory_order_seq_cst);
  // Examine the notification counter _before_ we unlock the mutex.
  uint32_t value = mFutex.mValue.load(std::memory_order_seq_cst);
  // Unlock the mutex before going to sleep.
  lock.unlock();
  // Wait, but only if there hasn't been any notification since we unlocked the
  // mutex.
  bool r = mFutex.wait(value, &rel_time);
  mWaiters.fetch_sub(1, std::memory_order_relaxed);
  // Lock the mutex again.
  lock.lock();
  return r ? CVStatus::NoTimeout : CVStatus::Timeout;
}
