/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "CanvasChild.h"

#include "MainThreadUtils.h"
#include "RecordedCanvasEventImpl.h"
#include "mozilla/AppShutdown.h"
#include "mozilla/Mutex.h"
#include "mozilla/StaticPrefs_gfx.h"
#include "mozilla/dom/WorkerPrivate.h"
#include "mozilla/dom/WorkerRef.h"
#include "mozilla/dom/WorkerRunnable.h"
#include "mozilla/gfx/CanvasManagerChild.h"
#include "mozilla/gfx/CanvasShutdownManager.h"
#include "mozilla/gfx/DrawTargetRecording.h"
#include "mozilla/gfx/Point.h"
#include "mozilla/gfx/Rect.h"
#include "mozilla/gfx/Tools.h"
#include "mozilla/gfx/gfxVars.h"
#include "mozilla/ipc/Endpoint.h"
#include "mozilla/ipc/ProcessChild.h"
#include "mozilla/ipc/SharedMemoryHandle.h"
#include "mozilla/layers/CanvasDrawEventRecorder.h"
#include "mozilla/layers/ImageDataSerializer.h"
#include "mozilla/layers/SourceSurfaceSharedData.h"
#include "nsICanvasRenderingContextInternal.h"
#include "nsIObserverService.h"

namespace mozilla {
namespace layers {

class RecorderHelpers final : public CanvasDrawEventRecorder::Helpers {
 public:
  NS_DECL_OWNINGTHREAD

  explicit RecorderHelpers(const RefPtr<CanvasChild>& aCanvasChild)
      : mCanvasChild(aCanvasChild) {}

  ~RecorderHelpers() override = default;

  bool InitTranslator(
      TextureType aTextureType, TextureType aWebglTextureType,
      gfx::BackendType aBackendType,
      ipc::MutableSharedMemoryHandle&& aReadHandle,
      nsTArray<ipc::ReadOnlySharedMemoryHandle>&& aBufferHandles,
      CrossProcessSemaphoreHandle&& aReaderSem,
      CrossProcessSemaphoreHandle&& aWriterSem) override {
    NS_ASSERT_OWNINGTHREAD(RecorderHelpers);
    if (NS_WARN_IF(!mCanvasChild)) {
      return false;
    }
    return mCanvasChild->SendInitTranslator(
        aTextureType, aWebglTextureType, aBackendType, std::move(aReadHandle),
        std::move(aBufferHandles), std::move(aReaderSem),
        std::move(aWriterSem));
  }

  bool AddBuffer(ipc::ReadOnlySharedMemoryHandle&& aBufferHandle) override {
    NS_ASSERT_OWNINGTHREAD(RecorderHelpers);
    if (!mCanvasChild) {
      return false;
    }
    return mCanvasChild->SendAddBuffer(std::move(aBufferHandle));
  }

  bool ReaderClosed() override {
    NS_ASSERT_OWNINGTHREAD(RecorderHelpers);
    if (!mCanvasChild) {
      return false;
    }
    return !mCanvasChild->CanSend() || AppShutdown::IsShutdownImpending();
  }

  bool RestartReader() override {
    NS_ASSERT_OWNINGTHREAD(RecorderHelpers);
    if (!mCanvasChild) {
      return false;
    }
    return mCanvasChild->SendRestartTranslation();
  }

  already_AddRefed<CanvasChild> GetCanvasChild() const override {
    RefPtr<CanvasChild> canvasChild(mCanvasChild);
    return canvasChild.forget();
  }

 private:
  const WeakPtr<CanvasChild> mCanvasChild;
};

// Limit the number of in-flight export surfaces
static Atomic<uint32_t> sCurrentExportSurfaces(0);
// Limit the memory used by in-flight export surfaces
static Atomic<size_t> sCurrentExportSurfaceMemory(0);

// The wrapper has its own recording reference. During replay, its alias
// resolves to the same SourceSurface as the underlying recorded snapshot.
class SourceSurfaceCanvasRecording final : public gfx::SourceSurface {
 public:
  MOZ_DECLARE_REFCOUNTED_VIRTUAL_TYPENAME(SourceSurfaceCanvasRecording, final)

  SourceSurfaceCanvasRecording(
      const RemoteTextureOwnerId aTextureOwnerId,
      const RefPtr<gfx::SourceSurface>& aRecordedSuface,
      CanvasChild* aCanvasChild,
      const RefPtr<CanvasDrawEventRecorder>& aRecorder)
      : mTextureOwnerId(aTextureOwnerId),
        mRecordedSurface(aRecordedSuface),
        mCanvasChild(aCanvasChild),
        mRecorder(aRecorder) {
    // Register the wrapper before recording its alias.
    mRecorder->AddStoredObject(this);
    mRecorder->RecordEvent(RecordedAddSurfaceAlias(this, aRecordedSuface));
  }

