/* -*- Mode: C++; tab-width: 8; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* vim: set ts=8 sts=2 et sw=2 tw=80: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "AndroidImageReader.h"

#include <android/hardware_buffer.h>
#include <android/native_window_jni.h>
#include <media/NdkImage.h>
#include <media/NdkImageReader.h>
#include <time.h>

#include <algorithm>
#include <limits>
#include <mutex>

#include "GLContext.h"
#include "GLContextEGL.h"
#include "GLContextProvider.h"
#include "GLLibraryEGL.h"
#include "GLReadTexImageHelper.h"
#include "OGLShaderConfig.h"
#include "ScopedGLHelpers.h"
#include "mozilla/DataMutex.h"
#include "mozilla/ProfilerMarkers.h"
#include "mozilla/RemoteMediaManagerParent.h"
#include "mozilla/ScopeExit.h"
#include "mozilla/StaticMutex.h"
#include "mozilla/TaskQueue.h"
#include "mozilla/TimeStamp.h"
#include "mozilla/gfx/2D.h"
#include "mozilla/gfx/Logging.h"
#include "mozilla/java/RemoteSurfaceAllocatorNatives.h"
#include "mozilla/java/RemoteSurfaceAllocatorWrappers.h"
#include "mozilla/java/SurfaceAllocatorNatives.h"
#include "mozilla/java/SurfaceAllocatorWrappers.h"
#include "mozilla/layers/AndroidHardwareBuffer.h"
#include "mozilla/layers/AndroidImageConsumer.h"
#include "mozilla/webrender/RenderThread.h"
#include "nsProxyRelease.h"
#include "nsThreadManager.h"
#include "nsThreadUtils.h"

namespace mozilla {
namespace layers {

static StaticMutex sAImageReadbackMutex;
// Serialize readback and shutdown, including EGL context handoff between
// workers.
static bool sAImageReadbackShuttingDown MOZ_GUARDED_BY(sAImageReadbackMutex) =
    false;
constinit static RefPtr<gl::GLContext> sAImageSnapshotContext
    MOZ_GUARDED_BY(sAImageReadbackMutex);

static void DestroyAImageSnapshotContext() MOZ_REQUIRES(sAImageReadbackMutex) {
  if (!sAImageSnapshotContext) {
    return;
  }

  // Destruction can make the context current to delete GL resources. Keep the
  // EGL display alive and unbind afterwards, including for surfaceless
  // contexts.
  const auto egl = gl::GLContextEGL::Cast(sAImageSnapshotContext)->mEgl;
  sAImageSnapshotContext = nullptr;
  if (!egl->fMakeCurrent(EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT)) {
    gfxCriticalNote
        << "Failed to release destroyed ImageReader snapshot context";
  }
  gl::GLContext::ResetTLSCurrentContext();
}

static void ReleaseAImageSnapshotContext() MOZ_REQUIRES(sAImageReadbackMutex) {
  if (!sAImageSnapshotContext) {
    return;
  }

  const auto egl = gl::GLContextEGL::Cast(sAImageSnapshotContext)->mEgl;
  if (!egl->fMakeCurrent(EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT)) {
    // Never reuse a context which may still be current on another pool worker.
    gfxCriticalNote << "Failed to release ImageReader snapshot context";
    DestroyAImageSnapshotContext();
  }
  gl::GLContext::ResetTLSCurrentContext();
}

static bool EnsureAImageSnapshotContext() MOZ_REQUIRES(sAImageReadbackMutex) {
  if (!sAImageSnapshotContext) {
    nsCString failureId;
    sAImageSnapshotContext =
        gl::GLContextProvider::CreateHeadless({}, &failureId);
    if (!sAImageSnapshotContext) {
      return false;
    }
    // Readback may run on a media pool worker or the canvas thread. The mutex
    // and EGL unbind serialize ownership across those threads.
    sAImageSnapshotContext->mOwningThreadId = Nothing();
  }
  return true;
}

namespace {
constexpr int64_t kDormantFlushFrameAcquisitionWaitMs = 100;

int64_t MonotonicMilliseconds() {
  timespec now{};
  MOZ_RELEASE_ASSERT(clock_gettime(CLOCK_MONOTONIC, &now) == 0);
  return int64_t(now.tv_sec) * 1000 + now.tv_nsec / 1000000;
}

TimeStamp TimeStampFromMonotonicMilliseconds(int64_t aMilliseconds) {
  constexpr int64_t kNanosecondsPerMillisecond = 1'000'000;
  if (aMilliseconds <= 0 ||
      aMilliseconds >
          std::numeric_limits<int64_t>::max() / kNanosecondsPerMillisecond) {
    return TimeStamp();
  }
  // Binder carries CLOCK_MONOTONIC milliseconds. Android's TimeStamp uses
  // the same clock in nanoseconds.
  return TimeStamp::FromSystemTime(aMilliseconds * kNanosecondsPerMillisecond);
}

// The compositor sends a Binder acknowledgment after trying to acquire the
// selected frame, even if acquisition fails. The callback wakes the codec
// task queue so it can flush. The decoder sends End after that flush.
class RemoteDormantFlushReply final {
 public:
  NS_INLINE_DECL_THREADSAFE_REFCOUNTING(RemoteDormantFlushReply)
  explicit RemoteDormantFlushReply(int64_t aRequest) : mRequest(aRequest) {}
  void Complete() {
    MonitorAutoLock lock(mMonitor);
    mComplete = true;
    mMonitor.NotifyAll();
  }
  void WaitUntil(TimeStamp aDeadline) {
    MonitorAutoLock lock(mMonitor);
    while (!mComplete) {
      const auto remaining = aDeadline - TimeStamp::Now();
      if (remaining <= TimeDuration()) {
        return;
      }
      mMonitor.Wait(remaining);
    }
  }
  const int64_t mRequest;

 private:
  ~RemoteDormantFlushReply() = default;
  Monitor mMonitor{"RemoteImageReaderDormantFlush"};
  bool mComplete MOZ_GUARDED_BY(mMonitor) = false;
};

using RemoteDormantFlushReplies =
    std::unordered_map<uint64_t, RefPtr<RemoteDormantFlushReply>>;
MOZ_RUNINIT static StaticDataMutex<RemoteDormantFlushReplies>
    sRemoteDormantFlushReplies("RemoteImageReaderDormantFlushReplies");

RefPtr<RemoteDormantFlushReply> FindRemoteDormantFlushReply(
    uint64_t aReaderId) {
  auto replies = sRemoteDormantFlushReplies.Lock();
  auto it = replies->find(aReaderId);
  // Keep the reply alive after unlocking so Complete() can take its monitor.
  return it != replies->end() ? it->second : nullptr;
}

// Codec-side callbacks are grouped by reader so flush only visits that reader.
using FrameReleaseCallback = SurfaceTextureImage::SetCurrentCallback;
using FrameCallbackMap =
    std::unordered_map<uint64_t, UniquePtr<FrameReleaseCallback>>;
using ReaderFrameMap = std::unordered_map<uint64_t, FrameCallbackMap>;
MOZ_RUNINIT static StaticDataMutex<ReaderFrameMap> sReaderFrames(
    "ImageReaderClientFrames");

/**
 * Owns codec-side frame callbacks for each ImageReader client. Release consumes
 * a callback exactly once. Flush drops callbacks after the decoder has released
 * its codec buffers. Invoke or destroy callbacks outside the registry lock:
 * they can release decoder resources and reenter the client.
 */
class ImageReaderFrameRegistry final {
 public:
  static void RegisterReader(uint64_t aReaderId) {
    auto readers = sReaderFrames.Lock();
    [[maybe_unused]] const bool inserted =
        readers->try_emplace(aReaderId).second;
    MOZ_ASSERT(inserted);
  }

  // Allocator loss is terminal. Removing the entry prevents new callbacks
  // from being registered while the client is still alive.
  static void UnregisterReader(uint64_t aReaderId) {
    FrameCallbackMap discarded;
    {
      auto readers = sReaderFrames.Lock();
      auto it = readers->find(aReaderId);
      if (it == readers->end()) {
        return;
      }
      discarded.swap(it->second);
      readers->erase(it);
    }
  }

  static void RegisterFrame(uint64_t aReaderId, uint64_t aFrameId,
                            UniquePtr<FrameReleaseCallback> aCallback) {
    auto readers = sReaderFrames.Lock();
    auto it = readers->find(aReaderId);
    if (it == readers->end()) {
      return;
    }
    // try_emplace leaves aCallback untouched on a duplicate. Any rejected
    // callback is destroyed after the lock guard above leaves scope.
    [[maybe_unused]] const bool inserted =
        it->second.try_emplace(aFrameId, std::move(aCallback)).second;
    MOZ_ASSERT(inserted);
  }

  static bool HasFrame(uint64_t aReaderId, uint64_t aFrameId) {
    auto readers = sReaderFrames.Lock();
    const auto reader = readers->find(aReaderId);
    return reader != readers->end() &&
           reader->second.find(aFrameId) != reader->second.end();
  }

  static bool ReleaseFrame(uint64_t aReaderId, uint64_t aFrameId,
                           bool aRender) {
    UniquePtr<FrameReleaseCallback> callback;
    {
      auto readers = sReaderFrames.Lock();
      auto reader = readers->find(aReaderId);
      if (reader == readers->end()) {
        return false;
      }
      auto frame = reader->second.find(aFrameId);
      if (frame == reader->second.end()) {
        return false;
      }
      callback = std::move(frame->second);
      reader->second.erase(frame);
    }
    return (*callback)(aRender);
  }

