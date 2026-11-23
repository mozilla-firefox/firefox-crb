/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "LayoutShift.h"

#include "PerformanceMainThread.h"
#include "mozilla/dom/LayoutShiftBinding.h"
#include "nsGkAtoms.h"

namespace mozilla::dom {

NS_IMPL_CYCLE_COLLECTION_INHERITED(LayoutShift, PerformanceEntry, mPerformance,
                                   mSources)

NS_INTERFACE_MAP_BEGIN_CYCLE_COLLECTION(LayoutShift)
NS_INTERFACE_MAP_END_INHERITING(PerformanceEntry)

NS_IMPL_ADDREF_INHERITED(LayoutShift, PerformanceEntry)
NS_IMPL_RELEASE_INHERITED(LayoutShift, PerformanceEntry)

LayoutShift::LayoutShift(PerformanceMainThread* aPerformance,
                         DOMHighResTimeStamp aStartTime, double aValue,
                         bool aHadRecentInput,
                         DOMHighResTimeStamp aLastInputTime,
                         nsTArray<RefPtr<LayoutShiftAttribution>>&& aSources)
    : PerformanceEntry(aPerformance->GetParentObject(), u""_ns,
                       nsGkAtoms::layoutShift),
      mPerformance(aPerformance),
      mStartTime(aStartTime),
      mValue(aValue),
      mHadRecentInput(aHadRecentInput),
      mLastInputTime(aLastInputTime),
      mSources(std::move(aSources)) {
  MOZ_ASSERT(mPerformance);
}

JSObject* LayoutShift::WrapObject(JSContext* aCx,
                                  JS::Handle<JSObject*> aGivenProto) {
  return LayoutShift_Binding::Wrap(aCx, this, aGivenProto);
}

void LayoutShift::BufferEntryIfNeeded() {
  mPerformance->BufferLayoutShiftEntryIfNeeded(this);
}

}  // namespace mozilla::dom
