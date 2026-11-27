/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "gtest/gtest.h"

#include "base/process_util.h"
#include "mozilla/ProcInfo.h"
#include "mozilla/SpinEventLoopUntil.h"
#include "nsThreadUtils.h"

#ifdef XP_MACOSX
#  include <mach/mach.h>
#endif

using namespace mozilla;

// GetThreadCounts for the current process should report at least one thread and
// echo back the caller-supplied requestId.
TEST(ProcInfoThreadCount, CurrentProcess)
{
  nsTArray<ThreadCountRequest> requests;
  ThreadCountRequest request{};
  request.requestId = 0x1234;
  request.pid = base::GetCurrentProcId();
#ifdef XP_MACOSX
  request.childTask = mach_task_self();
#endif
  requests.AppendElement(request);

  bool done = false;
  CopyableTArray<ThreadCountResult> results;
  // Omit the target to exercise the default (stream transport service).
  GetThreadCounts(std::move(requests))
      ->Then(
          GetMainThreadSerialEventTarget(), __func__,
          [&](CopyableTArray<ThreadCountResult>&& aResults) {
            results = std::move(aResults);
            done = true;
          },
          [&](nsresult) { done = true; });

  MOZ_ALWAYS_TRUE(
      SpinEventLoopUntil("TestThreadCount"_ns, [&]() { return done; }));

  ASSERT_EQ(results.Length(), 1u);
  EXPECT_EQ(results[0].requestId, static_cast<uint64_t>(0x1234));
  EXPECT_GE(results[0].threadCount, 1u);
}