  static void DiscardFrames(uint64_t aReaderId) {
    FrameCallbackMap discarded;
    {
      auto readers = sReaderFrames.Lock();
      auto it = readers->find(aReaderId);
      if (it != readers->end()) {
        discarded.swap(it->second);
      }
    }
  }
};

// JNI entry points for SurfaceAllocator callbacks in the RDD process.
// Forward compositor requests to ImageReaderFrameRegistry to release
// MediaCodec output buffers, optionally rendering them to the output
// Surface. A matching dormancy flush reply wakes the decoder after the
// compositor tries to acquire the selected frame. On disconnect, remove
// the reader's callback registrations and wake any pending flush waiter.
// GPU-process decoders use ImageReaderFrameRegistry directly.
class NativeImageReaderFrames final
    : public java::SurfaceAllocator::Natives<NativeImageReaderFrames> {
 public:
  static bool ReleaseImageReaderFrame(int64_t aReaderId, int64_t aFrameId,
                                      bool aRender) {
    return ImageReaderFrameRegistry::ReleaseFrame(uint64_t(aReaderId),
                                                  uint64_t(aFrameId), aRender);
  }

  static void NotifyImageReaderFlushPrepared(int64_t aReaderId,
                                             int64_t aRequest) {
    auto reply = FindRemoteDormantFlushReply(uint64_t(aReaderId));
    // A late acknowledgment can arrive while the same reader is waiting for
    // a newer request.
    if (reply && reply->mRequest == aRequest) {
      reply->Complete();
    }
  }

  static void DiscardImageReaderFrames(int64_t aReaderId) {
    ImageReaderFrameRegistry::UnregisterReader(uint64_t(aReaderId));
    // The connection is gone. Wake the codec so it can flush without waiting
    // for a reply from the compositor.
    if (auto reply = FindRemoteDormantFlushReply(uint64_t(aReaderId))) {
      reply->Complete();
    }
  }
};

using RemoteReaders = std::unordered_map<int64_t, RefPtr<AndroidImageReader>>;
struct RemoteReaderRegistry {
  // Start closed; Init opens allocation after the compositor map is ready.
  bool mShuttingDown = true;
  RemoteReaders mReaders;
};
MOZ_RUNINIT static StaticDataMutex<RemoteReaderRegistry> sRemoteReaders(
    "RemoteImageReaders");

/**
 * Compositing-process (GPU or parent) JNI implementation of the ImageReader
 * operations exposed by RemoteSurfaceAllocator. Creates and retains the actual
 * AndroidImageReaders, returning their output Surfaces to the RDD process.
 * Allocation handles identify readers for first-frame rendering and disconnect
 * when a remote Surface is released. Rendering holds a strong reader reference
 * and runs without the registry lock so a failed codec release can be reported.
 */
class NativeImageReaderAllocator final
    : public java::RemoteSurfaceAllocator::Natives<NativeImageReaderAllocator> {
 public:
  static jni::Object::LocalRef CreateImageReaderSurface(int64_t aHandle) {
    // Keep the allocation gate locked through creation and registration. This
    // also prevents Shutdown from destroying the compositor map during Create.
    auto readers = sRemoteReaders.Lock();
    if (readers->mShuttingDown) {
      return nullptr;
    }
    if ((!XRE_IsGPUProcess() && !XRE_IsParentProcess()) ||
        !wr::RenderThread::Get()) {
      return nullptr;
    }
    // Tag the allocation handle as remote. GetNext() enforces that local IDs
    // never use this bit. Keep the Java encoding in sync with kRemoteIdBit.
    // See RemoteSurfaceAllocator.REMOTE_IMAGE_READER_ID_BIT.
    RefPtr<AndroidImageReader> reader =
        AndroidImageReader::Create(GpuProcessAndroidImageReaderId{
            uint64_t(aHandle) | GpuProcessAndroidImageReaderId::kRemoteIdBit});
    if (!reader) {
      return nullptr;
    }
    JNIEnv* env = jni::GetEnvForThread();
    auto surface = jni::Object::LocalRef::Adopt(
        env, ANativeWindow_toSurface(env, reader->GetANativeWindow()));
    if (!surface) {
      return nullptr;
    }
    reader->InitRemote(aHandle);
    readers->mReaders.emplace(aHandle, reader);
    return surface;
  }

  static void MaybeRenderImageReaderFirstFrameNative(int64_t aHandle,
                                                     int64_t aFrameId) {
    if (RefPtr<AndroidImageReader> reader = GetReader(aHandle)) {
      reader->MaybeRenderFirstFrame(
          AndroidMediaCodecFrameId{uint64_t(aFrameId)});
    }
  }

  static void NotifyImageReaderFrameReleaseFailedNative(int64_t aHandle,
                                                        int64_t aFrameId) {
    if (RefPtr<AndroidImageReader> reader = GetReader(aHandle)) {
      reader->NotifyRemoteFrameReleaseFailed(
          AndroidMediaCodecFrameId{uint64_t(aFrameId)});
    }
  }

  static void BeginImageReaderDormancyFlushNative(int64_t aHandle,
                                                  int64_t aRequest,
                                                  int64_t aFrameId,
                                                  int64_t aDeadlineMs) {
    if (auto reader = GetReader(aHandle)) {
      reader->BeginRemoteDormancyFlush(
          aRequest, AndroidMediaCodecFrameId{uint64_t(aFrameId)}, aDeadlineMs);
    }
  }

  static void EndImageReaderDormancyFlushNative(int64_t aHandle,
                                                int64_t aRequest) {
    if (auto reader = GetReader(aHandle)) {
      reader->EndRemoteDormancyFlush(aRequest);
    }
  }

  static void DisposeImageReaderSurface(int64_t aHandle, bool aGraceful) {
    RefPtr<AndroidImageReader> reader;
    {
      auto readers = sRemoteReaders.Lock();
      auto it = readers->mReaders.find(aHandle);
      if (it == readers->mReaders.end()) {
        return;
      }
      reader = std::move(it->second);
      readers->mReaders.erase(it);
    }
    // Graceful shutdown can leave a frame available to display users.
    // An unexpected disconnect drops the cached image.
    if (aGraceful) {
      reader->OnDecoderShutdown();
    } else {
      reader->DisconnectRemote();
    }
  }

 private:
  static RefPtr<AndroidImageReader> GetReader(int64_t aHandle) {
    auto readers = sRemoteReaders.Lock();
    auto it = readers->mReaders.find(aHandle);
    return it != readers->mReaders.end() ? it->second : nullptr;
  }
};

// Codec-side client for decoding in the GPU process. It holds a strong
// reference to the reader, calls it directly for first-frame rendering,
// dormancy flush, and decoder shutdown, and can retain it for display.
class LocalAndroidImageReaderClient final : public AndroidImageReaderClient {
 public:
  static already_AddRefed<AndroidImageReaderClient> Create() {
    RefPtr<AndroidImageReader> reader = AndroidImageReader::Create();
    if (!reader) {
      return nullptr;
    }
    JNIEnv* env = jni::GetEnvForThread();
    auto surface = java::sdk::Surface::LocalRef::Adopt(
        env, ANativeWindow_toSurface(env, reader->GetANativeWindow()));
    if (!surface) {
      return nullptr;
    }
    RefPtr<AndroidImageReaderClient> client =
        new LocalAndroidImageReaderClient(reader, surface);
    return client.forget();
  }

  bool BeginDormancyFlush(AndroidMediaCodecFrameId aFrameId) override {
    return mReader->BeginDormancyFlush(aFrameId);
  }
  void EndDormancyFlush() override { mReader->EndDormancyFlush(); }
  void Shutdown() override { mReader->OnDecoderShutdown(); }
  RefPtr<AndroidImageReaderUsage> RetainLocalReaderForDisplay() override {
    return mReader->RetainReaderForDisplay();
  }

 private:
  LocalAndroidImageReaderClient(AndroidImageReader* aReader,
                                java::sdk::Surface::LocalRef aSurface)
      : AndroidImageReaderClient(aReader->mImageReaderId, aSurface),
        mReader(aReader) {}

  ~LocalAndroidImageReaderClient() override { UnregisterReader(); }

  void RenderFirstFrame(AndroidMediaCodecFrameId aFrameId) override {
    mReader->MaybeRenderFirstFrame(aFrameId);
  }

  const RefPtr<AndroidImageReader> mReader;
};

// Codec-side client for decoding in the RDD process. It holds a
// GeckoSurface for the GPU-process reader and uses Binder via
// SurfaceAllocator to request first-frame rendering and coordinate
// dormancy flush. It waits up to the shared deadline for the selected
// frame acquisition attempt before the codec flush, and sends End after
// the flush if Begin was sent. On decoder shutdown, it releases the
// remote Surface allocation.
class RemoteAndroidImageReaderClient final : public AndroidImageReaderClient {
 public:
  static already_AddRefed<AndroidImageReaderClient> Create() {
    // Register JNI callbacks once before requesting a compositor-owned Surface.
    static std::once_flag sNativeMethodsInitialized;
    std::call_once(sNativeMethodsInitialized,
                   [] { NativeImageReaderFrames::Init(); });
    java::GeckoSurface::GlobalRef surface = java::GeckoSurface::LocalRef(
        java::SurfaceAllocator::AcquireImageReaderSurface());
    if (!surface) {
      return nullptr;
    }
    RefPtr<AndroidImageReaderClient> client =
        new RemoteAndroidImageReaderClient(surface);
    return client.forget();
  }

  bool IsValid() const override {
    return AndroidImageReaderClient::IsValid() && !mAllocation->IsReleased();
  }

