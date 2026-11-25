/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef MOZILLA_GFX_RENDERMACIOSURFACETEXTUREHOST_H
#define MOZILLA_GFX_RENDERMACIOSURFACETEXTUREHOST_H

#include "RenderTextureHostSWGL.h"
#include "mozilla/Atomics.h"
#include "mozilla/DataMutex.h"
#include "mozilla/TimeStamp.h"
#include "mozilla/gfx/MacIOSurface.h"
#include "mozilla/layers/GpuFence.h"
#include "mozilla/layers/TextureHostOGL.h"

namespace mozilla {

namespace layers {
class SurfaceDescriptorMacIOSurface;
}  // namespace layers

namespace wr {

// When a video frame is due on screen, and how the native layer showing it
// presents frames. Shared between the frame's TextureHost on the compositor
// thread and its RenderTextureHost on the render thread. WebRenderImageHost
// uses the mode to choose frames ahead of time when the native layer presents
// them at their time.
class FramePresentation final {
 public:
  NS_INLINE_DECL_THREADSAFE_REFCOUNTING(FramePresentation)

  // Null if the frame has no time. Set when the frame is chosen for
  // compositing.
  void SetTime(const TimeStamp& aTime) {
    auto time = mTime.Lock();
    *time = aTime;
  }
  TimeStamp GetTime() {
    auto time = mTime.Lock();
    return *time;
  }

  // Set when a native layer shows the frame.
  enum class Mode : uint32_t { Unknown, Immediate, AtTime };
  void SetMode(Mode aMode) { mMode = aMode; }
  Mode GetMode() const { return mMode; }

 private:
  ~FramePresentation() = default;

  DataMutex<TimeStamp> mTime{"FramePresentation::mTime"};
  Atomic<Mode> mMode{Mode::Unknown};
};

class RenderMacIOSurfaceTextureHost final : public RenderTextureHostSWGL {
 public:
  explicit RenderMacIOSurfaceTextureHost(
      MacIOSurface* aSurface,
      const Maybe<layers::CompositeProcessFencesHolderId>& aFencesHolderId);

  wr::WrExternalImage Lock(uint8_t aChannelIndex, gl::GLContext* aGL) override;
  void Unlock() override;

  gfx::IntSize GetSize(uint8_t aChannelIndex) const;
  GLuint GetGLHandle(uint8_t aChannelIndex) const;

  RenderMacIOSurfaceTextureHost* AsRenderMacIOSurfaceTextureHost() override {
    return this;
  }

  size_t Bytes() override;

  MacIOSurface* GetSurface() { return mSurface; }

  // RenderTextureHostSWGL
  size_t GetPlaneCount() const override;
  gfx::SurfaceFormat GetFormat() const override;
  gfx::ColorDepth GetColorDepth() const override;
  gfx::YUVRangedColorSpace GetYUVColorSpace() const override;
  gfx::TransferFunction GetTransferFunction() const override;
  bool MapPlane(RenderCompositor* aCompositor, uint8_t aChannelIndex,
                PlaneInfo& aPlaneInfo) override;
  void UnmapPlanes() override;

  RefPtr<layers::GpuFence> GetGpuFence();

  void SetFramePresentation(FramePresentation* aFramePresentation) {
    mFramePresentation = aFramePresentation;
  }
  FramePresentation* GetFramePresentation() const { return mFramePresentation; }

  const RefPtr<MacIOSurface> mSurface;
  const Maybe<layers::CompositeProcessFencesHolderId> mFencesHolderId;

 private:
  virtual ~RenderMacIOSurfaceTextureHost();
  void DeleteTextureHandle();

  RefPtr<gl::GLContext> mGL;
  RefPtr<FramePresentation> mFramePresentation;
  GLuint mTextureHandles[3];
};

}  // namespace wr
}  // namespace mozilla

#endif  // MOZILLA_GFX_RENDERMACIOSURFACETEXTUREHOST_H
