/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

#ifndef mozilla_layers_CanvasChild_h
#define mozilla_layers_CanvasChild_h

#include "mozilla/WeakPtr.h"
#include "mozilla/gfx/RecordedEvent.h"
#include "mozilla/ipc/CrossProcessSemaphore.h"
#include "mozilla/ipc/SharedMemoryMapping.h"
#include "mozilla/layers/PCanvasChild.h"
#include "mozilla/layers/SourceSurfaceSharedData.h"
#include "nsITimer.h"

class nsICanvasRenderingContextInternal;

namespace mozilla {

namespace dom {
class ThreadSafeWorkerRef;
}

namespace gfx {
class DrawTargetRecording;
class SourceSurface;
}  // namespace gfx

namespace layers {
class CanvasDrawEventRecorder;
struct RemoteTextureOwnerId;

class CanvasChild final : public PCanvasChild, public SupportsWeakPtr {
 public:
  NS_INLINE_DECL_REFCOUNTING(CanvasChild)

  explicit CanvasChild(dom::ThreadSafeWorkerRef* aWorkerRef);

  /**
   * @returns true if remote canvas has been deactivated due to failure.
   */
  static bool Deactivated() { return mDeactivated; }

  /**
   * Release resources until they are next required.
   */
  void ClearCachedResources();

  ipc::IPCResult RecvNotifyDeviceReset(
      const nsTArray<RemoteTextureOwnerId>& aOwnerIds);

  ipc::IPCResult RecvDeactivate();

  ipc::IPCResult RecvBlockCanvas();

  ipc::IPCResult RecvNotifyRequiresRefresh(
      const RemoteTextureOwnerId aTextureOwnerId);

  ipc::IPCResult RecvSnapshotShmem(
      const RemoteTextureOwnerId aTextureOwnerId,
      ipc::ReadOnlySharedMemoryHandle&& aShmemHandle,
      SnapshotShmemResolver&& aResolve);

  ipc::IPCResult RecvNotifyTextureDestruction(
      const RemoteTextureOwnerId aTextureOwnerId);

  /**
   * Ensures that the DrawEventRecorder has been created.
   *
   * @params aTextureType the TextureType to create in the CanvasTranslator.
   * @returns true if the recorder was successfully created
   */
  bool EnsureRecorder(gfx::IntSize aSize, gfx::SurfaceFormat aFormat,
                      TextureType aTextureType, TextureType aWebglTextureType);

  /**
   * Clean up IPDL actor.
   */
  void Destroy();

  /**
   * @returns true if we should be caching data surfaces in the GPU process.
   */
  bool ShouldCacheDataSurface() const {
    return mTransactionsSinceGetDataSurface < kCacheDataSurfaceThreshold;
  }

  /**
   * Start a local transaction if one is inactive. Record a begin event when a
   * recorder is available.
   */
  void EnsureBeginTransaction();

  /**
   * Send an end transaction event to indicate the end of events for this frame.
   */
  void EndTransaction();

  /**
   * @returns true if this actor is deactivated, has no recorder, or is the
   *          sole owner of its recorder and has no registered textures.
   */
  bool ShouldBeCleanedUp() const;

  /**
   * Create a DrawTargetRecording for a canvas texture.
   * @param aTextureOwnerId the id of the new texture
   * @param aSize size for the DrawTarget
   * @param aFormat SurfaceFormat for the DrawTarget
   * @param aPreferAcceleration prefer acceleration even when aSize is below
   *        the usual minimum size
   * @returns newly created DrawTargetRecording
   */
  already_AddRefed<gfx::DrawTargetRecording> CreateDrawTarget(
      const RemoteTextureOwnerId& aTextureOwnerId, gfx::IntSize aSize,
      gfx::SurfaceFormat aFormat, bool aPreferAcceleration);

  /**
   * Record an event for processing by the CanvasParent's CanvasTranslator.
   * @param aEvent the event to record
   */
  void RecordEvent(const gfx::RecordedEvent& aEvent);

  int64_t CreateCheckpoint();

  /**
   * Wrap the given surface, so that we can provide a DataSourceSurface if
   * required.
   * @param aSurface the SourceSurface to wrap
   * @param aTextureOwnerId the texture id of the source TextureData
   * @returns a SourceSurface that can provide a DataSourceSurface if required
   */
  already_AddRefed<gfx::SourceSurface> WrapSurface(
      const RefPtr<gfx::SourceSurface>& aSurface,
      const RemoteTextureOwnerId aTextureOwnerId);

