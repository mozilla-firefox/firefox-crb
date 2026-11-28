/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "CanvasDrawEventRecorder.h"

#include "RecordedCanvasEventImpl.h"
#include "mozilla/StaticPrefs_gfx.h"
#include "mozilla/dom/WorkerCommon.h"
#include "mozilla/dom/WorkerPrivate.h"
#include "mozilla/dom/WorkerRef.h"
#include "mozilla/dom/WorkerRunnable.h"
#include "mozilla/layers/SharedSurfacesChild.h"
#include "mozilla/layers/TextureRecorded.h"

namespace mozilla {
namespace layers {

struct ShmemAndHandle {
  ipc::SharedMemoryMapping shmem;
  ipc::MutableSharedMemoryHandle handle;
};

static Maybe<ShmemAndHandle> CreateAndMapShmem(size_t aSize) {
  auto handle = ipc::shared_memory::Create(aSize);
  if (!handle) {
    return Nothing();
  }
  auto mapping = handle.Map();
  if (!mapping) {
    return Nothing();
  }

  return Some(ShmemAndHandle{std::move(mapping), std::move(handle)});
}

CanvasDrawEventRecorder::CanvasDrawEventRecorder(
    dom::ThreadSafeWorkerRef* aWorkerRef)
    : mWorkerRef(aWorkerRef), mIsOnWorker(!!aWorkerRef) {
  mDefaultBufferSize = ipc::shared_memory::PageAlignedSize(
      StaticPrefs::gfx_canvas_remote_default_buffer_size());
  mMaxDefaultBuffers = StaticPrefs::gfx_canvas_remote_max_default_buffers();
  mMaxSpinCount = StaticPrefs::gfx_canvas_remote_max_spin_count();
  mDropBufferLimit = StaticPrefs::gfx_canvas_remote_drop_buffer_limit();
  mBufferDropCountdown = mDropBufferLimit;
}

CanvasDrawEventRecorder::~CanvasDrawEventRecorder() { MOZ_ASSERT(!mWorkerRef); }

bool CanvasDrawEventRecorder::Init(TextureType aTextureType,
                                   TextureType aWebglTextureType,
                                   gfx::BackendType aBackendType,
                                   UniquePtr<Helpers> aHelpers) {
  NS_ASSERT_OWNINGTHREAD(CanvasDrawEventRecorder);

  mHelpers = std::move(aHelpers);

  MOZ_ASSERT(mTextureType == TextureType::Unknown);
  auto header = CreateAndMapShmem(sizeof(Header));
  if (NS_WARN_IF(header.isNothing())) {
    return false;
  }

  mHeader = header->shmem.DataAs<Header>();
  mHeader->eventCount = 0;
  mHeader->writerWaitCount = 0;
  mHeader->writerState = State::Processing;
  mHeader->processedCount = 0;
  mHeader->readerState = State::Paused;

  // Send the current buffer first and the spare second. The translator uses
  // the first handle as its current buffer and queues the second for reuse.
  AutoTArray<ipc::ReadOnlySharedMemoryHandle, 2> bufferHandles;
  auto buffer = CreateAndMapShmem(mDefaultBufferSize);
  if (NS_WARN_IF(buffer.isNothing())) {
    return false;
  }
  mCurrentBuffer = CanvasBuffer(std::move(buffer->shmem));
  bufferHandles.AppendElement(std::move(buffer->handle).ToReadOnly());

  buffer = CreateAndMapShmem(mDefaultBufferSize);
  if (NS_WARN_IF(buffer.isNothing())) {
    return false;
  }
  mRecycledBuffers.emplace(std::move(buffer->shmem), 0);
  bufferHandles.AppendElement(std::move(buffer->handle).ToReadOnly());

  mWriterSemaphore.reset(CrossProcessSemaphore::Create("CanvasRecorder", 0));
  auto writerSem = mWriterSemaphore->CloneHandle();
  mWriterSemaphore->CloseHandle();
  if (!IsHandleValid(writerSem)) {
    return false;
  }

  mReaderSemaphore.reset(CrossProcessSemaphore::Create("CanvasTranslator", 0));
  auto readerSem = mReaderSemaphore->CloneHandle();
  mReaderSemaphore->CloseHandle();
  if (!IsHandleValid(readerSem)) {
    return false;
  }

  if (!mHelpers->InitTranslator(aTextureType, aWebglTextureType, aBackendType,
                                std::move(header->handle),
                                std::move(bufferHandles), std::move(readerSem),
                                std::move(writerSem))) {
    return false;
  }

  mTextureType = aTextureType;
  mHeaderShmem = std::move(header->shmem);
  return true;
}

void CanvasDrawEventRecorder::RecordEvent(const gfx::RecordedEvent& aEvent) {
  NS_ASSERT_OWNINGTHREAD(CanvasDrawEventRecorder);
  aEvent.RecordToStream(*this);
}

int64_t CanvasDrawEventRecorder::CreateCheckpoint() {
  NS_ASSERT_OWNINGTHREAD(CanvasDrawEventRecorder);
  int64_t checkpoint = mHeader->eventCount;
  RecordEvent(RecordedCheckpoint());
  ClearProcessedExternalResources();
  return checkpoint;
}

bool CanvasDrawEventRecorder::WaitForCheckpoint(int64_t aCheckpoint) {
  NS_ASSERT_OWNINGTHREAD(CanvasDrawEventRecorder);

  uint32_t spinCount = mMaxSpinCount;
  do {
    if (mHeader->processedCount >= aCheckpoint) {
      return true;
    }
  } while (--spinCount != 0);

  // Publish AboutToWait before rechecking the count so the translator waits
  // for our decision before deciding whether to signal.
  mHeader->writerState = State::AboutToWait;
  if (mHeader->processedCount >= aCheckpoint) {
    mHeader->writerState = State::Processing;
    return true;
  }

  // Publish the target before Waiting so the translator can read it when it
  // sees that we are waiting.
  mHeader->writerWaitCount = aCheckpoint;
  mHeader->writerState = State::Waiting;

  // Use a timed wait to periodically check for reader closure or failure.
  while (!mHelpers->ReaderClosed() && mHeader->readerState != State::Failed) {
    if (mWriterSemaphore->Wait(Some(TimeDuration::FromMilliseconds(100)))) {
      MOZ_ASSERT(mHeader->processedCount >= aCheckpoint);
      return true;
    }
  }

  // Either the reader has failed or we're stopping writing for some other
  // reason (e.g. shutdown), so mark us as failed so the reader is aware.
  mHeader->writerState = State::Failed;
  return false;
}

void CanvasDrawEventRecorder::WriteInternalEvent(EventType aEventType) {
  MOZ_ASSERT(mCurrentBuffer.SizeRemaining() > 0);

  WriteElement(mCurrentBuffer.Writer(), aEventType);
  IncrementEventCount();
}

gfx::ContiguousBuffer& CanvasDrawEventRecorder::GetContiguousBuffer(
    size_t aSize) {
  if (!mCurrentBuffer.IsValid()) {
    // If the current buffer is invalid then we've already failed previously.
    MOZ_ASSERT(mHeader->writerState == State::Failed);
    return mCurrentBuffer;
  }

  // Leave one byte for the end-of-buffer event.
  if (mCurrentBuffer.SizeRemaining() > aSize) {
    return mCurrentBuffer;
  }

  if (mRecycledBuffers.front().Capacity() <= aSize) {
    return AllocateAndSwitchBuffer(aSize);
  }

  const int64_t recycleEventCount = mRecycledBuffers.front().eventCount;
  const bool canReuseNow = recycleEventCount <= mHeader->processedCount;
  if (!canReuseNow) {
    if (mRecycledBuffers.size() < mMaxDefaultBuffers) {
      return AllocateAndSwitchBuffer(aSize);
    }

    // When replaying RECYCLE_BUFFER, NextBuffer checks whether to signal
    // before processedCount includes that event. Wait for the preceding count
    // so this check can wake the writer.
    if (!WaitForCheckpoint(recycleEventCount - 1)) {
      mCurrentBuffer = CanvasBuffer();
      return mCurrentBuffer;
    }
  }

  // Only queue default size buffers for recycling.
  if (mCurrentBuffer.Capacity() == mDefaultBufferSize) {
    WriteInternalEvent(RECYCLE_BUFFER);
    QueueCurrentBufferForReuse();
    SwitchToNextRecycledBuffer();
  } else {
    DropCurrentAndSwitchToNextBuffer();
  }

  // Count reuse switches that leave a spare buffer. Reset the countdown
  // when a reuse switch leaves no spare.
  if (!HasSpareRecycledBuffer()) {
    mBufferDropCountdown = mDropBufferLimit;
  } else if (--mBufferDropCountdown == 0) {
    DropCurrentAndSwitchToNextBuffer();
    mBufferDropCountdown = mDropBufferLimit;
  }

  return mCurrentBuffer;
}

gfx::ContiguousBuffer& CanvasDrawEventRecorder::AllocateAndSwitchBuffer(
    size_t aSize) {
  // Publish the pause event before sending AddBuffer. The translator must
  // finish reading this buffer and enter Paused before handling the message.
  WriteInternalEvent(PAUSE_TRANSLATION);

  // Match the translator's AddBuffer path, which recycles default-sized
  // buffers.
  if (mCurrentBuffer.Capacity() == mDefaultBufferSize) {
    QueueCurrentBufferForReuse();
  }

  size_t bufferSize = std::max(mDefaultBufferSize,
                               ipc::shared_memory::PageAlignedSize(aSize + 1));
  auto newBuffer = CreateAndMapShmem(bufferSize);
  if (NS_WARN_IF(newBuffer.isNothing()) ||
      !mHelpers->AddBuffer(std::move(newBuffer->handle).ToReadOnly())) {
    mHeader->writerState = State::Failed;
    mCurrentBuffer = CanvasBuffer();
    return mCurrentBuffer;
  }

  mCurrentBuffer = CanvasBuffer(std::move(newBuffer->shmem));
  return mCurrentBuffer;
}

void CanvasDrawEventRecorder::DropCurrentAndSwitchToNextBuffer() {
  // Record the switch in the old buffer so the translator can advance to the
  // same queued buffer without recycling the old one.
  WriteInternalEvent(DROP_BUFFER);
  SwitchToNextRecycledBuffer();
}

void CanvasDrawEventRecorder::QueueCurrentBufferForReuse() {
  mRecycledBuffers.emplace(std::move(mCurrentBuffer.shmem),
                           mHeader->eventCount);
}

void CanvasDrawEventRecorder::SwitchToNextRecycledBuffer() {
  MOZ_ASSERT(!mRecycledBuffers.empty());
  mCurrentBuffer = CanvasBuffer(std::move(mRecycledBuffers.front().shmem));
  mRecycledBuffers.pop();
}

bool CanvasDrawEventRecorder::HasSpareRecycledBuffer() const {
  return mRecycledBuffers.size() > 1 &&
         mRecycledBuffers.front().eventCount < mHeader->processedCount;
}

void CanvasDrawEventRecorder::DropFreeBuffers() {
  // If we encountered an error, we may have invalidated mCurrentBuffer in
  // GetContiguousBuffer. We must not make it valid again, because the reader
  // would not know to switch to the new buffer.
  while (mCurrentBuffer.IsValid() && HasSpareRecycledBuffer()) {
    DropCurrentAndSwitchToNextBuffer();
  }

  ClearProcessedExternalResources();
}

void CanvasDrawEventRecorder::IncrementEventCount() {
  mHeader->eventCount++;
  CheckAndSignalReader();
}

void CanvasDrawEventRecorder::CheckAndSignalReader() {
  do {
    switch (mHeader->readerState) {
      case State::Processing:
      case State::Paused:
      case State::Failed:
        return;
      case State::AboutToWait:
        // The reader is making a decision about whether to wait. So, we must
        // wait until it has decided to avoid races. Check if the reader is
        // closed to avoid hangs.
        if (mHelpers->ReaderClosed()) {
          return;
        }
        continue;
      case State::Waiting:
        if (mHeader->processedCount >= mHeader->eventCount) {
          return;
        }

        // The reader can time out and transition to Stopped. Signal only if
        // we win the race to leave Waiting.
        if (mHeader->readerState.compareExchange(State::Waiting,
                                                 State::Processing)) {
          mReaderSemaphore->Signal();
          return;
        }

        // Recheck the state so we can restart a reader that stopped waiting.
        MOZ_ASSERT(mHeader->readerState == State::Stopped);
        continue;
      case State::Stopped:
        if (mHeader->processedCount >= mHeader->eventCount) {
          return;
        }

        mHeader->readerState = State::Processing;
        if (!mHelpers->RestartReader()) {
          mHeader->writerState = State::Failed;
        }
        return;
      default:
        MOZ_ASSERT_UNREACHABLE("Invalid waiting state.");
        return;
    }
  } while (true);
}

void CanvasDrawEventRecorder::DetachResources() {
  NS_ASSERT_OWNINGTHREAD(CanvasDrawEventRecorder);

  DrawEventRecorderPrivate::DetachResources();

  {
    auto lockedPendingDeletions = mPendingDeletions.Lock();
    mWorkerRef = nullptr;
  }
}

void CanvasDrawEventRecorder::QueueProcessPendingDeletionsLocked(
    RefPtr<CanvasDrawEventRecorder>&& aRecorder) {
  if (!mWorkerRef) {
    MOZ_RELEASE_ASSERT(
        !mIsOnWorker,
        "QueueProcessPendingDeletionsLocked called after worker shutdown!");

    NS_DispatchToMainThread(NS_NewRunnableFunction(
        "CanvasDrawEventRecorder::QueueProcessPendingDeletionsLocked",
        [self = std::move(aRecorder)]() { self->ProcessPendingDeletions(); }));
    return;
  }

  if (!NS_IsMainThread()) {
    // MainThreadWorkerRunnable must be created and dispatched on the main
    // thread, so forward the dispatch there first.
    NS_DispatchToMainThread(NS_NewRunnableFunction(
        "CanvasDrawEventRecorder::QueueProcessPendingDeletionsLocked",
        [self = std::move(aRecorder)]() mutable {
          self->QueueProcessPendingDeletions(std::move(self));
        }));
    return;
  }

  class ProcessPendingRunnable final : public dom::MainThreadWorkerRunnable {
   public:
    explicit ProcessPendingRunnable(RefPtr<CanvasDrawEventRecorder>&& aRecorder)
        : dom::MainThreadWorkerRunnable("ProcessPendingRunnable"),
          mRecorder(std::move(aRecorder)) {}

    bool WorkerRun(JSContext*, dom::WorkerPrivate*) override {
      RefPtr<CanvasDrawEventRecorder> recorder = std::move(mRecorder);
      recorder->ProcessPendingDeletions();
      return true;
    }

   private:
    RefPtr<CanvasDrawEventRecorder> mRecorder;
  };

  auto task = MakeRefPtr<ProcessPendingRunnable>(std::move(aRecorder));
  if (NS_WARN_IF(!task->Dispatch(mWorkerRef->Private()))) {
    MOZ_CRASH("ProcessPendingRunnable leaked!");
  }
}

void CanvasDrawEventRecorder::QueueProcessPendingDeletions(
    RefPtr<CanvasDrawEventRecorder>&& aRecorder) {
  auto lockedPendingDeletions = mPendingDeletions.Lock();
  if (lockedPendingDeletions->empty()) {
    // The owning worker may have drained the queue before this task reached
    // the main thread.
    return;
  }

  QueueProcessPendingDeletionsLocked(std::move(aRecorder));
}

void CanvasDrawEventRecorder::AddPendingDeletion(
    std::function<void()>&& aPendingDeletion) {
  PendingDeletionsVector pendingDeletions;

  {
    auto lockedPendingDeletions = mPendingDeletions.Lock();
    bool wasEmpty = lockedPendingDeletions->empty();
    lockedPendingDeletions->emplace_back(std::move(aPendingDeletion));

    MOZ_RELEASE_ASSERT(!mIsOnWorker || mWorkerRef,
                       "AddPendingDeletion called after worker shutdown!");

    const bool isOnOwningThread =
        mWorkerRef ? mWorkerRef->Private()->IsOnCurrentThread()
                   : NS_IsMainThread();
    if (!isOnOwningThread) {
      // Schedule processing only when the first deletion is queued.
      if (wasEmpty) {
        RefPtr<CanvasDrawEventRecorder> self(this);
        QueueProcessPendingDeletionsLocked(std::move(self));
      }
      return;
    }

    // Take the whole queue under the lock and run the callbacks after
    // releasing it.
    pendingDeletions.swap(*lockedPendingDeletions);
  }

  for (const auto& pendingDeletion : pendingDeletions) {
    pendingDeletion();
  }
}

void CanvasDrawEventRecorder::StoreSourceSurfaceRecording(
    gfx::SourceSurface* aSurface, const char* aReason) {
  NS_ASSERT_OWNINGTHREAD(CanvasDrawEventRecorder);

  if (NS_IsMainThread()) {
    wr::ExternalImageId extId{};
    nsresult rv = layers::SharedSurfacesChild::Share(aSurface, extId);
    if (NS_SUCCEEDED(rv)) {
      StoreExternalSurfaceRecording(aSurface, wr::AsUint64(extId));
      mExternalSurfaces.back().mEventCount = mHeader->eventCount;
      return;
    }
  }

  DrawEventRecorderPrivate::StoreSourceSurfaceRecording(aSurface, aReason);
}

void CanvasDrawEventRecorder::StoreImageRecording(
    const RefPtr<Image>& aImageOfSurfaceDescriptor, const char* aReasony) {
  NS_ASSERT_OWNINGTHREAD(CanvasDrawEventRecorder);

  StoreExternalImageRecording(aImageOfSurfaceDescriptor);
  mExternalImages.back().mEventCount = mHeader->eventCount;

  ClearProcessedExternalImages();
}

template <typename Holder>
static void ClearProcessedEntries(Holder& aEntries, int64_t aProcessedCount) {
  // Find the first entry that has not been processed.
  auto it = aEntries.begin();
  while (it != aEntries.end() && it->mEventCount <= aProcessedCount) {
    ++it;
  }
  // Erase any processed entries up to the unprocessed entry.
  if (it != aEntries.begin()) {
    aEntries.erase(aEntries.begin(), it);
  }
}

void CanvasDrawEventRecorder::ClearProcessedExternalResources() {
  ClearProcessedEntries(mExternalSurfaces, mHeader->processedCount);
  // Read processedCount again for images because the translator may have
  // made progress while the surface references were being released.
  ClearProcessedExternalImages();
}

void CanvasDrawEventRecorder::ClearProcessedExternalImages() {
  ClearProcessedEntries(mExternalImages, mHeader->processedCount);
}

}  // namespace layers
}  // namespace mozilla
