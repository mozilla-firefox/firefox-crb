/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "mozilla/LayoutShiftTracker.h"

#include <algorithm>

#include "mozilla/Logging.h"
#include "mozilla/PresShell.h"
#include "mozilla/ReflowOutput.h"
#include "mozilla/ReverseIterator.h"
#include "mozilla/ScopeExit.h"
#include "mozilla/ScrollContainerFrame.h"
#include "mozilla/WritingModes.h"
#include "mozilla/dom/Document.h"
#include "mozilla/dom/LayoutShift.h"
#include "mozilla/dom/LayoutShiftAttribution.h"
#include "mozilla/dom/PerformanceMainThread.h"
#include "nsIFrame.h"
#include "nsIFrameInlines.h"
#include "nsIMemoryReporter.h"
#include "nsLayoutUtils.h"
#include "nsPresContext.h"
#include "nsRefreshDriver.h"
#include "nsRegion.h"

namespace mozilla {

using dom::LayoutShift;
using dom::LayoutShiftAttribution;
using dom::PerformanceMainThread;

static LazyLogModule sLayoutShiftLog("LayoutShift");
MOZ_DEFINE_MALLOC_SIZE_OF(LayoutShiftMallocSizeOf)

// Moves of less than this in both axes are not shifts.
static constexpr int32_t kShiftThresholdCSSPixels = 3;
static constexpr size_t kMaxSources = 5;
namespace {

// The offset of the starting corner (block-start, inline-start) of a box of
// size aSize from its top-left corner.
nsPoint StartingCorner(WritingMode aWM, const nsSize& aSize) {
  return LogicalPoint(aWM, 0, 0).GetPhysicalPoint(aWM, aSize);
}

bool IsScrolledFrame(const nsIFrame* aFrame) {
  return aFrame->Style()->GetPseudoType() ==
         PseudoStyleType::MozScrolledContent;
}

// Rounds (rather than truncates) aLength to whole CSS pixels, like
// Element::ClientWidth() does, so that scores agree with what script computes
// from clientWidth and clientHeight where the viewport isn't a whole number
// of CSS pixels.
nscoord RoundToCSSPixels(nscoord aLength) {
  return nsPresContext::CSSPixelsToAppUnits(
      nsPresContext::AppUnitsToIntCSSPixels(aLength));
}

// Whether aFrame paints anything itself. The spec counts every box, but Chrome
// and the web-platform-tests only count boxes that paint something (see
// child-shift-with-parent.html), which also lets subtrees be culled by their
// ink overflow. SVG content isn't tracked at all, see ProcessFrame.
bool PaintsItself(nsIFrame* aFrame) {
  if (!aFrame->IsVisibleForPainting()) {
    return false;
  }
  if (aFrame->IsTextFrame()) {
    return !aFrame->InkOverflowRectRelativeToSelf().IsEmpty();
  }
  return aFrame->IsReplaced() || aFrame->HasVisibleBoxDecorations() ||
         !aFrame->StyleEffects()->mBoxShadow.IsEmpty();
}

// The overflow clip (at aOffset relative to the visual's root)
// applies to its descendants, intersected with aClip.
Maybe<nsRect> AccumulateClipForDescendants(Maybe<nsRect> aFrameClip,
                                           const nsPoint& aOffset,
                                           const Maybe<nsRect>& aClip) {
  Maybe<nsRect> clip = aFrameClip;
  if (!clip) {
    return aClip;
  }
  *clip += aOffset;
  return Some(aClip ? aClip->Intersect(*clip) : *clip);
}

struct SourceCandidate {
  nsIContent* mContent = nullptr;
  // The first box of mContent that moved, for ordering.
  nsIFrame* mFrame = nullptr;
  nsRect mOldRect;
  nsRect mNewRect;

  // The area of the node impact region, the union of both rects.
  int64_t Area() const {
    return mOldRect.Area() + mNewRect.Area() -
           mOldRect.Intersect(mNewRect).Area();
  }
  // Whether aOther's node impact region is a subset of ours, for the pruning
  // in "report the layout shift sources". Both regions are unions of two
  // rects, so aOther's is within ours iff each of its rects is.
  bool Encloses(const SourceCandidate& aOther) const {
    return EnclosesRect(aOther.mOldRect) && EnclosesRect(aOther.mNewRect);
  }