  bool BeginDormancyFlush(AndroidMediaCodecFrameId aFrameId) override {
    if (!IsValid()) {
      return false;
    }
    const int64_t request = ++mDormantFlushRequest;
    const int64_t deadlineMs =
        MonotonicMilliseconds() + kDormantFlushFrameAcquisitionWaitMs;
    const auto deadline = TimeStampFromMonotonicMilliseconds(deadlineMs);
    MOZ_ASSERT(!deadline.IsNull());
    RefPtr<RemoteDormantFlushReply> reply =
        new RemoteDormantFlushReply(request);
    {
      auto replies = sRemoteDormantFlushReplies.Lock();
      // Register before sending Begin so an immediate acknowledgment has a
      // reply object to signal.
      [[maybe_unused]] const bool inserted =
          replies->emplace(mImageReaderId.mId, reply).second;
      MOZ_ASSERT(inserted);
    }
    const bool sent = java::SurfaceAllocator::BeginImageReaderDormancyFlush(
        mAllocation->GetHandle(), request, int64_t(aFrameId.mId), deadlineMs);
    if (sent) {
      // Share the compositor's absolute deadline. Time spent delivering
      // Begin also counts toward this wait.
      reply->WaitUntil(deadline);
    }
    {
      auto replies = sRemoteDormantFlushReplies.Lock();
      replies->erase(mImageReaderId.mId);
    }
    // End a sent Begin even if the acknowledgment times out. The compositor
    // may already be in State::FlushingForDormancy.
    return sent;
  }

  void EndDormancyFlush() override {
    java::SurfaceAllocator::EndImageReaderDormancyFlush(
        mAllocation->GetHandle(), mDormantFlushRequest);
  }

  void Shutdown() override { Dispose(true); }

 private:
  explicit RemoteAndroidImageReaderClient(
      java::GeckoSurface::GlobalRef aSurface)
      : AndroidImageReaderClient(GpuProcessAndroidImageReaderId{uint64_t(
                                     aSurface->GetImageReaderId())},
                                 aSurface->GetSurface()),
        mAllocation(aSurface) {
    // The base constructor registers the reader. If the allocator loss
    // callback already ran, the released Java Surface lets us detect that
    // and undo the registration.
    if (!IsValid()) {
      UnregisterReader();
    }
  }

  ~RemoteAndroidImageReaderClient() override { Dispose(false); }

  void Dispose(bool aGraceful) {
    UnregisterReader();
    java::SurfaceAllocator::DisposeImageReaderSurface(mAllocation, aGraceful);
  }

  void RenderFirstFrame(AndroidMediaCodecFrameId aFrameId) override {
    AUTO_PROFILER_MARKER_TEXT("RDD ImageReader first frame IPC", MEDIA_PLAYBACK,
                              {}, "Wait for compositor ImageReader"_ns);
    java::SurfaceAllocator::MaybeRenderImageReaderFirstFrame(
        mAllocation->GetHandle(), int64_t(aFrameId.mId));
  }

  const java::GeckoSurface::GlobalRef mAllocation;
  int64_t mDormantFlushRequest = 0;  // Decoder task queue only.
};

}  // namespace

AndroidImageReaderClient::AndroidImageReaderClient(
    GpuProcessAndroidImageReaderId aId, java::sdk::Surface::LocalRef aSurface)
    : mImageReaderId(aId), mOutputSurface(aSurface) {
  ImageReaderFrameRegistry::RegisterReader(mImageReaderId.mId);
}

void AndroidImageReaderClient::UnregisterReader() {
  ImageReaderFrameRegistry::UnregisterReader(mImageReaderId.mId);
}

bool AndroidImageReaderClient::IsValid() const { return bool(mOutputSurface); }

already_AddRefed<AndroidImageReaderClient> AndroidImageReaderClient::Create() {
  if (XRE_IsGPUProcess()) {
    return LocalAndroidImageReaderClient::Create();
  }
  if (XRE_IsRDDProcess()) {
    return RemoteAndroidImageReaderClient::Create();
  }
  return nullptr;
}

java::sdk::Surface::LocalRef AndroidImageReaderClient::GetSurface() const {
  return java::sdk::Surface::LocalRef(mOutputSurface);
}

void AndroidImageReaderClient::OnFrameSelected(
    AndroidMediaCodecFrameId aFrameId) {
  if (!IsValid()) {
    return;
  }
  {
    MutexAutoLock lock(mSelectionMutex);
    if (aFrameId <= mDiscardedThrough) {
      return;
    }
    mSelectedFrameId = Some(aFrameId);
  }
  // Rendering can call into the reader or wait on Binder.
  RenderFirstFrame(aFrameId);
}

AndroidImageReaderClient::CodecFlushGuard::CodecFlushGuard() = default;

AndroidImageReaderClient::CodecFlushGuard::CodecFlushGuard(
    AndroidImageReaderClient* aClient)
    : mClient(aClient) {}

AndroidImageReaderClient::CodecFlushGuard::CodecFlushGuard(
    CodecFlushGuard&&) noexcept = default;

AndroidImageReaderClient::CodecFlushGuard::~CodecFlushGuard() {
  if (mClient) {
    mClient->EndDormancyFlush();
  }
}

AndroidImageReaderClient::CodecFlushGuard
AndroidImageReaderClient::PrepareForDormancyFlush() {
  // Copy the ID under the selection lock, then release the lock before
  // trying to acquire the selected frame, which can wait on the reader or
  // on Binder.
  Maybe<AndroidMediaCodecFrameId> selectedFrameId;
  {
    MutexAutoLock lock(mSelectionMutex);
    selectedFrameId = mSelectedFrameId;
  }
  if (!selectedFrameId || !BeginDormancyFlush(*selectedFrameId)) {
    return {};
  }
  return CodecFlushGuard(this);
}

// Invalidate the codec-side selection and drop this reader's callbacks.
// The decoder has already released the codec buffers through its frame map.
void AndroidImageReaderClient::DiscardFrames() {
  {
    MutexAutoLock lock(mSelectionMutex);
    // Reserve a cutoff ID on the codec task queue, between the IDs for
    // frames created before and after this discard.
    mDiscardedThrough = AndroidMediaCodecFrameId::GetNext();
    mSelectedFrameId.reset();
  }
  ImageReaderFrameRegistry::DiscardFrames(mImageReaderId.mId);
}

void AndroidImageReaderClient::RegisterFrame(
    AndroidMediaCodecFrameId aFrameId,
    UniquePtr<SurfaceTextureImage::SetCurrentCallback> aCallback) {
  if (!IsValid()) {
    return;
  }
  ImageReaderFrameRegistry::RegisterFrame(mImageReaderId.mId, aFrameId.mId,
                                          std::move(aCallback));
}

void AndroidImageReaderClient::ForgetFrame(AndroidMediaCodecFrameId aFrameId) {
  {
    MutexAutoLock lock(mSelectionMutex);
    if (mSelectedFrameId && *mSelectedFrameId == aFrameId) {
      mSelectedFrameId.reset();
    }
  }
  ImageReaderFrameRegistry::ReleaseFrame(mImageReaderId.mId, aFrameId.mId,
                                         false);
}

void AndroidImageReader::InitRemote(int64_t aHandle) {
  MonitorAutoLock lock(mMonitor);
  MOZ_ASSERT(mRemoteState.isNothing());
  mRemoteState.emplace(aHandle);
}

void AndroidImageReader::ClearPendingFrame() {
  mPendingFrameId.reset();
  mWaitingFrameAvailable = false;
}

void AndroidImageReader::NotifyRemoteFrameReleaseFailed(
    AndroidMediaCodecFrameId aFrameId) {
  MonitorAutoLock lock(mMonitor);
  // A failure notification can arrive after the pending request has changed.
  // Clear the request and wake waiters only if the frame ID still matches.
  if (!IsPendingFrame(aFrameId)) {
    return;
  }
  ClearPendingFrame();
  mMonitor.NotifyAll();
}

void AndroidImageReader::DisconnectRemote() {
  // Drop the cached image reference after releasing mMonitor.
  RefPtr<AndroidImageWrapper> image;
  {
    MonitorAutoLock lock(mMonitor);
    image = DisconnectRemoteLocked();
  }
}

RefPtr<AndroidImageWrapper> AndroidImageReader::DisconnectRemoteLocked() {
  MOZ_ASSERT(mRemoteState.isSome());
  mRemoteState->mDisconnected = true;
  ClearPendingFrame();
  mMonitor.NotifyAll();
  return std::move(mCurrentImage);
}

void AndroidImageReader::ExpireRemoteFrame() {
  // Disconnect the reader so a late image cannot be mistaken for a later
  // frame. Images carry no frame ID.
  gfxCriticalNoteOnce << "Remote ImageReader frame timed out";
  RefPtr<AndroidImageWrapper> image = DisconnectRemoteLocked();
  // The last reference can delete the AImage. Keep that native call
  // outside the monitor so reader callbacks can still take it.
  MonitorAutoUnlock unlock(mMonitor);
  image = nullptr;
}

void AndroidImageReader::StartRemoteFrameRequest() {
  MOZ_ASSERT(mRemoteState.isSome());
  // Unlike the notification wait, this deadline spans multiple updates.
  const TimeDuration kRemoteFrameTimeout = TimeDuration::FromSeconds(5);
  mRemoteState->mFrameDeadline = TimeStamp::Now() + kRemoteFrameTimeout;
  mRemoteState->mFrameTimeoutScheduled = false;
}

void AndroidImageReader::HandleRemoteFrameNoBuffer() {
  MOZ_ASSERT(mRemoteState.isSome());
  if (TimeStamp::Now() >= mRemoteState->mFrameDeadline) {
    ExpireRemoteFrame();
    return;
  }
  // Keep recovery armed even if the compositor stops requesting frames.
  ScheduleRemoteFrameTimeout();
}

