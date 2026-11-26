/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include <algorithm>

#include "LSQuotaAccounting.h"
#include "LSWriteOptimizer.h"
#include "LSWriteOptimizerImpl.h"
#include "gtest/gtest.h"
#include "nsString.h"

namespace mozilla::dom {
namespace {

nsCString ValueOfLength(uint32_t aLength) {
  nsCString value;
  value.SetLength(aLength);
  std::fill_n(value.BeginWriting(), aLength, 'x');
  return value;
}

}  // namespace

TEST(LSQuotaAccounting, LoadedDeletionDoesNotGrantSpace)
{
  LSQuotaAccounting accounting(100);
  accounting.SetRequestedUsage(0);
  EXPECT_EQ(accounting.CommittedUsage(), 100);
  EXPECT_EQ(accounting.Reservation(), 0);

  accounting.BeginFlush(-100);
  EXPECT_EQ(accounting.CompleteFlush(true), Some<int64_t>(-100));
  EXPECT_EQ(accounting.CommittedUsage(), 0);
  EXPECT_EQ(accounting.Reservation(), 0);
}

TEST(LSQuotaAccounting, FailedInsertionRetainsCoverageForMergedRetry)
{
  LSQuotaAccounting accounting;
  LSWriteOptimizer<nsCString> pending;
  accounting.SetRequestedUsage(120);
  pending.InsertItem(u"k"_ns, ValueOfLength(99), 100);
  accounting.BeginFlush(pending.TotalDelta());
  auto failed = std::move(pending);

  pending.UpdateItem(u"k"_ns, ValueOfLength(79), -20);
  accounting.SetRequestedUsage(80);
  EXPECT_EQ(accounting.Reservation(), 100);

  pending.MergeFrom(std::move(failed));
  EXPECT_EQ(accounting.CompleteFlush(false), Nothing());
  EXPECT_EQ(accounting.CommittedUsage(), 0);
  EXPECT_EQ(accounting.Reservation(), 80);
  EXPECT_EQ(pending.TotalDelta(), 80);

  accounting.BeginFlush(pending.TotalDelta());
  EXPECT_EQ(accounting.CompleteFlush(true), Some<int64_t>(80));
  EXPECT_EQ(accounting.CommittedUsage(), 80);
  EXPECT_EQ(accounting.Reservation(), 0);
}

TEST(LSQuotaAccounting, PendingShrinkProtectsDispatchedInsertion)
{
  LSQuotaAccounting accounting;
  accounting.SetRequestedUsage(100);
  accounting.BeginFlush(100);

  accounting.SetRequestedUsage(80);
  EXPECT_EQ(accounting.Reservation(), 100);
  EXPECT_EQ(accounting.CompleteFlush(true), Some<int64_t>(100));
  EXPECT_EQ(accounting.CommittedUsage(), 100);
  EXPECT_EQ(accounting.Reservation(), 0);

  accounting.BeginFlush(-20);
  EXPECT_EQ(accounting.CompleteFlush(true), Some<int64_t>(-20));
  EXPECT_EQ(accounting.CommittedUsage(), 80);
  EXPECT_EQ(accounting.Reservation(), 0);
}

TEST(LSQuotaAccounting, RepeatedFailuresWithClear)
{
  LSQuotaAccounting accounting(100);
  LSWriteOptimizer<nsCString> pending;
  pending.UpdateItem(u"k"_ns, ValueOfLength(199), 100);
  accounting.SetRequestedUsage(200);
  accounting.BeginFlush(pending.TotalDelta());
  auto first = std::move(pending);

  pending.UpdateItem(u"k"_ns, ValueOfLength(299), 100);
  accounting.SetRequestedUsage(300);
  pending.MergeFrom(std::move(first));
  EXPECT_EQ(accounting.CompleteFlush(false), Nothing());
  EXPECT_EQ(accounting.Reservation(), 200);

  accounting.BeginFlush(pending.TotalDelta());
  auto second = std::move(pending);
  pending.Truncate(-300);
  pending.InsertItem(u"new"_ns, ValueOfLength(77), 80);
  accounting.SetRequestedUsage(80);
  EXPECT_EQ(accounting.Reservation(), 200);

  pending.MergeFrom(std::move(second));
  EXPECT_EQ(accounting.CompleteFlush(false), Nothing());
  EXPECT_EQ(accounting.CommittedUsage(), 100);
  EXPECT_EQ(accounting.Reservation(), 0);
  EXPECT_EQ(pending.TotalDelta(), -20);

  accounting.BeginFlush(pending.TotalDelta());
  EXPECT_EQ(accounting.CompleteFlush(true), Some<int64_t>(-20));
  EXPECT_EQ(accounting.CommittedUsage(), 80);
  EXPECT_EQ(accounting.Reservation(), 0);
}

TEST(LSQuotaAccounting, CommittedDeletionTransfersCoverageToReservation)
{
  LSQuotaAccounting accounting(100);
  accounting.SetRequestedUsage(0);
  accounting.BeginFlush(-100);

  accounting.SetRequestedUsage(80);
  EXPECT_EQ(accounting.Reservation(), 0);
  EXPECT_EQ(accounting.CompleteFlush(true), Some<int64_t>(-100));
  EXPECT_EQ(accounting.CommittedUsage(), 0);
  EXPECT_EQ(accounting.Reservation(), 80);

  accounting.BeginFlush(80);
  EXPECT_EQ(accounting.CompleteFlush(true), Some<int64_t>(80));
  EXPECT_EQ(accounting.CommittedUsage(), 80);
  EXPECT_EQ(accounting.Reservation(), 0);
}

TEST(LSQuotaAccounting, FailedDeletionThenReplacementAndDeletion)
{
  LSQuotaAccounting accounting(100);
  LSWriteOptimizer<nsCString> pending;
  pending.DeleteItem(u"k"_ns, -100);
  accounting.SetRequestedUsage(0);
  accounting.BeginFlush(pending.TotalDelta());
  auto failed = std::move(pending);

  pending.InsertItem(u"k"_ns, ValueOfLength(79), 80);
  accounting.SetRequestedUsage(80);
  pending.MergeFrom(std::move(failed));
  EXPECT_EQ(accounting.CompleteFlush(false), Nothing());
  pending.DeleteItem(u"k"_ns, -80);
  accounting.SetRequestedUsage(0);
  EXPECT_TRUE(pending.HasWrites());
  EXPECT_EQ(pending.TotalDelta(), -100);
  EXPECT_EQ(accounting.CommittedUsage(), 100);
  EXPECT_EQ(accounting.Reservation(), 0);

  accounting.BeginFlush(pending.TotalDelta());
  EXPECT_EQ(accounting.CompleteFlush(true), Some<int64_t>(-100));
  EXPECT_EQ(accounting.CommittedUsage(), 0);
  EXPECT_EQ(accounting.Reservation(), 0);
}

TEST(LSQuotaAccounting, AtomicReplacementDoesNotReserveBothValues)
{
  LSQuotaAccounting accounting(100);
  accounting.BeginFlush(0);
  EXPECT_EQ(accounting.Reservation(), 0);
  EXPECT_EQ(accounting.CompleteFlush(true), Some<int64_t>(0));
  EXPECT_EQ(accounting.CommittedUsage(), 100);
  EXPECT_EQ(accounting.Reservation(), 0);
}

TEST(LSQuotaAccounting, SnapshotHeadroomIsIndependentOfFlushTarget)
{
  LSQuotaAccounting accounting;
  accounting.SetRequestedUsage(1000);
  accounting.BeginFlush(100);
  accounting.SetRequestedUsage(100);
  EXPECT_EQ(accounting.Reservation(), 100);
  EXPECT_EQ(accounting.CompleteFlush(true), Some<int64_t>(100));
  EXPECT_EQ(accounting.Reservation(), 0);
  EXPECT_EQ(accounting.ReservationFor(1100), 1000);
}

}  // namespace mozilla::dom