  ~SourceSurfaceCanvasRecording() {
    ReferencePtr surfaceAlias = this;
    ReferencePtr exportID = mExportID;
    if (NS_IsMainThread()) {
      ReleaseOnMainThread(std::move(mRecorder), surfaceAlias,
                          std::move(mRecordedSurface), std::move(mCanvasChild),
                          exportID);
      return;
    }

    mRecorder->AddPendingDeletion(
        [recorder = std::move(mRecorder), surfaceAlias,
         aliasedSurface = std::move(mRecordedSurface),
         canvasChild = std::move(mCanvasChild), exportID]() mutable -> void {
          ReleaseOnMainThread(std::move(recorder), surfaceAlias,
                              std::move(aliasedSurface), std::move(canvasChild),
                              exportID);
        });
  }

  gfx::SurfaceType GetType() const final {
    return gfx::SurfaceType::CANVAS_RECORDING;
  }

  gfx::SurfaceType GetUnderlyingType() const final {
    return mRecordedSurface->GetType();
  }

  already_AddRefed<SourceSurface> GetUnderlyingSurface() final {
    return do_AddRef(mRecordedSurface);
  }

  gfx::IntSize GetSize() const final { return mRecordedSurface->GetSize(); }

  gfx::SurfaceFormat GetFormat() const final {
    return mRecordedSurface->GetFormat();
  }

  already_AddRefed<gfx::DataSourceSurface> GetDataSurface() final {
    MutexAutoLock lock(mDataSurfaceLock);
    PrepareDataSurfaceForAccess(lock);
    return do_AddRef(mDataSourceSurface);
  }

  void AttachSurface() { mDetached = false; }
  void DetachSurface(bool aInvalidate = false) {
    mDetached = true;

    if (aInvalidate) {
      MutexAutoLock lock(mDataSurfaceLock);
      CopyDataSurfaceIfNeeded(lock);
    }
  }

  already_AddRefed<gfx::SourceSurface> ExtractSubrect(
      const gfx::IntRect& aRect) final {
    return mRecordedSurface->ExtractSubrect(aRect);
  }

  static size_t GetExportSurfaceSize(gfx::SourceSurface* aSurface) {
    return ImageDataSerializer::ComputeRGBBufferSize(aSurface->GetSize(),
                                                     aSurface->GetFormat())
        .valueOr(0);
  }

  bool GetSurfaceDescriptor(SurfaceDescriptor& aDesc) final {
    if (!NS_IsMainThread()) {
      // Only allow recording surface upload optimization on main thread.
      return false;
    }
    static Atomic<uintptr_t> sNextExportID(0);
    if (!mExportID) {
      if (++sCurrentExportSurfaces >
          StaticPrefs::gfx_canvas_accelerated_max_export_surfaces()) {
        --sCurrentExportSurfaces;
        return false;
      }
      size_t bytes = GetExportSurfaceSize(mRecordedSurface);
      if ((sCurrentExportSurfaceMemory += bytes) >
          StaticPrefs::gfx_canvas_accelerated_max_export_surface_memory()) {
        --sCurrentExportSurfaces;
        sCurrentExportSurfaceMemory -= bytes;
        return false;
      }
      mExportID = gfx::ReferencePtr(++sNextExportID);
      mRecorder->RecordEvent(RecordedAddExportSurface(mExportID, this));
    }
    aDesc = SurfaceDescriptorCanvasSurface(
        mozilla::ipc::ActorCast<gfx::CanvasManagerChild>(
            mCanvasChild->Manager())
            ->Id(),
        mCanvasChild->Id(), uintptr_t(mExportID));
    return true;
  }

 private:
  void CopyDataSurfaceIfNeeded(const MutexAutoLock& aProofOfLock)
      MOZ_REQUIRES(mDataSurfaceLock) {
    if (mDataSourceSurface && mMayInvalidate) {
      // Replace the cached view before its snapshot buffer can be reused.
      // A failed copy discards that view as well.
      mDataSourceSurface =
          gfx::Factory::CopyDataSourceSurface(mDataSourceSurface);
      mMayInvalidate = false;
    }
  }