void AndroidImageReader::ScheduleRemoteFrameTimeout() {
  MOZ_ASSERT(mRemoteState.isSome());
  if (mRemoteState->mFrameTimeoutScheduled) {
    return;
  }
  auto map = GpuProcessAndroidImageReaderMap::Get();
  TaskQueue* target = map ? map->mRemoteFrameTimeoutQueue.get() : nullptr;
  if (!target) {
    return;
  }

  const double remainingMs =
      (mRemoteState->mFrameDeadline - TimeStamp::Now()).ToMilliseconds();
  // DelayedDispatch requires a positive delay. Round up to the next ms.
  const auto delayMs = remainingMs > 0 ? uint32_t(remainingMs) + 1 : 1u;
  mRemoteState->mFrameTimeoutScheduled = NS_SUCCEEDED(target->DelayedDispatch(
      NS_NewRunnableFunction(
          "AndroidImageReader::OnRemoteFrameTimeout",
          [weakReader = ThreadSafeWeakPtr<AndroidImageReader>(this),
           frameId = mPendingFrameId.value(),
           deadline = mRemoteState->mFrameDeadline] {
            if (auto reader =
                    static_cast<RefPtr<AndroidImageReader>>(weakReader)) {
              reader->OnRemoteFrameTimeout(frameId, deadline);
            }
          }),
      delayMs));
}

void AndroidImageReader::OnRemoteFrameTimeout(AndroidMediaCodecFrameId aFrameId,
                                              TimeStamp aDeadline) {
  MonitorAutoLock lock(mMonitor);
  // Delayed tasks can outlive the request that scheduled them. Check both
  // the frame ID and the deadline to match the original request.
  if (mRemoteState.isNothing() || IsStopped() || !IsPendingFrame(aFrameId) ||
      mRemoteState->mFrameDeadline != aDeadline) {
    return;
  }
  mRemoteState->mFrameTimeoutScheduled = false;
  // An update in progress or the end of the flush can rearm the timeout.
  if (mIsPendingNextImage) {
    return;
  }
  // Try acquiring once more before expiring the reader. An acquired image
  // consumes the pending frame even if import fails, so expire only when
  // the queue has no buffer available.
  if (AcquirePendingImage() == AcquireImageResult::NoBufferAvailable) {
    ExpireRemoteFrame();
  }
}

AndroidImageReaderImage::AndroidImageReaderImage(
    AndroidImageReaderClient* aClient, const gfx::IntSize& aSize,
    bool aHasAlpha)
    : Image(nullptr, ImageFormat::ANDROID_IMAGE_READER),
      mImageReaderId(aClient->mImageReaderId),
      mFrameId(AndroidMediaCodecFrameId::GetNext()),
      mSize(aSize),
      mHasAlpha(aHasAlpha),
      mClient(aClient),
      mReaderUsage(aClient->RetainLocalReaderForDisplay()) {}

AndroidImageReaderImage::~AndroidImageReaderImage() {
  mClient->ForgetFrame(mFrameId);
}

Maybe<SurfaceDescriptor> AndroidImageReaderImage::GetDesc() {
  return Nothing();
}

void AndroidImageReaderImage::OnSetCurrent() {
  mClient->OnFrameSelected(mFrameId);
}

nsresult AndroidImageReaderImage::BuildSurfaceDescriptorBuffer(
    SurfaceDescriptorBuffer& aSdBuffer, BuildSdbFlags aFlags,
    const std::function<MemoryOrShmem(uint32_t)>& aAllocate) {
  // RDD only owns a proxy and must never read pixels, including through Binder.
  if (XRE_IsRDDProcess()) {
    return NS_ERROR_NOT_AVAILABLE;
  }
  MOZ_ASSERT(RemoteMediaManagerParent::OnManagerThread());

  StaticMutexAutoLock lock(sAImageReadbackMutex);
  if (sAImageReadbackShuttingDown) {
    return NS_ERROR_NOT_AVAILABLE;
  }

  if (!EnsureAImageSnapshotContext()) {
    return NS_ERROR_FAILURE;
  }

  // CreateHeadless also makes the context current. Unbind on every exit, after
  // ReadTexImage has destroyed its scoped GL resources.
  auto releaseContext = MakeScopeExit([]() MOZ_REQUIRES(sAImageReadbackMutex) {
    ReleaseAImageSnapshotContext();
  });

  auto imageReaderMap = layers::GpuProcessAndroidImageReaderMap::Get();
  if (!imageReaderMap) {
    return NS_ERROR_FAILURE;
  }

  RefPtr<AndroidImageReader> imageReader =
      imageReaderMap->GetImageReader(mImageReaderId);
  if (!imageReader) {
    return NS_ERROR_FAILURE;
  }

  gfx::IntSize size = GetSize();
  // auto format = gfx::SurfaceFormat::R8G8B8X8
  auto format = gfx::SurfaceFormat::B8G8R8A8;

  uint8_t* buffer = nullptr;
  int32_t stride = 0;
  nsresult rv = Image::AllocateSurfaceDescriptorBufferRgb(
      size, format, buffer, aSdBuffer, stride, aAllocate);
  if (NS_FAILED(rv)) {
    return rv;
  }

  RefPtr<gfx::DataSourceSurface> surface;
  surface = gfx::Factory::CreateWrappingDataSourceSurface(buffer, stride, size,
                                                          format);
  if (!surface) {
    return NS_ERROR_FAILURE;
  }

  RefPtr<AndroidImageWrapper> image = imageReader->AcquireImage(mFrameId);
  if (!image || !image->ReadTexImage(sAImageSnapshotContext, surface)) {
    return NS_ERROR_FAILURE;
  }

  return NS_OK;
}

AndroidImageWrapper::AndroidImageWrapper(
    AndroidImageReader* aImageReader, AImage* aImage,
    AHardwareBuffer* aHardwareBuffer, const gfx::IntSize aSize,
    const gfx::SurfaceFormat aFormat, mozilla::UniqueFileHandle&& aWriteFenceFd,
    const gfx::IntRect& aCropRect)
    : mHardwareBuffer(aHardwareBuffer),
      mSize(aSize),
      mCropRect(aCropRect),
      mFormat(aFormat),
      mMutex("AndroidImageWrapper::mMutex"),
      mImageReader(aImageReader),
      mImage(aImage),
      mWriteFenceFd(std::move(aWriteFenceFd)) {
  MOZ_ASSERT(mImageReader);
  mImageReader->OnImageAcquired();
}

AndroidImageWrapper::~AndroidImageWrapper() {
  MutexAutoLock lock(mMutex);

  if (mReadFenceFd) {
    AImage_deleteAsync(mImage, mReadFenceFd.get());
    mReadFenceFd.release();
  } else {
    AImage_delete(mImage);
  }
  mImageReader->OnImageReleased();
}

bool AndroidImageWrapper::WaitForWriteFence(gl::GLContext* aGL) {
  UniqueFileHandle writeFenceFd;
  {
    MutexAutoLock lock(mMutex);
    if (!mWriteFenceFd) {
      return true;
    }
    writeFenceFd =
        ipc::FileDescriptor(mWriteFenceFd.get()).TakePlatformHandle();
  }

  const auto& egl = gl::GLContextEGL::Cast(aGL)->mEgl;
  if (!writeFenceFd ||
      !egl->IsExtensionSupported(gl::EGLExtension::ANDROID_native_fence_sync) ||
      !egl->IsExtensionSupported(gl::EGLExtension::KHR_fence_sync)) {
    gfxCriticalNoteOnce << "Cannot import AndroidImageReader acquire fence";
    return false;
  }

  // EGL takes ownership of the duplicated fence FD.
  const EGLint attrs[] = {LOCAL_EGL_SYNC_NATIVE_FENCE_FD_ANDROID,
                          writeFenceFd.release(), LOCAL_EGL_NONE};
  EGLSync sync =
      egl->fCreateSyncKHR(LOCAL_EGL_SYNC_NATIVE_FENCE_ANDROID, attrs);
  if (!sync) {
    gfxCriticalNoteOnce << "Failed to create AndroidImageReader acquire sync";
    return false;
  }

  const bool waited = egl->IsExtensionSupported(gl::EGLExtension::KHR_wait_sync)
                          ? egl->fWaitSync(sync, 0) == LOCAL_EGL_TRUE
                          : egl->fClientWaitSync(sync, 0, LOCAL_EGL_FOREVER) ==
                                LOCAL_EGL_CONDITION_SATISFIED;
  egl->fDestroySync(sync);
  if (!waited) {
    gfxCriticalNoteOnce
        << "Failed to wait for AndroidImageReader acquire fence";
  }
  return waited;
}

bool AndroidImageWrapper::BindToTexture(gl::GLContext* aGL, GLuint aTexture) {
  const auto& egl = gl::GLContextEGL::Cast(aGL)->mEgl;

  EGLClientBuffer buffer =
      egl->mLib->fGetNativeClientBufferANDROID(mHardwareBuffer);
  if (!buffer) {
    return false;
  }
  const EGLint attrs[] = {LOCAL_EGL_IMAGE_PRESERVED, LOCAL_EGL_TRUE,
                          LOCAL_EGL_NONE};
  EGLImage image = egl->fCreateImage(
      EGL_NO_CONTEXT, LOCAL_EGL_NATIVE_BUFFER_ANDROID, buffer, attrs);
  if (!image) {
    return false;
  }
  aGL->fBindTexture(LOCAL_GL_TEXTURE_EXTERNAL, aTexture);
  aGL->TexParams_SetClampNoMips(LOCAL_GL_TEXTURE_EXTERNAL);
  aGL->fEGLImageTargetTexture2D(LOCAL_GL_TEXTURE_EXTERNAL, image);
  egl->fDestroyImage(image);
  return true;
}