 private:
  // Whether aRect is within the union of mOldRect and mNewRect, which isn't
  // a rect itself, e.g. when a box slid by less than its height. By
  // inclusion-exclusion, the area of aRect that the two rects cover is all
  // of aRect's area iff aRect is within their union.
  bool EnclosesRect(const nsRect& aRect) const {
    if (aRect.IsEmpty() || mOldRect.Contains(aRect) ||
        mNewRect.Contains(aRect)) {
      return true;
    }
    const nsRect oldPart = mOldRect.Intersect(aRect);
    const nsRect newPart = mNewRect.Intersect(aRect);
    return oldPart.Area() + newPart.Area() -
               oldPart.Intersect(newPart).Area() ==
           aRect.Area();
  }
};

using RecordMap =
    nsTHashMap<nsPtrHashKey<nsIFrame>, LayoutShiftTracker::OldGeometry>;

/**
 * Computes the score and sources of one layout shift from the recorded old
 * rects. Coordinates are relative to the root frame.
 */
class MOZ_STACK_CLASS LayoutShiftScorer final {
 public:
  // aViewport is the layout viewport, relative to the root frame,
  // aViewportSize its size in whole CSS pixels, and aDistanceBase the viewport
  // base distance.
  LayoutShiftScorer(
      const RecordMap& aRecords,
      const nsTHashMap<nsPtrHashKey<nsIFrame>, Maybe<nsRect>>& aOldClips,
      nsIFrame* aRootFrame, const nsRect& aViewport,
      const nsSize& aViewportSize, nscoord aDistanceBase)
      : mRecords(aRecords),
        mOldClips(aOldClips),
        mRootFrame(aRootFrame),
        mViewport(aViewport),
        mViewportSize(aViewportSize),
        mDistanceBase(aDistanceBase),
        mThreshold(kShiftThresholdCSSPixels * AppUnitsPerCSSPixel()),
        mRenderingUpdateCount(uint16_t(aRootFrame->PresContext()
                                           ->RefreshDriver()
                                           ->RenderingUpdateCount())) {}

  void ProcessFrame(nsIFrame* aFrame,
                    const LayoutShiftTracker::OldGeometry& aOld);

  double Score() const;
  nsTArray<SourceCandidate> TakeSources();

  uint32_t ImpactRegionRectCount() const { return mImpactRegion.GetNumRects(); }
  size_t SourceCandidateCount() const { return mSourceCandidates.Length(); }

 private:
  struct AncestorInfo {
    // How much the origin of the frame moved (ignoring transforms).
    nsPoint mOffsetDelta;
    // The current origin of the frame relative to the root frame (ignoring
    // transforms).
    nsPoint mOrigin;
    // For the frame and each of its ancestors that is the scrolled frame of a
    // scroll container, mOffsetDelta of that scrolled frame, minus the part of
    // its move done by scroll anchoring: the index of the innermost one in
    // mScrolledFrameDeltas, or -1.
    int32_t mScrolledFrameDelta = -1;
    // The sum of the position changes of the frame and its ancestors that are
    // scrolled frames, i.e. how much scrolling moved the frame.
    nsPoint mScrollDelta;
    // Whether the frame or any of its ancestors is transformed.
    bool mTransformed = false;
  };

  // State shared by the boxes that move together with one recorded frame.
  struct MovedSubtree {
    // The old origin of each box relative to its current origin.
    nsPoint mOldOrigin;
    // The move of the starting corner of the recorded frame, ignoring
    // scrolling, or zero if it didn't shift (e.g. because a resize kept its
    // starting corner in place), in which case only its descendants may have.
    nsPoint mShift;
  };

  // Maps rects relative to mFrame to the root frame like ClipToViewport, but
  // without walking mFrame's ancestors for each rect if there are no
  // transforms.
  struct VisualMapping {
    nsIFrame* mFrame;
    // Without transforms, the offset of mFrame from the root frame, and the
    // clips of its ancestors and the viewport relative to the root frame.
    Maybe<std::pair<nsPoint, nsRect>> mUntransformed;
    // The previous ancestor clips in root-frame coordinates.
    nsRect mOldClip;
    // See MovedSubtree::mOldOrigin.
    nsPoint mOldOrigin;
  };
  VisualMapping GetMapping(nsIFrame* aFrame, bool aTransformed,
                           const nsPoint& aOldOrigin);
  // Maps aRect (relative to mFrame's current origin, or its old origin if
  // aPrevious) to the root frame, clipped to the viewport.
  nsRect Map(const VisualMapping& aMapping, const nsRect& aRect,
             bool aPrevious = false);

  // Adds the box of aFrame, which moved with aSubtree's recorded frame, and
  // the boxes of its descendants. aOldBox is the old box of aFrame relative to
  // its old origin. aTransformed is whether aFrame or any of its ancestors is
  // transformed.
  void AddVisual(const MovedSubtree& aSubtree, nsIFrame* aFrame,
                 const nsRect& aOldBox, bool aTransformed,
                 bool aDescendantsShifted = true);
  // Adds the boxes of the descendants of aFrame (at aOffset relative to
  // aMapping's frame), clipped by aOldClip and aClip. Descendants whose ink
  // overflow is within aCover can't add anything.
  void AddDescendants(const MovedSubtree& aSubtree,
                      const VisualMapping& aMapping, nsIFrame* aFrame,
                      const nsPoint& aOffset, const Maybe<nsRect>& aOldClip,
                      const Maybe<nsRect>& aClip, const nsRect& aCover);
  // Adds the old and new visual rects (relative to the root frame) of aBox,
  // which shifted by aShift, and returns whether it did.
  bool AddBox(nsIFrame* aBox, const nsRect& aOldVisual,
              const nsRect& aNewVisual, const nsPoint& aShift);

  AncestorInfo GetAncestorInfo(nsIFrame* aFrame);

  // Whether aFrame was hidden in the previous frame, by visibility or opacity.
  bool WasHidden(nsIFrame* aFrame) const {
    if (aFrame->IsLayoutShiftRecorded()) {
      if (auto record = mRecords.Lookup(aFrame)) {
        return record->mWasHidden.valueOr(false);
      }
    }
    return false;
  }