  // Only the main thread can fetch data. Other threads can use the cached
  // surface, copying it first if its shared memory may be overwritten.
  void PrepareDataSurfaceForAccess(const MutexAutoLock& aProofOfLock)
      MOZ_REQUIRES(mDataSurfaceLock) {
    if (!NS_IsMainThread()) {
      CopyDataSurfaceIfNeeded(aProofOfLock);
      return;
    }
    if (!mDataSourceSurface) {
      mDataSourceSurface = mCanvasChild->GetDataSurface(
          mTextureOwnerId, mRecordedSurface, mDetached, mMayInvalidate);
    }
  }

  // Used to ensure that clean-up that requires it is done on the main thread.
  static void ReleaseOnMainThread(RefPtr<CanvasDrawEventRecorder> aRecorder,
                                  ReferencePtr aSurfaceAlias,
                                  RefPtr<gfx::SourceSurface> aAliasedSurface,
                                  RefPtr<CanvasChild> aCanvasChild,
                                  ReferencePtr aExportID) {
    MOZ_RELEASE_ASSERT(NS_IsMainThread());

    aRecorder->RemoveStoredObject(aSurfaceAlias);
    aRecorder->RecordEvent(RecordedRemoveSurfaceAlias(aSurfaceAlias));
    if (aExportID) {
      aRecorder->RecordEvent(RecordedRemoveExportSurface(aExportID));
      --sCurrentExportSurfaces;
      size_t bytes = GetExportSurfaceSize(aAliasedSurface);
      sCurrentExportSurfaceMemory -= bytes;
    }
    aAliasedSurface = nullptr;
    aCanvasChild = nullptr;
    aRecorder = nullptr;
  }

  const RemoteTextureOwnerId mTextureOwnerId;
  RefPtr<gfx::SourceSurface> mRecordedSurface;
  RefPtr<CanvasChild> mCanvasChild;
  RefPtr<CanvasDrawEventRecorder> mRecorder;
  Mutex mDataSurfaceLock{"SourceSurfaceCanvasRecording::mDataSurfaceLock"};
  RefPtr<gfx::DataSourceSurface> mDataSourceSurface
      MOZ_GUARDED_BY(mDataSurfaceLock);
  // The cached data uses snapshot shmem whose contents may be overwritten.
  bool mMayInvalidate MOZ_GUARDED_BY(mDataSurfaceLock) = false;
  bool mDetached = false;
  ReferencePtr mExportID;
};

class CanvasDataShmemHolder {
 public:
  CanvasDataShmemHolder(
      const std::shared_ptr<ipc::ReadOnlySharedMemoryMapping>& aShmem,
      CanvasChild* aCanvasChild)
      : mMutex("CanvasChild::DataShmemHolder::mMutex"),
        mShmem(aShmem),
        mCanvasChild(aCanvasChild) {}

  bool Init(dom::ThreadSafeWorkerRef* aWorkerRef) {
    if (!aWorkerRef) {
      return true;
    }

    RefPtr<dom::StrongWorkerRef> workerRef = dom::StrongWorkerRef::Create(
        aWorkerRef->Private(), "CanvasChild::DataShmemHolder",
        [this]() { OnWorkerShutdown(); });
    if (NS_WARN_IF(!workerRef)) {
      return false;
    }

    MutexAutoLock lock(mMutex);
    mWorkerRef = MakeRefPtr<dom::ThreadSafeWorkerRef>(workerRef);
    return true;
  }

  void Destroy() {
    ReleasableMutexAutoLock lock(mMutex);

    if (mCanvasChild) {
      if (mWorkerRef) {
        if (!mWorkerRef->Private()->IsOnCurrentThread()) {
          auto task = MakeRefPtr<DestroyRunnable>(this);
          dom::WorkerPrivate* worker = mWorkerRef->Private();
          lock.Unlock();
          task->Dispatch(worker);
          return;
        }
      } else if (!NS_IsMainThread()) {
        lock.Unlock();
        NS_DispatchToMainThread(NS_NewRunnableFunction(
            "CanvasDataShmemHolder::Destroy", [this]() { Destroy(); }));
        return;
      }

      mCanvasChild->ReturnDataSurfaceShmem(std::move(mShmem));
      mCanvasChild = nullptr;
      mWorkerRef = nullptr;
    }

    lock.Unlock();
    delete this;
  }

  void OnWorkerShutdown() {
    MutexAutoLock lock(mMutex);
    // Skip returning the buffer to CanvasChild after worker shutdown.
    // Keep the mapping alive until the surface releases this holder.
    mCanvasChild = nullptr;
    mWorkerRef = nullptr;
  }

