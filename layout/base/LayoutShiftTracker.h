/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef mozilla_LayoutShiftTracker_h
#define mozilla_LayoutShiftTracker_h

#include "mozilla/Attributes.h"
#include "mozilla/Maybe.h"
#include "mozilla/TimeStamp.h"
#include "nsCOMPtr.h"
#include "nsHashKeys.h"
#include "nsPoint.h"
#include "nsRect.h"
#include "nsTArray.h"
#include "nsTHashMap.h"

class nsIFrame;
class nsITimer;
class nsPresContext;

namespace mozilla {

namespace dom {
class Element;
class PerformanceMainThread;
}  // namespace dom

/**
 * Implements the layout side of the Layout Instability API
 * (https://wicg.github.io/layout-instability/).
 *
 * Frames store their rect from before their first rect change since the last
 * rendering update here (see nsIFrame::RecordLayoutShiftOldRect). In the
 * ReportLayoutShift rendering phase, Report() compares those to the current
 * geometry, computes the layout shift score and queues a LayoutShift entry.
 *
 * Frames moved by nsBlockFrame sliding lines, which is usually most of what
 * moves when content is inserted into a long block, are tracked per block
 * instead, as a list of frames that all moved by the same amount (see
 * AutoLineSlide).
 *
 * Owned by the PresShell, created on demand.
 */
class LayoutShiftTracker final {
 public:
  explicit LayoutShiftTracker(nsPresContext* aPresContext);
  ~LayoutShiftTracker();

  /**
   * Returns the tracker for aPresContext's document, creating it if needed,
   * or nullptr if layout shifts aren't tracked in that document.
   */
  static LayoutShiftTracker* Get(nsPresContext* aPresContext);

  struct RecordingInfo {
    // Null if frames that move now can't have been rendered at their old
    // position.
    LayoutShiftTracker* mTracker = nullptr;
    // The value for nsIFrame::CanRecordLayoutShift().
    uint16_t mRenderingUpdateCount = 0;
  };

  /**
   * Like Get(), with what nsIFrame::CanRecordLayoutShift() needs.
   */
  static RecordingInfo GetForRecording(nsPresContext* aPresContext);

  /**
   * Stores aOldRect, aFrame's rect before its current change, unless a rect
   * was already stored for aFrame since the last report.
   */
  void Record(nsIFrame* aFrame, const nsRect& aOldRect);
  void RecordClip(nsIFrame* aFrame);

  /**
   * Records visibility or opacity before its first change since the last
   * report. aFrame must have a stored rect or have been moved by a line slide.
   */
  void NoteVisibilityChange(nsIFrame* aFrame, bool aWasHidden);

  /**
   * Drops the stored rect for aFrame, if any, and takes it out of its block's
   * slide, if any. Must be called when a frame with
   * nsIFrame::IsLayoutShiftRecorded() or IsLayoutShiftSlid() is destroyed or
   * reparented.
   */
  void Forget(nsIFrame* aFrame);

  /**
   * Notifies us that scroll anchoring moved aScrolledFrame (the scrolled frame
   * of a scroll container) by aAdjustment, so that the content moves that the
   * adjustment compensated are not considered shifts.
   */
  void AddScrollAnchorAdjustment(nsIFrame* aScrolledFrame,
                                 const nsPoint& aAdjustment);

  /**
   * Computes the layout shift since the last report, queues a LayoutShift
   * performance entry if needed, and clears all stored rects.
   */
  void Report();

  /**
   * Input notifications, used to compute LayoutShift.hadRecentInput.
   * Key presses and mouse button presses are excluding inputs right away.
   * Layout shifts that happen while a pointer is down are held back until the
   * pointer is released, when they are reported as having had recent input at
   * the release, or the interaction is canceled, e.g. because it became a
   * scroll, when they are reported as they were.
   */
  void NotifyExcludingInput(const TimeStamp& aTime);
  void NotifyPointerDown();
  void NotifyPointerUp(const TimeStamp& aTime);
  void NotifyPointerCanceled();