bool AndroidImageWrapper::ReadTexImage(gl::GLContext* aGL,
                                       gfx::DataSourceSurface* aSurface) {
  if (!aGL->MakeCurrent() || !WaitForWriteFence(aGL)) {
    return false;
  }
  gl::ScopedTexture tex(aGL);
  gl::ScopedBindTexture bind(aGL, tex.Texture(), LOCAL_GL_TEXTURE_EXTERNAL);
  if (!BindToTexture(aGL, tex.Texture())) {
    return false;
  }
  const auto config = ShaderConfigFromTargetAndFormat(LOCAL_GL_TEXTURE_EXTERNAL,
                                                      aSurface->GetFormat());
  // Sample the acquired image's crop rectangle and scale it to the
  // destination surface.
  gfx::Matrix4x4 transform;
  transform._11 = float(mCropRect.width) / mSize.width;
  transform._22 = float(mCropRect.height) / mSize.height;
  transform._41 = float(mCropRect.x) / mSize.width;
  transform._42 = float(mCropRect.y) / mSize.height;
  const bool success = aGL->ReadTexImageHelper()->ReadTexImage(
      aSurface, tex.Texture(), LOCAL_GL_TEXTURE_EXTERNAL, aSurface->GetSize(),
      transform, config.mFeatures, /* aYInvert */ false);
  if (!success) {
    // A failed readback may still have submitted a draw using this image.
    aGL->fFinish();
  }
  return success;
}

already_AddRefed<gfx::DataSourceSurface> AndroidImageWrapper::GetAsSurface(
    const gfx::IntSize& aSize, gfx::SurfaceFormat aFormat) {
  StaticMutexAutoLock lock(sAImageReadbackMutex);
  if (sAImageReadbackShuttingDown || !EnsureAImageSnapshotContext()) {
    return nullptr;
  }
  auto releaseContext = MakeScopeExit([]() MOZ_REQUIRES(sAImageReadbackMutex) {
    ReleaseAImageSnapshotContext();
  });
  RefPtr<gfx::DataSourceSurface> surface =
      gfx::Factory::CreateDataSourceSurface(aSize, aFormat, /* aZero */ true);
  if (!surface || !ReadTexImage(sAImageSnapshotContext, surface)) {
    return nullptr;
  }
  return surface.forget();
}

bool AndroidImageWrapper::SetReadFenceFd(UniqueFileHandle&& aFenceFd) {
  if (!aFenceFd) {
    return true;
  }

  UniqueFileHandle fence = std::move(aFenceFd);
  MutexAutoLock lock(mMutex);
  if (!mReadFenceFd) {
    mReadFenceFd = std::move(fence);
    return true;
  }

  auto merged = AndroidHardwareBuffer::TryMergeFences(mReadFenceFd, fence);
  if (!merged) {
    gfxCriticalNoteOnce << "Failed to merge AndroidImageReader read fences";
    return false;
  }
  mReadFenceFd = std::move(merged);
  return true;
}

/* static */
already_AddRefed<AndroidImageReader> AndroidImageReader::Create(
    GpuProcessAndroidImageReaderId aId) {
  if ((!XRE_IsGPUProcess() && !XRE_IsParentProcess()) ||
      !wr::RenderThread::Get()) {
    MOZ_ASSERT_UNREACHABLE("unexpected to be called");
    return nullptr;
  }

  auto imageReaderMap = layers::GpuProcessAndroidImageReaderMap::Get();
  if (!imageReaderMap) {
    return nullptr;
  }

  RefPtr<AndroidImageReader> imageReader = new AndroidImageReader(aId);
  bool ret = imageReader->Init();
  if (!ret) {
    return nullptr;
  }

  imageReaderMap->Register(imageReader);
  imageReader->mRegistered = true;

  return imageReader.forget();
}

AndroidImageReader::AndroidImageReader(GpuProcessAndroidImageReaderId aId)
    : mImageReaderId(aId.IsValid() ? aId
                                   : GpuProcessAndroidImageReaderId::GetNext()),
      mMonitor("mozilla.layers.AndroidImageReader.mMonitor") {}

AndroidImageReader::~AndroidImageReader() {
  auto imageReaderMap = layers::GpuProcessAndroidImageReaderMap::Get();
  if (imageReaderMap && mRegistered) {
    imageReaderMap->Unregister(mImageReaderId);
  }
  ReleaseResources();
}

AndroidImageReaderUsage::AndroidImageReaderUsage(AndroidImageReader* aReader)
    : mReader(aReader) {}

AndroidImageReaderUsage::~AndroidImageReaderUsage() {
  mReader->ReleaseDisplayUsage();
}

RefPtr<AndroidImageReaderUsage> AndroidImageReaderUsage::GetForId(
    GpuProcessAndroidImageReaderId aReaderId) {
  auto map = GpuProcessAndroidImageReaderMap::Get();
  RefPtr<AndroidImageReader> reader =
      map ? map->GetImageReader(aReaderId) : nullptr;
  return reader ? reader->RetainReaderForDisplay() : nullptr;
}

RefPtr<AndroidImageReaderUsage> AndroidImageReader::RetainReaderForDisplay() {
  RefPtr<AndroidImageReaderUsage> usage = new AndroidImageReaderUsage(this);
  MonitorAutoLock lock(mMonitor);
  ++mDisplayUsages;
  return usage;
}

void AndroidImageReader::ReleaseDisplayUsage() {
  RefPtr<AndroidImageWrapper> image;
  {
    MonitorAutoLock lock(mMonitor);
    MOZ_ASSERT(mDisplayUsages);
    --mDisplayUsages;
    if (!mDisplayUsages && mState == State::Shutdown) {
      image.swap(mCurrentImage);
    }
  }
  // The wrapper holds a reader reference. Break the cycle outside the monitor.
}

bool AndroidImageReader::HasCurrentFrame(
    AndroidMediaCodecFrameId aFrameId) const {
  return mCurrentImage && mCurrentFrameId == aFrameId;
}

bool AndroidImageReader::HasCachedSelectedFrame() const {
  return mSelectedFrameId.isSome() && HasCurrentFrame(mSelectedFrameId.value());
}

// Same-process decoder entry points.
bool AndroidImageReader::BeginDormancyFlush(AndroidMediaCodecFrameId aFrameId) {
  MonitorAutoLock lock(mMonitor);
  MOZ_ASSERT(mRemoteState.isNothing());
  if (!CanUpdate(State::Running)) {
    return false;
  }
  const auto deadline =
      TimeStamp::Now() +
      TimeDuration::FromMilliseconds(kDormantFlushFrameAcquisitionWaitMs);
  BeginDormancyFlushLocked(lock, aFrameId, deadline);
  return true;
}

void AndroidImageReader::EndDormancyFlush() {
  MonitorAutoLock lock(mMonitor);
  MOZ_ASSERT(mRemoteState.isNothing());
  EndDormancyFlushLocked();
}

// Selected frame acquisition and state transitions shared by both paths.
void AndroidImageReader::BeginDormancyFlushLocked(
    const MonitorAutoLock& aProofOfLock, AndroidMediaCodecFrameId aFrameId,
    TimeStamp aFrameAcquisitionDeadline) {
  MOZ_ASSERT(CanUpdate(State::Running));
  mSelectedFrameId = Some(aFrameId);
  mState = State::FlushingForDormancy;
  // Wake ordinary acquisition attempts so they can see the state change.
  mMonitor.NotifyAll();

  // Try to acquire the selected frame while updates are allowed and the
  // frame is missing from the cache.
  const auto shouldAcquireSelectedFrame = [&]() MOZ_REQUIRES(mMonitor) {
    return CanUpdate(State::FlushingForDormancy) && !HasCurrentFrame(aFrameId);
  };
  const auto retryDelay = TimeDuration::FromMilliseconds(1);
  while (shouldAcquireSelectedFrame() &&
         TimeStamp::Now() < aFrameAcquisitionDeadline) {
    AcquireFrame(aProofOfLock, aFrameId, State::FlushingForDormancy,
                 CachePolicy::EvictOnFull, aFrameAcquisitionDeadline);
    if (!shouldAcquireSelectedFrame()) {
      return;
    }
    // A local frame cannot arrive once both its codec callback and any
    // outstanding submission are gone. RDD owns the remote callbacks.
    if (mRemoteState.isNothing() && mPendingFrameId.isNothing() &&
        !ImageReaderFrameRegistry::HasFrame(mImageReaderId.mId, aFrameId.mId)) {
      return;
    }
    const auto remaining = aFrameAcquisitionDeadline - TimeStamp::Now();
    if (remaining <= TimeDuration()) {
      return;
    }
    // Retry while a buffer or an acquisition slot can still become available.
    mMonitor.Wait(std::min(remaining, retryDelay));
  }
}

void AndroidImageReader::EndDormancyFlushLocked() {
  if (mState != State::FlushingForDormancy) {
    return;
  }
  mState = State::Running;
  mMonitor.NotifyAll();
}