  // Returns how much aFrame moved relative to its parent.
  nsPoint PositionDelta(nsIFrame* aFrame) const {
    if (aFrame->IsLayoutShiftRecorded()) {
      if (auto record = mRecords.Lookup(aFrame)) {
        return aFrame->GetPosition() - record->mOldRect.TopLeft();
      }
    }
    return nsPoint();
  }

  nsPoint AnchorAdjustment(nsIFrame* aFrame) const {
    if (aFrame->IsLayoutShiftRecorded()) {
      if (auto record = mRecords.Lookup(aFrame)) {
        return record->mAnchorAdjustment;
      }
    }
    return nsPoint();
  }

  bool IsBelowThreshold(const nsPoint& aDelta) const {
    return std::abs(aDelta.x) < mThreshold && std::abs(aDelta.y) < mThreshold;
  }

  // Maps aRect (relative to aFrame) to the root frame, clipped by the overflow
  // clips of aFrame's ancestors and the viewport.
  nsRect ClipToViewport(nsIFrame* aFrame, const nsRect& aRect);
  // Maps aRect (relative to aFrame's origin in the previous frame) to the root
  // frame through the old positions of aFrame and its ancestors, with
  // scrolling taken out, and their current transforms. If aClip, also clips
  // by the old overflow clips of the ancestors and the viewport.
  nsRect MapPreviousToRoot(nsIFrame* aFrame, const nsRect& aRect, bool aClip);

  Maybe<nsRect> OldClip(nsIFrame* aFrame,
                        const Maybe<nsRect>& aCurrentClip) const {
    if (aFrame->IsLayoutShiftRecorded() && !mOldClips.IsEmpty()) {
      if (auto clip = mOldClips.Lookup(aFrame)) {
        return clip.Data();
      }
    }
    return aCurrentClip;
  }

  struct AncestorClips {
    nsRect mOld;
    nsRect mNew;
  };
  AncestorClips GetAncestorClips(nsIFrame* aFrame);

  void AddSourceCandidate(nsIContent* aContent, nsIFrame* aFrame,
                          const nsRect& aOldRect, const nsRect& aNewRect);

  const RecordMap& mRecords;
  const nsTHashMap<nsPtrHashKey<nsIFrame>, Maybe<nsRect>>& mOldClips;
  nsIFrame* const mRootFrame;
  const nsRect mViewport;
  const nsSize mViewportSize;
  const nscoord mDistanceBase;
  const nscoord mThreshold;
  const uint16_t mRenderingUpdateCount;