  /**
   * The DrawTargetRecording backing the surface has not been modified since the
   * previous use, so it is safe to reattach the snapshot for readback.
   */
  void AttachSurface(const RefPtr<gfx::SourceSurface>& aSurface);

  /**
   * Detach a returned snapshot or one whose draw target is about to change.
   * If requested, preserve cached data before its shared memory is reused.
   */
  void DetachSurface(const RefPtr<gfx::SourceSurface>& aSurface,
                     bool aInvalidate = false);

  /**
   * Read pixels from the GPU process for a recorded surface.
   * @param aTextureOwnerId the source TextureData to read from
   * @param aSurface the recorded SourceSurface in this process
   * @param aDetached whether the surface is detached from the current snapshot
   * @param[out] aMayInvalidate whether the returned surface's pixels may be
   *        overwritten when its snapshot shared memory is reused
   * @returns the readback surface, or nullptr on failure
   */
  already_AddRefed<gfx::DataSourceSurface> GetDataSurface(
      const RemoteTextureOwnerId aTextureOwnerId,
      const gfx::SourceSurface* aSurface, bool aDetached, bool& aMayInvalidate);

  bool RequiresRefresh(const RemoteTextureOwnerId aTextureOwnerId) const;

  void ReturnDataSurfaceShmem(
      std::shared_ptr<ipc::ReadOnlySharedMemoryMapping>&& aDataSurfaceShmem);

  already_AddRefed<gfx::SourceSurface> SnapshotExternalCanvas(
      gfx::DrawTargetRecording* aTarget,
      nsICanvasRenderingContextInternal* aCanvas,
      mozilla::ipc::IProtocol* aActor);

 protected:
  void ActorDestroy(ActorDestroyReason aWhy) final;

 private:
  DISALLOW_COPY_AND_ASSIGN(CanvasChild);

  ~CanvasChild() final;

  size_t SizeOfDataSurfaceShmem(gfx::IntSize, gfx::SurfaceFormat aFormat);
  bool NeedsNewDataSurfaceShmem(size_t aSizeRequired);
  bool EnsureDataSurfaceShmem(size_t aSizeRequired);
  bool AllocateAndSendDataSurfaceShmem(size_t aSizeRequired);

  already_AddRefed<gfx::DataSourceSurface> ReadFromSnapshotShmem(
      RemoteTextureOwnerId aTextureOwnerId,
      const std::shared_ptr<ipc::ReadOnlySharedMemoryMapping>& aSnapshotShmem,
      int32_t aStride, const gfx::IntSize& aSize, gfx::SurfaceFormat aFormat,
      bool& aMayInvalidate);

  static void ReleaseDataShmemHolder(void* aClosure);

  void ScheduleDropFreeBuffersWhenDormant();
  void DropFreeBuffersWhenDormant();

  static const uint32_t kCacheDataSurfaceThreshold = 10;

  static bool mDeactivated;

  RefPtr<dom::ThreadSafeWorkerRef> mWorkerRef;
  RefPtr<CanvasDrawEventRecorder> mRecorder;
  nsCOMPtr<nsITimer> mDormantTimer;

  std::shared_ptr<ipc::ReadOnlySharedMemoryMapping> mDataSurfaceShmem;
  bool mDataSurfaceShmemAvailable = false;
  uint32_t mNextDataSurfaceShmemId = 0;
  int64_t mLastWriteLockCheckpoint = 0;
  uint32_t mTransactionsSinceGetDataSurface = kCacheDataSurfaceThreshold;
  struct TextureInfo {
    std::shared_ptr<mozilla::ipc::ReadOnlySharedMemoryMapping> mSnapshotShmem;
    bool mRequiresRefresh = false;
  };
  std::unordered_map<RemoteTextureOwnerId, TextureInfo,
                     RemoteTextureOwnerId::HashFn>
      mTextureInfo;
  bool mIsInTransaction = false;
  bool mDormant = false;
  bool mBlocked = false;
  uint64_t mLastSyncId = 0;
};

}  // namespace layers
}  // namespace mozilla

#endif  // mozilla_layers_CanvasChild_h
