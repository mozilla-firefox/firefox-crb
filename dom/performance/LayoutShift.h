/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef mozilla_dom_LayoutShift_h_
#define mozilla_dom_LayoutShift_h_

#include "mozilla/dom/LayoutShiftAttribution.h"
#include "mozilla/dom/PerformanceEntry.h"
#include "nsCycleCollectionParticipant.h"
#include "nsTArray.h"

namespace mozilla::dom {

static constexpr nsLiteralString kLayoutShiftName = u"layout-shift"_ns;

class PerformanceMainThread;

// https://wicg.github.io/layout-instability/#sec-layout-shift
class LayoutShift final : public PerformanceEntry {
 public:
  NS_DECL_ISUPPORTS_INHERITED
  NS_DECL_CYCLE_COLLECTION_CLASS_INHERITED(LayoutShift, PerformanceEntry)

  LayoutShift(PerformanceMainThread* aPerformance,
              DOMHighResTimeStamp aStartTime, double aValue,
              bool aHadRecentInput, DOMHighResTimeStamp aLastInputTime,
              nsTArray<RefPtr<LayoutShiftAttribution>>&& aSources);

  JSObject* WrapObject(JSContext* aCx,
                       JS::Handle<JSObject*> aGivenProto) override;

  DOMHighResTimeStamp StartTime() const override { return mStartTime; }

  double Value() const { return mValue; }
  bool HadRecentInput() const { return mHadRecentInput; }
  DOMHighResTimeStamp LastInputTime() const { return mLastInputTime; }
  void GetSources(nsTArray<RefPtr<LayoutShiftAttribution>>& aSources) const {
    aSources = mSources.Clone();
  }

  // Used when an entry that was held back while a pointer was down is reported
  // because the pointer was released, which is an excluding input.
  void SetInputInfo(bool aHadRecentInput, DOMHighResTimeStamp aLastInputTime) {
    mHadRecentInput = aHadRecentInput;
    mLastInputTime = aLastInputTime;
  }

  void BufferEntryIfNeeded() override;

 private:
  ~LayoutShift() = default;

  RefPtr<PerformanceMainThread> mPerformance;
  const DOMHighResTimeStamp mStartTime;
  const double mValue;
  bool mHadRecentInput;
  DOMHighResTimeStamp mLastInputTime;
  nsTArray<RefPtr<LayoutShiftAttribution>> mSources;
};

}  // namespace mozilla::dom

#endif  // mozilla_dom_LayoutShift_h_