  nsTHashMap<nsPtrHashKey<nsIFrame>, AncestorInfo> mAncestorCache;
  nsTHashMap<nsPtrHashKey<nsIFrame>, AncestorClips> mClipCache;
  // Chains of scrolled frame deltas, shared by the AncestorInfos of frames
  // with common ancestors.
  struct ScrolledFrameDelta {
    nsPoint mDelta;
    // The index of the next outer one, or -1.
    int32_t mOuter;
  };
  nsTArray<ScrolledFrameDelta> mScrolledFrameDeltas;
  nsRegion mImpactRegion;
  nscoord mMaxDistance = 0;
  nsTArray<SourceCandidate> mSourceCandidates;
  nsTHashMap<nsPtrHashKey<nsIContent>, size_t> mSourceCandidateIndices;
};

LayoutShiftScorer::AncestorInfo LayoutShiftScorer::GetAncestorInfo(
    nsIFrame* aFrame) {
  AncestorInfo info;
  AutoTArray<nsIFrame*, 32> uncached;
  for (nsIFrame* f = aFrame; f && f != mRootFrame; f = f->GetParent()) {
    if (auto cached = mAncestorCache.Lookup(f)) {
      info = *cached;
      break;
    }
    uncached.AppendElement(f);
  }
  for (nsIFrame* f : Reversed(uncached)) {
    info.mOffsetDelta += PositionDelta(f);
    info.mOrigin += f->GetPosition();
    info.mTransformed |= f->IsTransformed();
    if (IsScrolledFrame(f)) {
      mScrolledFrameDeltas.AppendElement(ScrolledFrameDelta{
          info.mOffsetDelta - AnchorAdjustment(f), info.mScrolledFrameDelta});
      info.mScrolledFrameDelta = int32_t(mScrolledFrameDeltas.Length() - 1);
      info.mScrollDelta += PositionDelta(f);
    }
    mAncestorCache.InsertOrUpdate(f, info);
  }
  return info;
}

LayoutShiftScorer::AncestorClips LayoutShiftScorer::GetAncestorClips(
    nsIFrame* aFrame) {
  AncestorClips clips{mViewport, mViewport};
  AutoTArray<nsIFrame*, 32> uncached;
  for (nsIFrame* f = aFrame; f && f != mRootFrame; f = f->GetParent()) {
    if (auto cached = mClipCache.Lookup(f)) {
      clips = *cached;
      break;
    }
    uncached.AppendElement(f);
  }
  for (nsIFrame* f : Reversed(uncached)) {
    if (!(f->GetParent() == mRootFrame && f->IsScrollContainerOrSubclass())) {
      const Maybe<nsRect> clip = f->GetClipRectForDescendants();
      const Maybe<nsRect> oldClip = OldClip(f, clip);
      if (clip || oldClip) {
        const AncestorInfo info = GetAncestorInfo(f);
        if (clip) {
          clips.mNew = clips.mNew.Intersect(*clip + info.mOrigin);
        }
        if (oldClip) {
          // As with old box positions, use the current scroll positions.
          clips.mOld = clips.mOld.Intersect(
              *oldClip + info.mOrigin - info.mOffsetDelta + info.mScrollDelta);
        }
      }
    }
    mClipCache.InsertOrUpdate(f, clips);
  }
  return clips;
}

nsRect LayoutShiftScorer::ClipToViewport(nsIFrame* aFrame,
                                         const nsRect& aRect) {
  // Modelled on ComputeTheIntersection in DOMIntersectionObserver.cpp. Unlike
  // its EdgeInclusiveIntersection, touching edges don't count here, since
  // only areas matter.
  nsIFrame* target = aFrame;
  nsRect rect = aRect;
  for (nsIFrame* container = aFrame->GetParent();
       container && container != mRootFrame;
       container = container->GetParent()) {
    if (container->GetParent() == mRootFrame &&
        container->IsScrollContainerOrSubclass()) {
      // The root scroll port is the viewport, which we clip to below.
      continue;
    }
    Maybe<nsRect> clip = container->GetClipRectForDescendants();
    if (!clip) {
      continue;
    }
    rect = nsLayoutUtils::TransformFrameRectToAncestor(target, rect, container)
               .Intersect(*clip);
    if (rect.IsEmpty()) {
      return nsRect();
    }
    target = container;
  }
  rect = nsLayoutUtils::TransformFrameRectToAncestor(target, rect, mRootFrame)
             .Intersect(mViewport);
  return rect.IsEmpty() ? nsRect() : rect;
}

nsRect LayoutShiftScorer::MapPreviousToRoot(nsIFrame* aFrame,
                                            const nsRect& aRect, bool aClip) {
  nsRect rect = aRect;
  nsIFrame* target = aFrame;
  Maybe<gfx::Matrix4x4Flagged> matrix(Some(gfx::Matrix4x4Flagged()));
  for (nsIFrame* frame = aFrame; frame && frame != mRootFrame;) {
    nsIFrame* parent = frame->GetParent();
    if (!parent) {
      break;
    }
    nsPoint offset;
    if (frame->IsTransformed()) {
      nsIFrame* ancestor;
      *matrix = *matrix * frame->GetTransformMatrix(ViewportType::Layout,
                                                    RelativeTo{parent},
                                                    &ancestor, {});
      MOZ_ASSERT(ancestor == parent);
    } else {
      offset = frame->GetPosition();
    }
    // Position changes are in the parent's space, outside this frame's
    // transform.
    if (!IsScrolledFrame(frame)) {
      offset -= PositionDelta(frame);
    }
    const LayoutDevicePoint delta = LayoutDevicePoint::FromAppUnits(
        offset, parent->PresContext()->AppUnitsPerDevPixel());
    matrix->PostTranslate(delta.x, delta.y, 0);
    if (!frame->Combines3DTransformWithAncestors()) {
      matrix->ProjectTo2D();
    }
    if (aClip && parent != mRootFrame &&
        !(parent->GetParent() == mRootFrame &&
          parent->IsScrollContainerOrSubclass())) {
      if (Maybe<nsRect> clip =
              OldClip(parent, parent->GetClipRectForDescendants())) {
        rect = nsLayoutUtils::TransformFrameRectToAncestor(target, rect, parent,
                                                           nullptr, &matrix)
                   .Intersect(*clip);
        if (rect.IsEmpty()) {
          return nsRect();
        }
        target = parent;
        *matrix = gfx::Matrix4x4Flagged();
      }
    }
    frame = parent;
  }
  rect = nsLayoutUtils::TransformFrameRectToAncestor(target, rect, mRootFrame,
                                                     nullptr, &matrix);
  if (aClip) {
    rect = rect.Intersect(mViewport);
  }
  return aClip && rect.IsEmpty() ? nsRect() : rect;
}

void LayoutShiftScorer::ProcessFrame(
    nsIFrame* aFrame, const LayoutShiftTracker::OldGeometry& aOld) {
  if (aFrame->IsStickyPositioned() ||
      aFrame->HasAnyStateBits(NS_FRAME_SVG_LAYOUT) ||
      aFrame->Style()->IsInOpacityZeroSubtree()) {
    return;
  }

  const nsRect newRect = aFrame->GetRect();
  const WritingMode wm = aFrame->GetWritingMode();
  const nsPoint oldCorner = StartingCorner(wm, aOld.mOldRect.Size());
  const nsPoint newCorner = StartingCorner(wm, newRect.Size());
  // The position of a scrolled frame in its scroll container only changes by
  // scrolling, which isn't a shift. Its content still moves with the scroll
  // container, and with its starting corner.
  const nsPoint positionDelta =
      IsScrolledFrame(aFrame) ? nsPoint()
                              : newRect.TopLeft() - aOld.mOldRect.TopLeft();

  // Note that even if we didn't move relative to our parent, we may have moved
  // with an ancestor, and our descendants with us.
  AncestorInfo info = GetAncestorInfo(aFrame->GetParent());
  // How much our origin moved in the viewport, ignoring transforms, which is
  // how much our descendants moved with us. Whether we shifted ourselves
  // depends on our starting corner instead, so a resize can move one without
  // the other.
  const nsPoint originDelta = positionDelta + info.mOffsetDelta;
  const nsPoint cornerDelta = originDelta + newCorner - oldCorner;
  bool originShifted = !IsBelowThreshold(originDelta);
  bool cornerShifted = !IsBelowThreshold(cornerDelta);
  if (!originShifted && !cornerShifted) {
    return;
  }

  // Moves that match the content of one of our scroll containers (taking into
  // account scroll anchoring) are due to scrolling, or to the scroll container
  // itself moving, which is accounted for separately. Through the root scroll
  // container this also ignores moves due to scrolling the document.
  for (int32_t i = info.mScrolledFrameDelta; i >= 0;
       i = mScrolledFrameDeltas[i].mOuter) {
    const nsPoint& scrolled = mScrolledFrameDeltas[i].mDelta;
    originShifted = originShifted && !IsBelowThreshold(originDelta - scrolled);
    cornerShifted = cornerShifted && !IsBelowThreshold(cornerDelta - scrolled);
    if (!originShifted && !cornerShifted) {
      return;
    }
  }

  // Moves are measured with scrolling in the same rendering update taken out,
  // so the old position is mapped to the viewport with the current scroll
  // positions.
  MovedSubtree subtree{
      -(originDelta - info.mScrollDelta),
      cornerShifted ? cornerDelta - info.mScrollDelta : nsPoint()};
  originShifted = originShifted && !IsBelowThreshold(subtree.mOldOrigin);
  if (!originShifted && IsBelowThreshold(subtree.mShift)) {
    return;
  }
  const bool transformed = info.mTransformed || aFrame->IsTransformed();
  if (transformed && !IsBelowThreshold(subtree.mShift)) {
    // TODO: This uses the current transforms for the old position too, so
    // transform changes in the same rendering update aren't accounted for.
    const nsPoint newPoint =
        nsLayoutUtils::TransformFrameRectToAncestor(
            aFrame, nsRect(newCorner, nsSize()), mRootFrame)
            .TopLeft();
    const nsPoint oldPoint =
        MapPreviousToRoot(aFrame, nsRect(oldCorner, nsSize()), false).TopLeft();
    subtree.mShift = newPoint - oldPoint;
    if (!originShifted && IsBelowThreshold(subtree.mShift)) {
      return;
    }
  }

  if (!transformed) {
    // Most moved frames are usually off-screen. The ink overflow covers
    // everything below us that moved with us, so if neither its old nor its
    // new position is in view, skip the more expensive work below (clips only
    // make visual rects smaller).
    const nsPoint origin = info.mOrigin + newRect.TopLeft();
    const nsRect ink = aFrame->InkOverflowRectRelativeToSelf();
    const nsRect oldInk =
        (ink + subtree.mOldOrigin)
            .Union(nsRect(subtree.mOldOrigin, aOld.mOldRect.Size()));
    if (!mViewport.Intersects(ink + origin) &&
        !mViewport.Intersects(oldInk + origin)) {
      return;
    }
  }

  AddVisual(subtree, aFrame, nsRect(nsPoint(), aOld.mOldRect.Size()),
            transformed, originShifted);
}

LayoutShiftScorer::VisualMapping LayoutShiftScorer::GetMapping(
    nsIFrame* aFrame, bool aTransformed, const nsPoint& aOldOrigin) {
  if (aTransformed) {
    return VisualMapping{aFrame, Nothing(), nsRect(), aOldOrigin};
  }
  const AncestorClips clips = GetAncestorClips(aFrame->GetParent());
  return VisualMapping{
      aFrame, Some(std::pair(GetAncestorInfo(aFrame).mOrigin, clips.mNew)),
      clips.mOld, aOldOrigin};
}

nsRect LayoutShiftScorer::Map(const VisualMapping& aMapping,
                              const nsRect& aRect, bool aPrevious) {
  if (!aMapping.mUntransformed) {
    return aPrevious ? MapPreviousToRoot(aMapping.mFrame, aRect, true)
                     : ClipToViewport(aMapping.mFrame, aRect);
  }
  const auto& [offset, clip] = *aMapping.mUntransformed;
  const nsRect rect =
      aPrevious
          ? (aRect + aMapping.mOldOrigin + offset).Intersect(aMapping.mOldClip)
          : (aRect + offset).Intersect(clip);
  return rect.IsEmpty() ? nsRect() : rect;
}

void LayoutShiftScorer::AddVisual(const MovedSubtree& aSubtree,
                                  nsIFrame* aFrame, const nsRect& aOldBox,
                                  bool aTransformed, bool aDescendantsShifted) {
  const VisualMapping mapping =
      GetMapping(aFrame, aTransformed, aSubtree.mOldOrigin);
  if (mapping.mUntransformed && mapping.mUntransformed->second.IsEmpty() &&
      mapping.mOldClip.IsEmpty()) {
    // Clipped out entirely.
    return;
  }
  const nsRect box = aFrame->GetRectRelativeToSelf();
  nsRect cover;
  if (!IsBelowThreshold(aSubtree.mShift) && !WasHidden(aFrame) &&
      PaintsItself(aFrame) &&
      AddBox(aFrame, Map(mapping, aOldBox, true), Map(mapping, box),
             aSubtree.mShift) &&
      aOldBox == box) {
    cover = box;
  }
  if (!aDescendantsShifted || IsBelowThreshold(aSubtree.mOldOrigin)) {
    return;
  }
  // Our descendants moved with our origin, which differs from the move of our
  // starting corner if we were resized.
  MovedSubtree descendants{aSubtree.mOldOrigin, -aSubtree.mOldOrigin};
  if (aTransformed) {
    descendants.mShift = aSubtree.mShift;
    const WritingMode wm = aFrame->GetWritingMode();
    if (StartingCorner(wm, aOldBox.Size()) != StartingCorner(wm, box.Size())) {
      const nsPoint origin =
          nsLayoutUtils::TransformFrameRectToAncestor(
              aFrame, nsRect(nsPoint(), nsSize()), mRootFrame)
              .TopLeft();
      const nsPoint oldOrigin =
          MapPreviousToRoot(aFrame, nsRect(nsPoint(), nsSize()), false)
              .TopLeft();
      descendants.mShift = origin - oldOrigin;
    }
  }
  if (!IsBelowThreshold(descendants.mShift)) {
    AddDescendants(descendants, mapping, aFrame, nsPoint(), Nothing(),
                   Nothing(), cover);
  }
}

void LayoutShiftScorer::AddDescendants(const MovedSubtree& aSubtree,
                                       const VisualMapping& aMapping,
                                       nsIFrame* aFrame, const nsPoint& aOffset,
                                       const Maybe<nsRect>& aOldClip,
                                       const Maybe<nsRect>& aClip,
                                       const nsRect& aCover) {
  const Maybe<nsRect> frameClip = aFrame->GetClipRectForDescendants();
  const Maybe<nsRect> oldFrameClip = OldClip(aFrame, frameClip);
  const Maybe<nsRect> clip =
      AccumulateClipForDescendants(frameClip, aOffset, aClip);
  const Maybe<nsRect> oldClip =
      frameClip == oldFrameClip && aClip == aOldClip
          ? clip
          : AccumulateClipForDescendants(oldFrameClip, aOffset, aOldClip);
  for (const auto& childList : aFrame->ChildLists()) {
    for (nsIFrame* child : childList.mList) {
      // Recorded frames moved relative to us and are processed on their own.
      if (child->IsLayoutShiftRecorded() ||
          !child->CanRecordLayoutShift(mRenderingUpdateCount) ||
          child->IsPlaceholderFrame() ||
          child->Style()->IsInOpacityZeroSubtree()) {
        continue;
      }
      const nsPoint offset = aOffset + child->GetPosition();
      const nsRect ink = child->InkOverflowRect() + offset;
      const nsRect newInk = clip ? ink.Intersect(*clip) : ink;
      const nsRect oldInk = oldClip == clip ? newInk
                            : oldClip       ? ink.Intersect(*oldClip)
                                            : ink;
      if (((oldInk.IsEmpty() && newInk.IsEmpty()) ||
           (aCover.Contains(oldInk) && aCover.Contains(newInk))) &&
          !(child->IsTransformed() &&
            child->Combines3DTransformWithAncestors())) {
        // Can't add anything to the impact region, and wouldn't be a source
        // since it is enclosed by an unstable box that moved with it.
        continue;
      }
      // Preserve-3d participants have empty ink overflow despite painting.
      if (child->IsTransformed()) {
        AddVisual(aSubtree, child, child->GetRectRelativeToSelf(), true);
        continue;
      }
      const nsRect fullBox = child->GetRect() + aOffset;
      const nsRect box = clip ? fullBox.Intersect(*clip) : fullBox;
      const nsRect oldBox = oldClip == clip ? box
                            : oldClip       ? fullBox.Intersect(*oldClip)
                                            : fullBox;
      nsRect cover = aCover;
      if (PaintsItself(child) &&
          AddBox(child, Map(aMapping, oldBox, true), Map(aMapping, box),
                 aSubtree.mShift) &&
          oldBox == box && box.Area() > cover.Area()) {
        cover = box;
      }
      AddDescendants(aSubtree, aMapping, child, offset, oldClip, clip, cover);
    }
  }
}

bool LayoutShiftScorer::AddBox(nsIFrame* aBox, const nsRect& aOldVisual,
                               const nsRect& aNewVisual,
                               const nsPoint& aShift) {
  if (aOldVisual.IsEmpty() && aNewVisual.IsEmpty()) {
    return false;
  }
  if (aOldVisual.IsEmpty() || aNewVisual.IsEmpty()) {
    // Ignore boxes that move in or out of view only in the inline direction.
    const nscoord blockShift =
        aBox->GetWritingMode().IsVertical() ? aShift.x : aShift.y;
    if (std::abs(blockShift) < mThreshold) {
      return false;
    }
  }
  if (!aOldVisual.IsEmpty()) {
    mImpactRegion.OrWith(aOldVisual);
  }
  if (!aNewVisual.IsEmpty()) {
    mImpactRegion.OrWith(aNewVisual);
  }
  mMaxDistance =
      std::max({mMaxDistance, std::abs(aShift.x), std::abs(aShift.y)});
  if (nsIContent* content = aBox->GetContent()) {
    AddSourceCandidate(content, aBox, aOldVisual, aNewVisual);
  }
  return true;
}

void LayoutShiftScorer::AddSourceCandidate(nsIContent* aContent,
                                           nsIFrame* aFrame,
                                           const nsRect& aOldRect,
                                           const nsRect& aNewRect) {
  // A node with several boxes (e.g. text split over several lines) is a
  // single source covering all of them.
  const size_t index =
      mSourceCandidateIndices.LookupOrInsertWith(aContent, [&] {
        mSourceCandidates.AppendElement(SourceCandidate{aContent, aFrame});
        return mSourceCandidates.Length() - 1;
      });
  SourceCandidate& candidate = mSourceCandidates[index];
  candidate.mOldRect = candidate.mOldRect.Union(aOldRect);
  candidate.mNewRect = candidate.mNewRect.Union(aNewRect);
}

double LayoutShiftScorer::Score() const {
  if (mImpactRegion.IsEmpty() || mViewport.IsEmpty()) {
    return 0.0;
  }
  // Compute in CSS pixels so that results for whole-pixel geometry are exactly
  // what script computes from CSS pixel values.
  const double appUnitsPerCSSPixel = AppUnitsPerCSSPixel();
  const double viewportWidth = mViewportSize.width / appUnitsPerCSSPixel;
  const double viewportHeight = mViewportSize.height / appUnitsPerCSSPixel;
  const double impactArea = double(mImpactRegion.Area()) /
                            (appUnitsPerCSSPixel * appUnitsPerCSSPixel);
  const double moveDistance = mMaxDistance / appUnitsPerCSSPixel;
  const double distanceBase = mDistanceBase / appUnitsPerCSSPixel;
  const double impactFraction = impactArea / (viewportWidth * viewportHeight);
  const double distanceFraction =
      distanceBase > 0 ? std::min(1.0, moveDistance / distanceBase) : 0.0;
  return impactFraction * distanceFraction;
}

nsTArray<SourceCandidate> LayoutShiftScorer::TakeSources() {
  // https://wicg.github.io/layout-instability/#sec-layout-shift-attribution:
  // keep the most impactful sources, skipping those whose impact regions are
  // enclosed in those of another source. Candidates are considered in tree
  // order, so that ties are resolved the same way every time.
  std::stable_sort(mSourceCandidates.begin(), mSourceCandidates.end(),
                   [](const SourceCandidate& aA, const SourceCandidate& aB) {
                     return nsLayoutUtils::CompareTreePosition(aA.mFrame,
                                                               aB.mFrame) < 0;
                   });
  nsTArray<SourceCandidate> sources;
  for (const SourceCandidate& candidate : mSourceCandidates) {
    // Step 2.1.
    if (std::any_of(sources.begin(), sources.end(),
                    [&](const SourceCandidate& aSource) {
                      return aSource.Encloses(candidate);
                    })) {
      continue;
    }
    // Step 2.2.
    auto enclosed = std::find_if(sources.begin(), sources.end(),
                                 [&](const SourceCandidate& aSource) {
                                   return candidate.Encloses(aSource);
                                 });
    if (enclosed != sources.end()) {
      *enclosed = candidate;
      continue;
    }
    // Steps 2.3-2.4.
    if (sources.Length() < kMaxSources) {
      sources.AppendElement(candidate);
      continue;
    }
    auto smallest = std::min_element(
        sources.begin(), sources.end(),
        [](const SourceCandidate& aA, const SourceCandidate& aB) {
          return aA.Area() < aB.Area();
        });
    if (smallest->Area() < candidate.Area()) {
      *smallest = candidate;
    }
  }
  // Step 3.
  std::stable_sort(sources.begin(), sources.end(),
                   [](const SourceCandidate& aA, const SourceCandidate& aB) {
                     return aA.Area() > aB.Area();
                   });
  return sources;
}

}  // namespace

LayoutShiftTracker::LayoutShiftTracker(nsPresContext* aPresContext)
    : mPresContext(aPresContext) {
  MOZ_ASSERT(mPresContext);
}

LayoutShiftTracker::~LayoutShiftTracker() { ClearRecords(); }

/* static */
LayoutShiftTracker* LayoutShiftTracker::Get(nsPresContext* aPresContext) {
  if (!aPresContext->LayoutShiftTrackingAllowed()) {
    return nullptr;
  }
  PresShell* presShell = aPresContext->GetPresShell();
  if (!presShell || presShell->IsDestroying()) {
    return nullptr;
  }
  return presShell->EnsureLayoutShiftTracker();
}

/* static */
LayoutShiftTracker::RecordingInfo LayoutShiftTracker::GetForRecording(
    nsPresContext* aPresContext) {
  if (!aPresContext->LayoutShiftTrackingAllowed()) {
    return {};
  }
  nsRefreshDriver* refreshDriver = aPresContext->RefreshDriver();
  PresShell* presShell = aPresContext->GetPresShell();
  if (!refreshDriver || !presShell || presShell->IsDestroying() ||
      presShell->IsPaintingSuppressed()) {
    return {};
  }
  return {presShell->EnsureLayoutShiftTracker(),
          uint16_t(refreshDriver->RenderingUpdateCount())};
}

void LayoutShiftTracker::ScheduleReport() {
  // Layout can be flushed outside of a refresh driver tick, so make sure the
  // report runs in the next one.
  mPresContext->RefreshDriver()->ScheduleRenderingPhase(
      RenderingPhase::ReportLayoutShift);
}

void LayoutShiftTracker::Record(nsIFrame* aFrame, const nsRect& aOldRect) {
  const bool wasEmpty = IsEmpty();
  mRecords.LookupOrInsert(aFrame, OldGeometry{aOldRect, nsPoint()});
  if (Maybe<nsRect> clip = aFrame->GetClipRectForDescendants()) {
    mOldClips.LookupOrInsert(aFrame, clip);
  }
  if (wasEmpty) {
    ScheduleReport();
  }
}

void LayoutShiftTracker::RecordClip(nsIFrame* aFrame) {
  MOZ_ASSERT(aFrame->IsLayoutShiftRecorded());
  mOldClips.LookupOrInsertWith(
      aFrame, [&] { return aFrame->GetClipRectForDescendants(); });
}

void LayoutShiftTracker::NoteVisibilityChange(nsIFrame* aFrame,
                                              bool aWasHidden) {
  if (auto record = mRecords.Lookup(aFrame)) {
    if (!record->mWasHidden) {
      record->mWasHidden = Some(aWasHidden);
    }
  }
}

void LayoutShiftTracker::AddScrollAnchorAdjustment(nsIFrame* aScrolledFrame,
                                                   const nsPoint& aAdjustment) {
  if (auto record = mRecords.Lookup(aScrolledFrame)) {
    record->mAnchorAdjustment += aAdjustment;
  }
}

void LayoutShiftTracker::ClearRecords() {
  for (const auto& entry : mRecords) {
    entry.GetKey()->ClearLayoutShiftRecorded();
  }
  mRecords.Clear();
  mOldClips.Clear();
}

void LayoutShiftTracker::Report() {
  if (IsEmpty()) {
    return;
  }
  auto clearRecords = MakeScopeExit([&] { ClearRecords(); });

  PresShell* presShell = mPresContext->PresShell();
  nsIFrame* rootFrame = presShell->GetRootFrame();
  RefPtr<PerformanceMainThread> performance =
      mPresContext->GetPerformanceMainThread();
  if (!rootFrame || !performance) {
    return;
  }

  // The layout viewport, as documentElement.clientWidth/Height measure it: the
  // scroll port, unless that was expanded to the minimum scale size. Content is
  // clipped by its actual edges, but the fractions use its size in whole CSS
  // pixels, as script computes them, since it isn't a whole number of them at
  // some device scales.
  nsRect viewport;
  if (ScrollContainerFrame* rootScrollContainer =
          presShell->GetRootScrollContainerFrame()) {
    viewport = nsRect(rootScrollContainer->GetScrollPortRect().TopLeft() +
                          rootScrollContainer->GetPosition(),
                      rootScrollContainer->GetLayoutSize());
  } else {
    viewport = rootFrame->GetRectRelativeToSelf();
  }
  const nsSize viewportSize(RoundToCSSPixels(viewport.width),
                            RoundToCSSPixels(viewport.height));
  const nscoord distanceBase =
      std::max(viewportSize.width, viewportSize.height);

  const TimeStamp start = TimeStamp::Now();
  LayoutShiftScorer scorer(mRecords, mOldClips, rootFrame, viewport,
                           viewportSize, distanceBase);
  for (const auto& entry : mRecords) {
    scorer.ProcessFrame(entry.GetKey(), entry.GetData());
  }
  const double score = scorer.Score();
  MOZ_LOG(sLayoutShiftLog, LogLevel::Debug,
          ("Report %p: %u records (%zu table bytes), %u impact region rects, "
           "%zu source candidates, score %g, %.3f ms",
           this, mRecords.Count(),
           mRecords.ShallowSizeOfExcludingThis(LayoutShiftMallocSizeOf),
           scorer.ImpactRegionRectCount(), scorer.SourceCandidateCount(), score,
           (TimeStamp::Now() - start).ToMilliseconds()));
  if (score <= 0.0) {
    return;
  }

  nsTArray<RefPtr<LayoutShiftAttribution>> attributions;
  nsISupports* global = performance->GetParentObject();
  for (const SourceCandidate& source : scorer.TakeSources()) {
    // Pseudo-elements and other native anonymous content are not exposed.
    nsIContent* node = source.mContent->IsInNativeAnonymousSubtree()
                           ? nullptr
                           : source.mContent;
    attributions.AppendElement(MakeRefPtr<LayoutShiftAttribution>(
        global, node, CSSRect::FromAppUnits(source.mOldRect),
        CSSRect::FromAppUnits(source.mNewRect)));
  }

  // The entry's time is when it is created, which is after this rendering
  // update's animation frame callbacks ran, not the refresh tick time.
  const TimeStamp now = TimeStamp::Now();
  RefPtr<LayoutShift> layoutShift = MakeRefPtr<LayoutShift>(
      performance, performance->TimeStampToDOMHighResForRendering(now), score,
      /* aHadRecentInput */ false, /* aLastInputTime */ 0.0,
      std::move(attributions));
  performance->QueueLayoutShiftEntry(layoutShift);
}

}  // namespace mozilla