// RDD decoder entry points and timeout handling.
void AndroidImageReader::BeginRemoteDormancyFlush(
    int64_t aRequest, AndroidMediaCodecFrameId aFrameId, int64_t aDeadlineMs) {
  MonitorAutoLock lock(mMonitor);
  MOZ_ASSERT(mRemoteState.isSome());
  if (!CanUpdate(State::Running) ||
      aRequest <= mRemoteState->mLastDormantFlushRequest) {
    return;
  }
  mRemoteState->mLastDormantFlushRequest = aRequest;
  // Use the RDD deadline so delivering Begin counts against the time allowed
  // for frame acquisition.
  const auto deadline = TimeStampFromMonotonicMilliseconds(aDeadlineMs);
  const auto now = TimeStamp::Now();
  if (deadline.IsNull() || deadline <= now) {
    return;
  }
  const auto latestFrameAcquisitionDeadline =
      now + TimeDuration::FromMilliseconds(kDormantFlushFrameAcquisitionWaitMs);
  BeginDormancyFlushLocked(lock, aFrameId,
                           std::min(deadline, latestFrameAcquisitionDeadline));
  // Keep ordinary acquisition blocked after trying to acquire the selected
  // frame. RDD still needs to release output buffers and flush MediaCodec.
  // Wait for End before allowing ordinary acquisition again.
  ScheduleRemoteDormantFlushTimeout(aRequest);
}

void AndroidImageReader::EndRemoteDormancyFlush(int64_t aRequest) {
  MonitorAutoLock lock(mMonitor);
  MOZ_ASSERT(mRemoteState.isSome());
  if (IsStopped() || aRequest < mRemoteState->mLastDormantFlushRequest) {
    return;
  }
  // Record End even without an active flush. A late Begin for this request
  // must not reopen it.
  mRemoteState->mLastDormantFlushRequest = aRequest;

  // A remote frame can still be outstanding after the acquisition deadline.
  // Arm its timeout before allowing ordinary updates again.
  if (mState == State::FlushingForDormancy && mPendingFrameId.isSome()) {
    ScheduleRemoteFrameTimeout();
  }
  EndDormancyFlushLocked();
}

void AndroidImageReader::ScheduleRemoteDormantFlushTimeout(int64_t aRequest) {
  auto map = GpuProcessAndroidImageReaderMap::Get();
  TaskQueue* target = map ? map->mRemoteFrameTimeoutQueue.get() : nullptr;
  if (!target) {
    return;
  }

  // Use the same background queue as the frame timeout. This separate timer
  // gives the RDD codec time to finish flushing and send End.
  constexpr uint32_t kDormantFlushEndTimeoutMs = 5000;
  (void)target->DelayedDispatch(
      NS_NewRunnableFunction(
          "AndroidImageReader::OnRemoteDormantFlushTimeout",
          [weakReader = ThreadSafeWeakPtr<AndroidImageReader>(this), aRequest] {
            if (auto reader =
                    static_cast<RefPtr<AndroidImageReader>>(weakReader)) {
              reader->OnRemoteDormantFlushTimeout(aRequest);
            }
          }),
      kDormantFlushEndTimeoutMs);
}

void AndroidImageReader::OnRemoteDormantFlushTimeout(int64_t aRequest) {
  RefPtr<AndroidImageWrapper> image;
  {
    MonitorAutoLock lock(mMonitor);
    MOZ_ASSERT(mRemoteState.isSome());
    if (!CanUpdate(State::FlushingForDormancy) ||
        aRequest != mRemoteState->mLastDormantFlushRequest) {
      return;
    }
    // Without End, the producer may still be flushing. Disconnect the remote
    // reader and drop its cache. Release the image after unlocking the monitor.
    gfxCriticalNoteOnce << "Remote ImageReader flush did not complete";
    image = DisconnectRemoteLocked();
  }
}

void AndroidImageReader::OnDecoderShutdown() {
  RefPtr<AndroidImageWrapper> image;
  {
    MonitorAutoLock lock(mMonitor);
    mState = State::Shutdown;
    if (mRemoteState.isSome()) {
      // The remote producer has shut down. Discard its pending submission.
      ClearPendingFrame();
    }
    // Keep the cached frame for existing display users. If they still hold
    // the reader, the last AndroidImageReaderUsage releases this cache entry.
    if (!mDisplayUsages) {
      image.swap(mCurrentImage);
    }
    mMonitor.NotifyAll();
  }
}

bool AndroidImageReader::Init() {
  MonitorAutoLock lock(mMonitor);

  MOZ_ASSERT(!mInited);

  // Set the width, height and format to some default value. This parameters
  // are/maybe overriden by the producer sending buffers to this imageReader's
  // Surface.
  const int32_t width = 1, height = 1;
  uint64_t usage = AHARDWAREBUFFER_USAGE_GPU_SAMPLED_IMAGE;

  // XXX set if video could be used for overlay.
  // usage |= AHARDWAREBUFFER_USAGE_COMPOSER_OVERLAY;

  media_status_t result;
  AImageReader* reader = nullptr;
  result = AImageReader_newWithUsage(width, height, AIMAGE_FORMAT_PRIVATE,
                                     usage, mMaxImageCount, &reader);
  if (result != AMEDIA_OK) {
    gfxCriticalNoteOnce << "AImageReader_newWithUsage failed"
                        << static_cast<int32_t>(result);
    return false;
  }

  mAImageReader = reader;

  ANativeWindow* window = nullptr;
  result = AImageReader_getWindow(reader, &window);
  if (result != AMEDIA_OK) {
    gfxCriticalNoteOnce << "AImageReader_getWindow failed"
                        << static_cast<int32_t>(result);
    return false;
  }
  mNativeWindow = window;

  auto listener = std::make_unique<AImageReader_ImageListener>();
  listener->context = reinterpret_cast<void*>(this);
  listener->onImageAvailable = &AndroidImageReader::OnFrameAvailable;

  result = AImageReader_setImageListener(reader, listener.get());
  if (result != AMEDIA_OK) {
    gfxCriticalNoteOnce << "setImageListener failed"
                        << static_cast<int32_t>(result);
    return false;
  }

  MOZ_ASSERT(mAImageReader);
  MOZ_ASSERT(mNativeWindow);
  mInited = true;

  return true;
}

void AndroidImageReader::ReleaseResources() {
  AImageReader* reader = nullptr;
  {
    MonitorAutoLock lock(mMonitor);
    reader = mAImageReader;
    mAImageReader = nullptr;
    // The native window is owned by AImageReader.
    mNativeWindow = nullptr;
  }
  if (!reader) {
    return;
  }

  // Deletion stops the callback thread. Do not hold the monitor that an
  // in-flight OnFrameAvailable callback needs to finish.
  AImageReader_setImageListener(reader, nullptr);
  AImageReader_delete(reader);
}

/* static */
void AndroidImageReader::OnFrameAvailable(void* aContext,
                                          AImageReader* aReader) {
  auto* reader = static_cast<AndroidImageReader*>(aContext);

  reader->NotifyFrameAvailable();
}

void AndroidImageReader::NotifyFrameAvailable() {
  MonitorAutoLock lock(mMonitor);
  if (IsStopped()) {
    return;
  }
  // The notification wakes the waiter. Acquisition uses the pending frame
  // ID to associate the buffer with the codec frame.
  mWaitingFrameAvailable = false;
  mMonitor.NotifyAll();
}

RefPtr<AndroidImageWrapper> AndroidImageReader::AcquireImage(
    AndroidMediaCodecFrameId aFrameId) {
  MonitorAutoLock lock(mMonitor);
  UpdateImage(lock, aFrameId, CachePolicy::EvictOnFull);
  if (IsRemoteDisconnected() || !HasCurrentFrame(aFrameId)) {
    return nullptr;
  }
  return mCurrentImage;
}

RefPtr<AndroidImageWrapper> AndroidImageReader::AcquireImageForCanvas(
    AndroidMediaCodecFrameId aFrameId) {
  // Declare the fallback before the lock so its reference is released after
  // unlocking.
  RefPtr<AndroidImageWrapper> fallback;
  MonitorAutoLock lock(mMonitor);
  if (IsStopped()) {
    return nullptr;
  }
  // Retain the cached image in case it is cleared while waiting.
  fallback = mCurrentImage;
  UpdateImage(lock, aFrameId, CachePolicy::PreserveOnFull);
  if (IsStopped()) {
    return nullptr;
  }
  return mCurrentImage ? mCurrentImage : fallback;
}

void AndroidImageReader::MaybeRenderFirstFrame(
    AndroidMediaCodecFrameId aFrameId) {
  MonitorAutoLock lock(mMonitor);
  if (mRemoteState.isNothing() && mState == State::Running) {
    mSelectedFrameId = Some(aFrameId);
    mMonitor.NotifyAll();
  }
  if (!mCurrentImage) {
    UpdateImage(lock, aFrameId, CachePolicy::EvictOnFull);
  }
}

void AndroidImageReader::UpdateImage(const MonitorAutoLock& aProofOfLock,
                                     AndroidMediaCodecFrameId aFrameId,
                                     CachePolicy aCachePolicy) {
  if (mRemoteState.isNothing() && mState == State::Shutdown) {
    if (mDisplayUsages && !HasCurrentFrame(aFrameId)) {
      TryAcquireSubmittedFrame(aFrameId, aCachePolicy);
    }
    return;
  }
  AcquireFrame(aProofOfLock, aFrameId, State::Running, aCachePolicy);
}