  /**
   * Called when a form control is about to dispatch a trusted change event,
   * which is an excluding input for its document.
   */
  static void NotifyChangeEvent(dom::Element* aTarget);

  /**
   * Line slides. While an AutoLineSlide for a block is alive, call WillMove()
   * for each child of the block that is about to be moved by its delta.
   */
  class MOZ_RAII AutoLineSlide final {
   public:
    AutoLineSlide(nsIFrame* aBlock, const nsPoint& aDelta);
    ~AutoLineSlide() {
      if (mTracker) {
        mTracker->mSliding = false;
      }
    }
    void WillMove(nsIFrame* aFrame) {
      if (mTracker) {
        mTracker->WillSlideFrame(mBlock, aFrame, mDelta, mRenderingUpdateCount);
      }
    }

   private:
    LayoutShiftTracker* mTracker = nullptr;
    nsIFrame* mBlock = nullptr;
    nsPoint mDelta;
    uint16_t mRenderingUpdateCount = 0;
  };

  /**
   * Called when the rect of aFrame, which was moved by a line slide since the
   * last report (nsIFrame::IsLayoutShiftSlid()), is about to change.
   */
  void SlidFrameMoving(nsIFrame* aFrame);

  struct OldGeometry {
    // The frame's rect (relative to its parent) before it changed.
    nsRect mOldRect;
    // For scrolled frames, the part of the position change made by scroll
    // anchoring.
    nsPoint mAnchorAdjustment;
    // Whether the frame was hidden by visibility or opacity before.
    Maybe<bool> mWasHidden = Nothing();
  };

  // Children of mBlock that all moved by mDelta through line slides since the
  // last report, and that have nsIFrame::IsLayoutShiftSlid() set. Some may
  // also have their own record (when they moved again later), which takes
  // precedence.
  struct BlockSlide {
    nsIFrame* mBlock;
    nsPoint mDelta;
    nsTArray<nsIFrame*> mFrames;
  };

  static const BlockSlide* FindBlockSlide(const nsTArray<BlockSlide>& aSlides,
                                          const nsIFrame* aBlock);

 private:
  bool IsEmpty() const { return mRecords.IsEmpty() && mBlockSlides.IsEmpty(); }
  void ScheduleReport();

  void WillSlideFrame(nsIFrame* aBlock, nsIFrame* aFrame, const nsPoint& aDelta,
                      uint16_t aRenderingUpdateCount);
  // Gives aFrame, which has IsLayoutShiftSlid() set, its own record.
  void MaterializeSlidFrame(nsIFrame* aFrame);
  void ForgetSlidFrame(nsIFrame* aFrame);
  BlockSlide* FindBlockSlide(const nsIFrame* aBlock);

  // Releases the shifts held back while a pointer was down.
  void EndPendingPointerInteraction(const Maybe<TimeStamp>& aExcludingInput);

  void ClearRecords();

  // Owned by the PresShell that owns us.
  nsPresContext* const mPresContext;
  nsTHashMap<nsPtrHashKey<nsIFrame>, OldGeometry> mRecords;
  // Snapshots for clipping frames only; their lifetime follows mRecords.
  nsTHashMap<nsPtrHashKey<nsIFrame>, Maybe<nsRect>> mOldClips;
  nsTArray<BlockSlide> mBlockSlides;
  // Whether an AutoLineSlide is moving frames. AutoLineSlide only lives
  // around the loop that moves the children of one line, so every move of a
  // slid frame while this is set is that slide's own.
  bool mSliding = false;

  TimeStamp mLastExcludingInput;
  // Shifts are held back while this is nonzero.
  uint32_t mPointersDown = 0;
  // Stops holding back shifts if the pointer interaction doesn't end.
  nsCOMPtr<nsITimer> mPendingPointerTimer;
};

}  // namespace mozilla

#endif  // mozilla_LayoutShiftTracker_h