 private:
  class DestroyRunnable final : public dom::WorkerThreadRunnable {
   public:
    explicit DestroyRunnable(CanvasDataShmemHolder* aShmemHolder)
        : dom::WorkerThreadRunnable("CanvasDataShmemHolder::Destroy"),
          mShmemHolder(aShmemHolder) {}

    bool WorkerRun(JSContext* aCx,
                   dom::WorkerPrivate* aWorkerPrivate) override {
      mShmemHolder->Destroy();
      return true;
    }

    void PostRun(JSContext* aCx, dom::WorkerPrivate* aWorkerPrivate,
                 bool aRunResult) override {}

    bool PreDispatch(dom::WorkerPrivate* aWorkerPrivate) override {
      return true;
    }

    void PostDispatch(dom::WorkerPrivate* aWorkerPrivate,
                      bool aDispatchResult) override {}

   private:
    CanvasDataShmemHolder* mShmemHolder;
  };

  Mutex mMutex;
  std::shared_ptr<ipc::ReadOnlySharedMemoryMapping> mShmem;
  RefPtr<CanvasChild> mCanvasChild MOZ_GUARDED_BY(mMutex);
  RefPtr<dom::ThreadSafeWorkerRef> mWorkerRef MOZ_GUARDED_BY(mMutex);
};

CanvasChild::CanvasChild(dom::ThreadSafeWorkerRef* aWorkerRef)
    : mWorkerRef(aWorkerRef) {}

CanvasChild::~CanvasChild() {
  MOZ_ASSERT(!mWorkerRef);
  if (mDormantTimer) {
    mDormantTimer->Cancel();
  }
}

static void NotifyCanvasDeviceChanged() {
  nsCOMPtr<nsIObserverService> obs = services::GetObserverService();
  if (obs) {
    obs->NotifyObservers(nullptr, "canvas-device-reset", nullptr);
  }
}

ipc::IPCResult CanvasChild::RecvNotifyDeviceReset(
    const nsTArray<RemoteTextureOwnerId>& aOwnerIds) {
  NS_ASSERT_OWNINGTHREAD(CanvasChild);

  if (auto* manager = gfx::CanvasShutdownManager::MaybeGet()) {
    manager->OnRemoteCanvasReset(aOwnerIds);
  }

  mRecorder->RecordEvent(RecordedDeviceResetAcknowledged());
  return IPC_OK();
}

/* static */ bool CanvasChild::mDeactivated = false;

ipc::IPCResult CanvasChild::RecvDeactivate() {
  NS_ASSERT_OWNINGTHREAD(CanvasChild);

  RefPtr<CanvasChild> self(this);
  mDeactivated = true;
  if (auto* cm = gfx::CanvasManagerChild::Get()) {
    cm->DeactivateCanvas();
  }
  NotifyCanvasDeviceChanged();
  return IPC_OK();
}

ipc::IPCResult CanvasChild::RecvBlockCanvas() {
  mBlocked = true;
  if (auto* cm = gfx::CanvasManagerChild::Get()) {
    cm->BlockCanvas();
  }
  return IPC_OK();
}

bool CanvasChild::EnsureRecorder(gfx::IntSize aSize, gfx::SurfaceFormat aFormat,
                                 TextureType aTextureType,
                                 TextureType aWebglTextureType) {
  NS_ASSERT_OWNINGTHREAD(CanvasChild);

  if (!mRecorder) {
    gfx::BackendType backendType =
        gfxPlatform::GetPlatform()->GetPreferredCanvasBackend();
    auto recorder = MakeRefPtr<CanvasDrawEventRecorder>(mWorkerRef);
    if (!recorder->Init(aTextureType, aWebglTextureType, backendType,
                        std::make_unique<RecorderHelpers>(this))) {
      return false;
    }

    mRecorder = recorder.forget();
  }

  if (NS_WARN_IF(mRecorder->GetTextureType() != aTextureType)) {
    // The recorder has already been initialized with a different type. This can
    // happen if there is a device reset or fallback that causes a switch to a
    // different unaccelerated texture type (i.e. unknown). In that case, just
    // fall back to non-remote rendering.
    return false;
  }

  EnsureDataSurfaceShmem(SizeOfDataSurfaceShmem(aSize, aFormat));

  return true;
}

void CanvasChild::ActorDestroy(ActorDestroyReason aWhy) {
  NS_ASSERT_OWNINGTHREAD(CanvasChild);

  if (mRecorder) {
    mRecorder->DetachResources();
  }
  mTextureInfo.clear();
}

void CanvasChild::Destroy() {
  NS_ASSERT_OWNINGTHREAD(CanvasChild);

  if (mDormantTimer) {
    mDormantTimer->Cancel();
  }

  if (CanSend()) {
    Send__delete__(this);
  }

  mWorkerRef = nullptr;
}

void CanvasChild::EnsureBeginTransaction() {
  NS_ASSERT_OWNINGTHREAD(CanvasChild);

  if (!mIsInTransaction) {
    RecordEvent(RecordedCanvasBeginTransaction());
    mIsInTransaction = true;
  }
}

void CanvasChild::EndTransaction() {
  NS_ASSERT_OWNINGTHREAD(CanvasChild);

  if (mIsInTransaction) {
    RecordEvent(RecordedCanvasEndTransaction());
    mIsInTransaction = false;
    mDormant = false;
  } else if (mRecorder && !mDormant) {
    ScheduleDropFreeBuffersWhenDormant();
  }

  // If we are continuously drawing/recording, then we need to periodically
  // flush our external surface/image references, to ensure they actually get
  // freed on a timely basis.
  if (mRecorder) {
    mRecorder->ClearProcessedExternalSurfaces();
    mRecorder->ClearProcessedExternalImages();
  }

  ++mTransactionsSinceGetDataSurface;
}

void CanvasChild::ScheduleDropFreeBuffersWhenDormant() {
  // Mark the actor dormant before arming the timer so subsequent empty
  // transactions do not rearm it.
  mDormant = true;
  if (!mDormantTimer) {
    mDormantTimer = NS_NewTimer(GetCurrentSerialEventTarget());
  }
  if (mDormantTimer) {
    mDormantTimer->InitWithNamedFuncCallback(
        [](nsITimer*, void* aClosure) {
          static_cast<CanvasChild*>(aClosure)->DropFreeBuffersWhenDormant();
        },
        this, StaticPrefs::gfx_canvas_remote_drop_buffer_milliseconds(),
        nsITimer::TYPE_ONE_SHOT, "CanvasChild::DropFreeBuffersWhenDormant"_ns);
  }
}

void CanvasChild::DropFreeBuffersWhenDormant() {
  NS_ASSERT_OWNINGTHREAD(CanvasChild);
  // A non-empty transaction may have cleared mDormant since the timer was
  // armed.
  if (mDormant && mRecorder) {
    mRecorder->DropFreeBuffers();
    // Notify CanvasTranslator it is dormant.
    SendDropFreeBuffersWhenDormant();
  }
}

void CanvasChild::ClearCachedResources() {
  NS_ASSERT_OWNINGTHREAD(CanvasChild);
  if (mRecorder) {
    mRecorder->DropFreeBuffers();
    // Notify CanvasTranslator it is about to be minimized.
    SendClearCachedResources();
  }
}

bool CanvasChild::ShouldBeCleanedUp() const {
  NS_ASSERT_OWNINGTHREAD(CanvasChild);

  // Always return true if we've been deactivated.
  if (Deactivated()) {
    return true;
  }

  // With a recorder, keep the actor alive while textures are registered or
  // other objects still reference the recorder.
  return !mRecorder || (mRecorder->hasOneRef() && mTextureInfo.empty());
}

already_AddRefed<gfx::DrawTargetRecording> CanvasChild::CreateDrawTarget(
    const RemoteTextureOwnerId& aTextureOwnerId, gfx::IntSize aSize,
    gfx::SurfaceFormat aFormat, bool aPreferAcceleration) {
  NS_ASSERT_OWNINGTHREAD(CanvasChild);
  MOZ_RELEASE_ASSERT(mTextureInfo.find(aTextureOwnerId) == mTextureInfo.end());

  if (!mRecorder) {
    return nullptr;
  }

  // The recorder uses this small local target for backend queries. Replay
  // creates the remote draw target at the recorded canvas size.
  RefPtr<gfx::DrawTarget> dummyDt = gfx::Factory::CreateDrawTarget(
      gfx::BackendType::SKIA, gfx::IntSize(1, 1), aFormat);
  RefPtr<gfx::DrawTargetRecording> dt = MakeAndAddRef<gfx::DrawTargetRecording>(
      mRecorder, aTextureOwnerId, dummyDt, aSize, aPreferAcceleration);
  dt->SetOptimizeTransform(true);

  mTextureInfo.insert({aTextureOwnerId, {}});

  return dt.forget();
}

size_t CanvasChild::SizeOfDataSurfaceShmem(gfx::IntSize aSize,
                                           gfx::SurfaceFormat aFormat) {
  if (!mRecorder) {
    return 0;
  }
  Maybe<uint32_t> sizeRequired =
      ImageDataSerializer::ComputeRGBBufferSize(aSize, aFormat);
  return sizeRequired.isSome()
             ? ipc::shared_memory::PageAlignedSize(size_t(sizeRequired.value()))
             : 0;
}

bool CanvasChild::NeedsNewDataSurfaceShmem(size_t aSizeRequired) {
  return !mDataSurfaceShmemAvailable ||
         mDataSurfaceShmem->Size() < aSizeRequired;
}

bool CanvasChild::EnsureDataSurfaceShmem(size_t aSizeRequired) {
  NS_ASSERT_OWNINGTHREAD(CanvasChild);

  if (!aSizeRequired) {
    return false;
  }

  if (NeedsNewDataSurfaceShmem(aSizeRequired) &&
      !AllocateAndSendDataSurfaceShmem(aSizeRequired)) {
    return false;
  }

  MOZ_RELEASE_ASSERT(mDataSurfaceShmemAvailable);
  return true;
}

bool CanvasChild::AllocateAndSendDataSurfaceShmem(size_t aSizeRequired) {
  if (!mRecorder || mRecorder->HasFailed()) {
    return false;
  }

  auto shmemHandle = ipc::shared_memory::Create(aSizeRequired);
  if (!shmemHandle) {
    return false;
  }

  // CanvasChild reads through this mapping. The translator receives the
  // writable handle so it can write the readback pixels.
  auto roMapping = shmemHandle.AsReadOnly().Map();
  if (!roMapping) {
    return false;
  }

  // Record the pause before sending the new buffer. The translator accepts
  // it while paused and resumes replay after mapping the handle.
  RecordEvent(RecordedPauseTranslation());
  if (mRecorder->HasFailed()) {
    return false;
  }

  auto id = ++mNextDataSurfaceShmemId;
  if (!id) {
    // If ids overflow, ensure that zero is reserved.
    id = ++mNextDataSurfaceShmemId;
  }
  if (!SendSetDataSurfaceBuffer(id, std::move(shmemHandle))) {
    return false;
  }

  // Replace the current mapping only after the IPC send succeeds. The
  // translator maps its handle when it processes the message.
  mDataSurfaceShmem =
      std::make_shared<ipc::ReadOnlySharedMemoryMapping>(std::move(roMapping));
  mDataSurfaceShmemAvailable = true;
  return true;
}

void CanvasChild::RecordEvent(const gfx::RecordedEvent& aEvent) {
  NS_ASSERT_OWNINGTHREAD(CanvasChild);

  if (!mRecorder) {
    return;
  }

  mRecorder->RecordEvent(aEvent);
}

int64_t CanvasChild::CreateCheckpoint() {
  NS_ASSERT_OWNINGTHREAD(CanvasChild);
  return mRecorder->CreateCheckpoint();
}

already_AddRefed<gfx::DataSourceSurface> CanvasChild::GetDataSurface(
    const RemoteTextureOwnerId aTextureOwnerId,
    const gfx::SourceSurface* aSurface, bool aDetached, bool& aMayInvalidate) {
  NS_ASSERT_OWNINGTHREAD(CanvasChild);
  MOZ_RELEASE_ASSERT(aSurface);

  // mTransactionsSinceGetDataSurface is used to determine if we want to prepare
  // a DataSourceSurface in the GPU process up front at the end of the
  // transaction, but that only makes sense if the canvas JS is requesting data
  // in between transactions.
  if (!mIsInTransaction) {
    mTransactionsSinceGetDataSurface = 0;
  }

  EnsureBeginTransaction();

  gfx::IntSize ssSize = aSurface->GetSize();
  gfx::SurfaceFormat ssFormat = aSurface->GetFormat();
  auto stride = ImageDataSerializer::ComputeRGBStride(ssFormat, ssSize.width);
  if (stride.isNothing()) {
    return nullptr;
  }

  size_t sizeRequired = SizeOfDataSurfaceShmem(ssSize, ssFormat);
  if (!sizeRequired) {
    return nullptr;
  }

  // The texture's snapshot shmem can only serve the latest snapshot.
  // Use the readback path below if the snapshot is detached or the buffer
  // is missing or too small.
  if (!aDetached) {
    auto it = mTextureInfo.find(aTextureOwnerId);
    if (it != mTextureInfo.end() && it->second.mSnapshotShmem &&
        !NS_WARN_IF(sizeRequired > it->second.mSnapshotShmem->Size())) {
      // Propagate failures from the selected snapshot readback path.
      return ReadFromSnapshotShmem(aTextureOwnerId, it->second.mSnapshotShmem,
                                   stride.value(), ssSize, ssFormat,
                                   aMayInvalidate);
    }
  }

  RecordEvent(RecordedCacheDataSurface(aSurface));

  if (!EnsureDataSurfaceShmem(sizeRequired)) {
    return nullptr;
  }

  RecordEvent(RecordedGetDataForSurface(mNextDataSurfaceShmemId, aSurface));
  auto checkpoint = CreateCheckpoint();
  if (NS_WARN_IF(!mRecorder->WaitForCheckpoint(checkpoint))) {
    return nullptr;
  }

  auto* closure = new CanvasDataShmemHolder(mDataSurfaceShmem, this);
  if (NS_WARN_IF(!closure->Init(mWorkerRef))) {
    delete closure;
    return nullptr;
  }

  // Keep this buffer unavailable while the surface holds it. The release
  // callback can make it reusable if it is still the current buffer.
  mDataSurfaceShmemAvailable = false;

  const auto* data = mDataSurfaceShmem->DataAs<uint8_t>();

  // We can cast away the const of `data` to match the call because the
  // DataSourceSurface will not be written to.
  RefPtr<gfx::DataSourceSurface> dataSurface =
      gfx::Factory::CreateWrappingDataSourceSurface(
          const_cast<uint8_t*>(data), stride.value(), ssSize, ssFormat,
          ReleaseDataShmemHolder, closure);
  aMayInvalidate = false;
  return dataSurface.forget();
}

already_AddRefed<gfx::DataSourceSurface> CanvasChild::ReadFromSnapshotShmem(
    RemoteTextureOwnerId aTextureOwnerId,
    const std::shared_ptr<ipc::ReadOnlySharedMemoryMapping>& aSnapshotShmem,
    int32_t aStride, const gfx::IntSize& aSize, gfx::SurfaceFormat aFormat,
    bool& aMayInvalidate) {
  const auto* shmemPtr = aSnapshotShmem->DataAs<uint8_t>();
  MOZ_RELEASE_ASSERT(shmemPtr);
  // Wait for the translator to bring the snapshot buffer up to date before
  // exposing its pixels.
  mRecorder->RecordEvent(RecordedPrepareShmem(aTextureOwnerId));
  auto checkpoint = CreateCheckpoint();
  if (NS_WARN_IF(!mRecorder->WaitForCheckpoint(checkpoint))) {
    return nullptr;
  }
  auto* closure = new CanvasDataShmemHolder(aSnapshotShmem, this);
  if (NS_WARN_IF(!closure->Init(mWorkerRef))) {
    delete closure;
    return nullptr;
  }
  // We can cast away the const of `shmemPtr` to match the call because the
  // DataSourceSurface will not be written to.
  RefPtr<gfx::DataSourceSurface> dataSurface =
      gfx::Factory::CreateWrappingDataSourceSurface(
          const_cast<uint8_t*>(shmemPtr), aStride, aSize, aFormat,
          ReleaseDataShmemHolder, closure);
  // The holder keeps the mapping alive. The translator can still overwrite
  // its contents when it uses the same buffer for a later snapshot.
  aMayInvalidate = true;
  return dataSurface.forget();
}

/* static */ void CanvasChild::ReleaseDataShmemHolder(void* aClosure) {
  auto* shmemHolder = static_cast<CanvasDataShmemHolder*>(aClosure);
  shmemHolder->Destroy();
}

already_AddRefed<gfx::SourceSurface> CanvasChild::WrapSurface(
    const RefPtr<gfx::SourceSurface>& aSurface,
    const RemoteTextureOwnerId aTextureOwnerId) {
  NS_ASSERT_OWNINGTHREAD(CanvasChild);

  if (!aSurface) {
    return nullptr;
  }

  return MakeAndAddRef<SourceSurfaceCanvasRecording>(aTextureOwnerId, aSurface,
                                                     this, mRecorder);
}

void CanvasChild::ReturnDataSurfaceShmem(
    std::shared_ptr<ipc::ReadOnlySharedMemoryMapping>&& aDataSurfaceShmem) {
  // We can only reuse the latest data surface shmem.
  if (aDataSurfaceShmem == mDataSurfaceShmem) {
    MOZ_RELEASE_ASSERT(!mDataSurfaceShmemAvailable);
    mDataSurfaceShmemAvailable = true;
  }
}

void CanvasChild::AttachSurface(const RefPtr<gfx::SourceSurface>& aSurface) {
  if (auto* surface =
          static_cast<SourceSurfaceCanvasRecording*>(aSurface.get())) {
    surface->AttachSurface();
  }
}

void CanvasChild::DetachSurface(const RefPtr<gfx::SourceSurface>& aSurface,
                                bool aInvalidate) {
  if (auto* surface =
          static_cast<SourceSurfaceCanvasRecording*>(aSurface.get())) {
    surface->DetachSurface(aInvalidate);
  }
}

ipc::IPCResult CanvasChild::RecvNotifyRequiresRefresh(
    const RemoteTextureOwnerId aTextureOwnerId) {
  auto it = mTextureInfo.find(aTextureOwnerId);
  if (it != mTextureInfo.end()) {
    it->second.mRequiresRefresh = true;
  }
  return IPC_OK();
}

bool CanvasChild::RequiresRefresh(
    const RemoteTextureOwnerId aTextureOwnerId) const {
  if (mBlocked) {
    return true;
  }
  auto it = mTextureInfo.find(aTextureOwnerId);
  if (it != mTextureInfo.end()) {
    return it->second.mRequiresRefresh;
  }
  return false;
}

ipc::IPCResult CanvasChild::RecvSnapshotShmem(
    const RemoteTextureOwnerId aTextureOwnerId,
    ipc::ReadOnlySharedMemoryHandle&& aShmemHandle,
    SnapshotShmemResolver&& aResolve) {
  auto it = mTextureInfo.find(aTextureOwnerId);
  if (it != mTextureInfo.end()) {
    auto shmem = aShmemHandle.Map();
    if (NS_WARN_IF(!shmem)) {
      shmem = nullptr;
    } else {
      it->second.mSnapshotShmem =
          std::make_shared<ipc::ReadOnlySharedMemoryMapping>(std::move(shmem));
    }
    aResolve(true);
  } else {
    aResolve(false);
  }
  return IPC_OK();
}

ipc::IPCResult CanvasChild::RecvNotifyTextureDestruction(
    const RemoteTextureOwnerId aTextureOwnerId) {
  auto it = mTextureInfo.find(aTextureOwnerId);
  if (it == mTextureInfo.end()) {
    MOZ_RELEASE_ASSERT(!CanSend());
    return IPC_OK();
  }

  mTextureInfo.erase(aTextureOwnerId);
  return IPC_OK();
}

already_AddRefed<gfx::SourceSurface> CanvasChild::SnapshotExternalCanvas(
    gfx::DrawTargetRecording* aTarget,
    nsICanvasRenderingContextInternal* aCanvas,
    mozilla::ipc::IProtocol* aActor) {
  // SnapshotExternalCanvas is only valid to use if using Accelerated Canvas2D
  // with the pending events queue enabled. This ensures WebGL and AC2D are
  // running under the same thread, and that events can be paused or resumed
  // while synchronizing between WebGL and AC2D.
  if (!gfx::gfxVars::UseAcceleratedCanvas2D() ||
      !StaticPrefs::gfx_canvas_remote_use_canvas_translator_event_AtStartup() ||
      !aActor) {
    return nullptr;
  }

  uint32_t managerId =
      mozilla::ipc::ActorCast<gfx::CanvasManagerChild>(Manager())->Id();
  ActorId canvasId = aActor->Id();

  gfx::SurfaceFormat format = aCanvas->GetIsOpaque()
                                  ? gfx::SurfaceFormat::B8G8R8X8
                                  : gfx::SurfaceFormat::B8G8R8A8;
  gfx::IntSize size(aCanvas->GetWidth(), aCanvas->GetHeight());
  // Create the recording-side surface reference for the snapshot.
  RefPtr<gfx::SourceSurface> surface =
      aTarget->CreateExternalSourceSurface(size, format);
  if (!surface) {
    return nullptr;
  }

  // Pause replay at this point if the translator has not processed the
  // snapshot request for this sync ID yet.
  uint64_t syncId = ++mLastSyncId;
  mRecorder->RecordEvent(RecordedAwaitTranslationSync(syncId));

  // Send pending WebGL commands before requesting the back-buffer snapshot.
  aCanvas->SyncSnapshot();

  // Record how replay will bind the snapshot to the surface reference. The
  // await event above keeps replay from reaching this event before the
  // translator has handled the request.
  mRecorder->RecordEvent(aTarget,
                         RecordedResolveExternalSnapshot(
                             syncId, gfx::ReferencePtr(surface), size, format));

  // Send the asynchronous request after recording the resolve event.
  SendSnapshotExternalCanvas(syncId, managerId, canvasId);

  return surface.forget();
}

}  // namespace layers
}  // namespace mozilla