void AndroidImageReader::AcquireFrame(
    const MonitorAutoLock& aProofOfLock, AndroidMediaCodecFrameId aFrameId,
    State aExpectedState, CachePolicy aCachePolicy,
    const TimeStamp& aFrameAcquisitionDeadline) {
  MOZ_ASSERT(mAcquiredImageCount.load() <= mMaxImageCount);
  const bool remote = mRemoteState.isSome();
  // For RDD, the last acquired ID prevents a duplicate request even after
  // cache eviction. A local reader checks for the matching cached image.
  const auto shouldAcquireRequestedFrame = [&]() MOZ_REQUIRES(mMonitor) {
    return CanUpdate(aExpectedState) &&
           !(remote ? mCurrentFrameId == aFrameId : HasCurrentFrame(aFrameId));
  };
  if (!shouldAcquireRequestedFrame()) {
    return;
  }

  // Only one thread can update the reader at a time.
  const auto updateWait = TimeDuration::FromMilliseconds(20);
  while (mIsPendingNextImage && CanUpdate(aExpectedState)) {
    const TimeDuration timeout =
        aFrameAcquisitionDeadline.IsNull()
            ? updateWait
            : aFrameAcquisitionDeadline - TimeStamp::Now();
    if (timeout <= TimeDuration()) {
      return;
    }
    CVStatus status = mMonitor.Wait(timeout);
    if (status == CVStatus::Timeout) {
      gfxCriticalNoteOnce << "Pending next image wait timeout";
      return;
    }
  }
  if (!CanUpdate(aExpectedState)) {
    return;
  }
  MOZ_ASSERT(!mIsPendingNextImage);

  auto scopeExit = MakeScopeExit([&]() MOZ_REQUIRES(mMonitor) {
    mIsPendingNextImage = false;
    mMonitor.NotifyAll();
  });

  mIsPendingNextImage = true;

  // Bound the total notification wait in this call, including an older frame
  // left outstanding by a previous timeout.
  const TimeStamp notificationDeadline = aFrameAcquisitionDeadline.IsNull()
                                             ? TimeStamp::Now() + updateWait
                                             : aFrameAcquisitionDeadline;

  while (shouldAcquireRequestedFrame()) {
    if (mPendingFrameId.isNothing()) {
      if (!remote && !ImageReaderFrameRegistry::HasFrame(mImageReaderId.mId,
                                                         aFrameId.mId)) {
        return;
      }
      if (aCachePolicy == CachePolicy::PreserveOnFull &&
          mAcquiredImageCount.load() >= mMaxImageCount) {
        return;
      }
      if (aExpectedState == State::FlushingForDormancy &&
          (!EnsureImageCapacity(aCachePolicy) || !CanUpdate(aExpectedState))) {
        return;
      }
      if (!aFrameAcquisitionDeadline.IsNull() &&
          TimeStamp::Now() >= aFrameAcquisitionDeadline) {
        return;
      }
      MOZ_ASSERT(!mWaitingFrameAvailable);
      mPendingFrameId = Some(aFrameId);
      mWaitingFrameAvailable = true;
      if (mRemoteState.isSome()) {
        StartRemoteFrameRequest();
      }
      const bool released = MaybeReleaseFrameToCodec(aProofOfLock, aFrameId,
                                                     /* aRender */ true);
      // The callback ran with the monitor unlocked. Clear a failed submission
      // only if it still matches, even if a flush has started in the meantime.
      if (!released && IsPendingFrame(aFrameId)) {
        ClearPendingFrame();
      }
      if (!CanUpdate(aExpectedState) || !IsPendingFrame(aFrameId)) {
        return;
      }
    }

    WaitForFrameNotification(notificationDeadline, aExpectedState);

    // The wait releases the monitor. Recheck that updates are still allowed
    // in the expected state and a frame is still pending.
    if (!CanUpdate(aExpectedState)) {
      return;
    }

    if (mPendingFrameId.isNothing()) {
      // RDD reported that the codec did not release the pending frame.
      return;
    }

    // OnFrameAvailable does not carry a frame ID. Consume the outstanding
    // frame before releasing another, even when aFrameId has since changed.
    const bool hasCapacity = EnsureImageCapacity(aCachePolicy);
    // Evicting the cached image can drop the monitor and let Binder callbacks
    // clear the request or disconnect the reader.
    if (!CanUpdate(aExpectedState) || !hasCapacity ||
        mPendingFrameId.isNothing()) {
      return;
    }
    const auto result = AcquirePendingImage();
    if (result == AcquireImageResult::Success) {
      continue;
    }

    if (remote && result == AcquireImageResult::NoBufferAvailable) {
      HandleRemoteFrameNoBuffer();
    }
    return;
  }
}

void AndroidImageReader::WaitForFrameNotification(TimeStamp aDeadline,
                                                  State aExpectedState) {
  while (mWaitingFrameAvailable && CanUpdate(aExpectedState)) {
    const TimeDuration remaining = aDeadline - TimeStamp::Now();
    if (remaining <= TimeDuration()) {
      gfxCriticalNoteOnce << "UpdateTexImage wait timeout";
      // The caller still tries to acquire the image in case it was queued
      // before the notification arrived.
      return;
    }
    mMonitor.Wait(remaining);
  }
}

static Maybe<gfx::IntRect> GetImageCropRect(AImage* aImage,
                                            const gfx::IntSize& aSize) {
  AImageCropRect crop;
  if (aSize.IsEmpty() || AImage_getCropRect(aImage, &crop) != AMEDIA_OK ||
      crop.left < 0 || crop.top < 0 || crop.right <= crop.left ||
      crop.bottom <= crop.top || crop.right > aSize.width ||
      crop.bottom > aSize.height) {
    return Nothing();
  }
  return Some(gfx::IntRect(crop.left, crop.top, crop.right - crop.left,
                           crop.bottom - crop.top));
}

void AndroidImageReader::TryAcquireSubmittedFrame(
    AndroidMediaCodecFrameId aFrameId, CachePolicy aCachePolicy) {
  if (mIsPendingNextImage || !IsPendingFrame(aFrameId)) {
    return;
  }
  mIsPendingNextImage = true;
  auto finish = MakeScopeExit([&]() MOZ_REQUIRES(mMonitor) {
    mIsPendingNextImage = false;
    mMonitor.NotifyAll();
  });
  if (EnsureImageCapacity(aCachePolicy) && IsPendingFrame(aFrameId)) {
    AcquirePendingImage();
  }
}

void AndroidImageReader::OnImageAcquired() { ++mAcquiredImageCount; }

void AndroidImageReader::OnImageReleased() { --mAcquiredImageCount; }

bool AndroidImageReader::EnsureImageCapacity(CachePolicy aCachePolicy) {
  MOZ_ASSERT(mIsPendingNextImage);
  if (mAcquiredImageCount.load() < mMaxImageCount) {
    return true;
  }
  // Respect the canvas fallback policy and retain the selected image during
  // a dormancy flush or after the producer shuts down.
  if (aCachePolicy == CachePolicy::PreserveOnFull ||
      (mState != State::Running && HasCachedSelectedFrame())) {
    return false;
  }
  RefPtr<AndroidImageWrapper> image;
  image.swap(mCurrentImage);
  {
    // Dropping the cache reference can delete the AImage. Unlock for
    // deletion, then check the slot count with the monitor held again.
    MonitorAutoUnlock unlock(mMonitor);
    image = nullptr;
  }
  return mAcquiredImageCount.load() < mMaxImageCount;
}

AndroidImageReader::AcquireImageResult
AndroidImageReader::AcquirePendingImage() {
  if (IsRemoteDisconnected()) {
    return AcquireImageResult::Failure;
  }
  MOZ_ASSERT(mPendingFrameId.isSome());
  // Acquisition is also allowed before OnFrameAvailable after a timeout.

  AImage* image = nullptr;
  UniqueFileHandle fence;
  const media_status_t ret = AImageReader_acquireNextImageAsync(
      mAImageReader, &image, getter_Transfers(fence));
  // XXX Add AImageReader_acquireLatestImageAsync() usage

  switch (ret) {
    case AMEDIA_ERROR_INVALID_PARAMETER:
      MOZ_ASSERT_UNREACHABLE("unexpected to be called");
      return AcquireImageResult::Failure;
    case AMEDIA_IMGREADER_MAX_IMAGES_ACQUIRED:
      // Consumers can still hold the acquired images. Keep the pending frame
      // so the next update can acquire it after an image is released.
      return AcquireImageResult::Failure;
    case AMEDIA_IMGREADER_NO_BUFFER_AVAILABLE:
      return AcquireImageResult::NoBufferAvailable;
    case AMEDIA_ERROR_UNKNOWN:
      return AcquireImageResult::Failure;
    case AMEDIA_OK:
      break;
    default:
      MOZ_ASSERT_UNREACHABLE("unexpected to be called");
      return AcquireImageResult::Failure;
  }

  if (!image) {
    return AcquireImageResult::Failure;
  }

  // This buffer has been consumed even if importing it subsequently fails.
  const AndroidMediaCodecFrameId frameId = mPendingFrameId.value();
  ClearPendingFrame();

  AHardwareBuffer* nativeBuffer = nullptr;
  media_status_t result = AImage_getHardwareBuffer(image, &nativeBuffer);
  if (!nativeBuffer) {
    gfxCriticalNoteOnce << "AImage_getHardwareBuffer failed"
                        << static_cast<int32_t>(result);
    if (fence) {
      AImage_deleteAsync(image, fence.release());
    } else {
      AImage_delete(image);
    }
    return AcquireImageResult::Failure;
  }

  AHardwareBuffer_Desc bufferInfo = {};
  AHardwareBuffer_describe(nativeBuffer, &bufferInfo);

  const gfx::IntSize size = gfx::IntSize(bufferInfo.width, bufferInfo.height);
  // XXX
  const gfx::SurfaceFormat format = gfx::SurfaceFormat::R8G8B8X8;

  auto crop = GetImageCropRect(image, size);
  if (!crop) {
    if (fence) {
      AImage_deleteAsync(image, fence.release());
    } else {
      AImage_delete(image);
    }
    return AcquireImageResult::Failure;
  }

  RefPtr<AndroidImageWrapper> previous;
  previous.swap(mCurrentImage);
  mCurrentImage = new AndroidImageWrapper(this, image, nativeBuffer, size,
                                          format, std::move(fence), *crop);
  mCurrentFrameId = frameId;
  if (previous) {
    // Publish the new image and its ID under the monitor, then unlock
    // before dropping the reference that may delete the old AImage.
    MonitorAutoUnlock unlock(mMonitor);
    previous = nullptr;
  }

  MOZ_ASSERT(mAcquiredImageCount.load() <= mMaxImageCount);

  return AcquireImageResult::Success;
}

