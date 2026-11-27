/* -*- Mode: C++; tab-width: 8; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* vim: set ts=8 sts=2 et sw=2 tw=80: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "WrPathRecorder.h"

#include <cmath>

#include "mozilla/AppUnits.h"
#include "mozilla/gfx/PathHelpers.h"
#include "mozilla/webrender/WebRenderAPI.h"

namespace mozilla {

void WrPathRecorder::MoveTo(const gfx::Point& aPoint) {
  EndSubPath();
  BeginSubPath(aPoint);
}

void WrPathRecorder::LineTo(const gfx::Point& aPoint) {
  // Like in PathBuilderSkia, a line on an empty path only moves to its end.
  // ArcToBezier relies on this to start arcs without a MoveTo.
  if (mCommands.IsEmpty()) {
    MoveTo(aPoint);
    return;
  }
  EnsureSubPath();
  mCommands.AppendElement(wr::PathCommand::LineTo);
  PushPoint(aPoint);
  mCurrentPoint = aPoint;
}

void WrPathRecorder::BezierTo(const gfx::Point& aCP1, const gfx::Point& aCP2,
                              const gfx::Point& aCP3) {
  EnsureSubPath();
  mCommands.AppendElement(wr::PathCommand::CubicTo);
  PushPoint(aCP1);
  PushPoint(aCP2);
  PushPoint(aCP3);
  mCurrentPoint = aCP3;
}

void WrPathRecorder::QuadraticBezierTo(const gfx::Point& aCP1,
                                       const gfx::Point& aCP2) {
  EnsureSubPath();
  mCommands.AppendElement(wr::PathCommand::QuadraticTo);
  PushPoint(aCP1);
  PushPoint(aCP2);
  mCurrentPoint = aCP2;
}

void WrPathRecorder::Close() {
  if (mInSubPath) {
    mCommands.AppendElement(wr::PathCommand::Close);
    mInSubPath = false;
  }
  mCurrentPoint = mBeginPoint;
}

void WrPathRecorder::Arc(const gfx::Point& aOrigin, float aRadius,
                         float aStartAngle, float aEndAngle,
                         bool aAntiClockwise) {
  gfx::ArcToBezier(this, aOrigin, gfx::Size(aRadius, aRadius), aStartAngle,
                   aEndAngle, aAntiClockwise);
}

already_AddRefed<gfx::Path> WrPathRecorder::Finish() {
  EndSubPath();
  return nullptr;
}

void WrPathRecorder::Reset(gfx::FillRule aFillRule) {
  mCommands.Clear();
  mPoints.Clear();
  mInSubPath = false;
  ResetBounds();
  mFillRule = aFillRule;
}

void WrPathRecorder::Transform(const gfx::Matrix& aTransform) {
  ResetBounds();
  for (auto& point : mPoints) {
    gfx::Point p = aTransform.TransformPoint(gfx::Point(point.x, point.y));
    point = wr::LayoutPoint{p.x, p.y};
    AccumulateBounds(p);
  }
}

wr::LayoutRect WrPathRecorder::ClipRect() const {
  // Path clips are positioned by a rect that also clips their content.
  // Inflate it so that it does not clip the path's anti-aliasing.
  // WebRender stores the origin of the rect in app units, so it is aligned to
  // them: rounding it would move the path, by several device pixels under a
  // large scale.
  auto alignDown = [](float aValue) {
    const float auPerPx = float(AppUnitsPerCSSPixel());
    return std::floor(aValue * auPerPx) / auPerPx;
  };
  return wr::LayoutRect{
      wr::LayoutPoint{alignDown(mMin.x - 1.0f), alignDown(mMin.y - 1.0f)},
      wr::LayoutPoint{mMax.x + 1.0f, mMax.y + 1.0f}};
}

wr::WrClipId WrPathRecorder::DefineClip(wr::DisplayListBuilder& aBuilder,
                                        wr::FillRule aFillRule) {
  MOZ_ASSERT(!mInSubPath, "Finish() must be called first");
  if (IsEmptyOrNonFinite()) {
    return aBuilder.DefineRectClip(Nothing(), wr::LayoutRect{});
  }

  const wr::LayoutRect rect = ClipRect();
  const gfx::Point origin(rect.min.x, rect.min.y);
  for (auto& point : mPoints) {
    point.x -= origin.x;
    point.y -= origin.y;
  }
  const wr::LayoutRect aabb{
      wr::LayoutPoint{mMin.x - origin.x, mMin.y - origin.y},
      wr::LayoutPoint{mMax.x - origin.x, mMax.y - origin.y}};

  return aBuilder.DefinePathClip(mCommands, mPoints, aabb, rect, aFillRule);
}

void WrPathRecorder::BeginSubPath(const gfx::Point& aPoint) {
  mCommands.AppendElement(wr::PathCommand::Begin);
  PushPoint(aPoint);
  mInSubPath = true;
  mBeginPoint = aPoint;
  mCurrentPoint = aPoint;
}

void WrPathRecorder::EnsureSubPath() {
  if (!mInSubPath) {
    BeginSubPath(mCurrentPoint);
  }
}

void WrPathRecorder::EndSubPath() {
  if (mInSubPath) {
    mCommands.AppendElement(wr::PathCommand::End);
    mInSubPath = false;
  }
}

void WrPathRecorder::PushPoint(const gfx::Point& aPoint) {
  mPoints.AppendElement(wr::LayoutPoint{aPoint.x, aPoint.y});
  AccumulateBounds(aPoint);
}

void WrPathRecorder::AccumulateBounds(const gfx::Point& aPoint) {
  mMin.x = std::min(mMin.x, aPoint.x);
  mMin.y = std::min(mMin.y, aPoint.y);
  mMax.x = std::max(mMax.x, aPoint.x);
  mMax.y = std::max(mMax.y, aPoint.y);
  mAllFinite &= std::isfinite(aPoint.x) && std::isfinite(aPoint.y);
}

void WrPathRecorder::ResetBounds() {
  mMin = gfx::Point(kInfinity, kInfinity);
  mMax = gfx::Point(-kInfinity, -kInfinity);
  mAllFinite = true;
}

}  // namespace mozilla
