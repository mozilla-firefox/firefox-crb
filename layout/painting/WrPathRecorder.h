/* -*- Mode: C++; tab-width: 8; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* vim: set ts=8 sts=2 et sw=2 tw=80: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef LAYOUT_PAINTING_WRPATHRECORDER_H_
#define LAYOUT_PAINTING_WRPATHRECORDER_H_

#include <limits>

#include "mozilla/gfx/2D.h"
#include "mozilla/webrender/WebRenderTypes.h"
#include "nsTArray.h"

namespace mozilla {
namespace wr {
class DisplayListBuilder;
}

// Records the commands of a path, to define a WebRender path clip with them.
class WrPathRecorder final : public gfx::PathBuilder {
 public:
  MOZ_DECLARE_REFCOUNTED_VIRTUAL_TYPENAME(WrPathRecorder, override)

  WrPathRecorder() : PathBuilder(gfx::FillRule::FILL_WINDING) {}

  void MoveTo(const gfx::Point& aPoint) override;
  void LineTo(const gfx::Point& aPoint) override;
  void BezierTo(const gfx::Point& aCP1, const gfx::Point& aCP2,
                const gfx::Point& aCP3) override;
  void QuadraticBezierTo(const gfx::Point& aCP1,
                         const gfx::Point& aCP2) override;
  void Close() override;
  void Arc(const gfx::Point& aOrigin, float aRadius, float aStartAngle,
           float aEndAngle, bool aAntiClockwise) override;

  // The commands are read from the recorder rather than from a Path.
  already_AddRefed<gfx::Path> Finish() override;

  void Reset(gfx::FillRule aFillRule) override;

  void Transform(const gfx::Matrix& aTransform) override;

  gfx::BackendType GetBackendType() const override {
    return gfx::BackendType::NONE;
  }

  bool IsActive() const override { return !mCommands.IsEmpty(); }

  // Whether the recorded path has no point or a non-finite point. Nothing is
  // inside of such a path.
  bool IsEmptyOrNonFinite() const { return mPoints.IsEmpty() || !mAllFinite; }

  // The rect that positions the clip defined by DefineClip. It contains the
  // path and its anti-aliasing. Only valid if !IsEmptyOrNonFinite().
  wr::LayoutRect ClipRect() const;

  // Defines a clip to the inside of the recorded path. Makes the points
  // relative to the clip rect's origin in place, so that a path that only
  // moves keeps interning to the same WebRender path.
  wr::WrClipId DefineClip(wr::DisplayListBuilder& aBuilder,
                          wr::FillRule aFillRule);

 private:
  void BeginSubPath(const gfx::Point& aPoint);
  // Drawing after a Close() resumes from the closed sub-path's first point.
  void EnsureSubPath();
  void EndSubPath();
  void PushPoint(const gfx::Point& aPoint);
  void AccumulateBounds(const gfx::Point& aPoint);
  void ResetBounds();

  static constexpr float kInfinity = std::numeric_limits<float>::infinity();

  nsTArray<wr::PathCommand> mCommands;
  nsTArray<wr::LayoutPoint> mPoints;
  gfx::Point mMin{kInfinity, kInfinity};
  gfx::Point mMax{-kInfinity, -kInfinity};
  bool mAllFinite = true;
  bool mInSubPath = false;
};

}  // namespace mozilla

#endif  // LAYOUT_PAINTING_WRPATHRECORDER_H_