ANativeWindow* AndroidImageReader::GetANativeWindow() {
  MonitorAutoLock lock(mMonitor);
  return mNativeWindow;
}

RefPtr<AndroidImageWrapper> AndroidImageReader::GetCurrentImage() {
  MonitorAutoLock lock(mMonitor);
  return mCurrentImage;
}

bool AndroidImageReader::MaybeReleaseFrameToCodec(
    const AndroidMediaCodecFrameId aFrameId, const bool aRender) {
  MonitorAutoLock lock(mMonitor);
  return MaybeReleaseFrameToCodec(lock, aFrameId, aRender);
}
bool AndroidImageReader::MaybeReleaseFrameToCodec(
    const MonitorAutoLock& aProofOfLock,
    const AndroidMediaCodecFrameId aFrameId, const bool aRender) {
  aProofOfLock.AssertOwns(mMonitor);
  if (IsStopped()) {
    return false;
  }
  if (mRemoteState.isSome()) {
    const int64_t handle = mRemoteState->mHandle;
    // Drop the monitor across Binder IPC so frame notifications and
    // release-failure callbacks can take it to update the reader.
    MonitorAutoUnlock unlock(mMonitor);
    // Binder reports whether it accepted the request. RDD reports render
    // failures asynchronously.
    return java::RemoteSurfaceAllocator::ReleaseImageReaderFrame(
        handle, int64_t(mImageReaderId.mId), int64_t(aFrameId.mId), aRender);
  }

  // Drop the monitor before invoking the local codec callback, which can
  // reenter the reader and take the same monitor.
  MonitorAutoUnlock unlock(mMonitor);
  return ImageReaderFrameRegistry::ReleaseFrame(mImageReaderId.mId,
                                                aFrameId.mId, aRender);
}

static StaticMutex sImageReaderMapMutex;
static StaticRefPtr<GpuProcessAndroidImageReaderMap> sImageReaderMap
    MOZ_GUARDED_BY(sImageReaderMapMutex);

/* static */
RefPtr<GpuProcessAndroidImageReaderMap> GpuProcessAndroidImageReaderMap::Get() {
  StaticMutexAutoLock lock(sImageReaderMapMutex);
  return sImageReaderMap.get();
}

/* static */
void GpuProcessAndroidImageReaderMap::Init() {
  MOZ_ASSERT(NS_IsMainThread());
  MOZ_ASSERT(XRE_IsGPUProcess() || XRE_IsParentProcess());
  NativeImageReaderAllocator::Init();

  {
    StaticMutexAutoLock lock(sAImageReadbackMutex);
    MOZ_ASSERT(!sAImageSnapshotContext);
    sAImageReadbackShuttingDown = false;
  }
  {
    StaticMutexAutoLock lock(sImageReaderMapMutex);
    MOZ_ASSERT(!sImageReaderMap);
    sImageReaderMap = new GpuProcessAndroidImageReaderMap();
  }
  {
    auto readers = sRemoteReaders.Lock();
    readers->mShuttingDown = false;
  }
}

/* static */
void GpuProcessAndroidImageReaderMap::Shutdown() {
  MOZ_ASSERT(NS_IsMainThread());

  RemoteReaders readers;
  {
    auto remoteReaders = sRemoteReaders.Lock();
    remoteReaders->mShuttingDown = true;
    readers.swap(remoteReaders->mReaders);
  }
  for (auto& [handle, reader] : readers) {
    reader->DisconnectRemote();
  }
  readers.clear();

  // Detach the singleton under the same lock used to acquire references.
  // In-flight callers can finish, and the last reference is released unlocked.
  RefPtr<GpuProcessAndroidImageReaderMap> map;
  {
    StaticMutexAutoLock lock(sImageReaderMapMutex);
    map = sImageReaderMap.forget();
  }

  // Readers are already disconnected. Queue shutdown cancels pending timers.
  if (map && map->mRemoteFrameTimeoutQueue) {
    map->mRemoteFrameTimeoutQueue->BeginShutdown();
  }

  // Wait for any readback to release the context before destroying it here.
  StaticMutexAutoLock lock(sAImageReadbackMutex);
  sAImageReadbackShuttingDown = true;
  DestroyAImageSnapshotContext();
}

GpuProcessAndroidImageReaderMap::GpuProcessAndroidImageReaderMap()
    : mRemoteFrameTimeoutQueue(nsThreadManager::get().CreateBackgroundTaskQueue(
          "ImageReaderFrameTimeout")),
      mMonitor("GpuProcessAndroidImageReaderMap.mMonitor") {}

GpuProcessAndroidImageReaderMap::~GpuProcessAndroidImageReaderMap() = default;

void GpuProcessAndroidImageReaderMap::Register(
    AndroidImageReader* aImageReader) {
  MOZ_ASSERT(aImageReader);

  if (!aImageReader) {
    MOZ_ASSERT_UNREACHABLE("unexpected to be called");
    return;
  }

  MonitorAutoLock lock(mMonitor);

  auto it = mImageReaders.find(aImageReader->mImageReaderId);
  if (it != mImageReaders.end()) {
    MOZ_ASSERT_UNREACHABLE("unexpected to be called");
    return;
  }

  mImageReaders.emplace(aImageReader->mImageReaderId,
                        std::make_unique<ImageReaderHolder>(aImageReader));
}

void GpuProcessAndroidImageReaderMap::Unregister(
    GpuProcessAndroidImageReaderId aImageReaderId) {
  MonitorAutoLock lock(mMonitor);

  const auto it = mImageReaders.find(aImageReaderId);
  MOZ_ASSERT(it != mImageReaders.end());
  if (it == mImageReaders.end()) {
    MOZ_ASSERT_UNREACHABLE("unexpected to be called");
    return;
  }
  mImageReaders.erase(it);
}

RefPtr<AndroidImageReader> GpuProcessAndroidImageReaderMap::GetImageReader(
    GpuProcessAndroidImageReaderId aImageReaderId) {
  MonitorAutoLock lock(mMonitor);

  const auto it = mImageReaders.find(aImageReaderId);
  if (it == mImageReaders.end()) {
    return nullptr;
  }
  return RefPtr<AndroidImageReader>(it->second->mImageReader);
}

bool GpuProcessAndroidImageReaderMap::MaybeReleaseFrameToCodec(
    const GpuProcessAndroidImageReaderId aImageReaderId,
    const AndroidMediaCodecFrameId aFrameId, const bool aRender) {
  RefPtr<AndroidImageReader> reader = GetImageReader(aImageReaderId);
  if (!reader) {
    return false;
  }
  return reader->MaybeReleaseFrameToCodec(aFrameId, aRender);
}

RefPtr<AndroidImageConsumer> GpuProcessAndroidImageReaderMap::GetImageConsumer(
    const GpuProcessAndroidImageReaderId aImageReaderId, gl::GLContext* aGL) {
  MOZ_ASSERT(wr::RenderThread::IsInRenderThread());
  MOZ_ASSERT(aGL);

  // Strong references outlive each lock scope, including on failure. Their
  // destructors may ultimately unregister the reader from this map.
  RefPtr<AndroidImageReader> imageReader;
  {
    MonitorAutoLock lock(mMonitor);
    const auto it = mImageReaders.find(aImageReaderId);
    if (it == mImageReaders.end()) {
      return nullptr;
    }
    auto* holder = it->second.get();
    if (holder->mImageConsumer) {
      if (holder->mImageConsumer->mGL == aGL) {
        return holder->mImageConsumer;
      }
      MOZ_ASSERT_UNREACHABLE("unexpected GL context");
      return nullptr;
    }
    imageReader = RefPtr<AndroidImageReader>(holder->mImageReader);
  }
  if (!imageReader) {
    return nullptr;
  }

  RefPtr<AndroidImageConsumer> imageConsumer =
      AndroidImageConsumer::Create(imageReader, aGL);
  if (!imageConsumer) {
    return nullptr;
  }
  {
    MonitorAutoLock lock(mMonitor);
    const auto it = mImageReaders.find(aImageReaderId);
    if (it == mImageReaders.end()) {
      return nullptr;
    }
    // Consumer creation/destruction is serialized on the render thread.
    MOZ_ASSERT(!it->second->mImageConsumer);
    it->second->mImageConsumer = imageConsumer;
  }
  return imageConsumer;
}

void GpuProcessAndroidImageReaderMap::UnregisterImageConsumer(
    GpuProcessAndroidImageReaderId aImageReaderId) {
  MOZ_ASSERT(wr::RenderThread::IsInRenderThread());

  MonitorAutoLock lock(mMonitor);

  const auto it = mImageReaders.find(aImageReaderId);
  if (it == mImageReaders.end()) {
    return;
  }

  auto* holder = it->second.get();

  MOZ_ASSERT(holder->mImageConsumer);
  holder->mImageConsumer = nullptr;
}

GpuProcessAndroidImageReaderMap::ImageReaderHolder::ImageReaderHolder(
    AndroidImageReader* aImageReader)
    : mImageReader(aImageReader) {}

GpuProcessAndroidImageReaderMap::ImageReaderHolder::~ImageReaderHolder() {}

}  // namespace layers
}  // namespace mozilla
