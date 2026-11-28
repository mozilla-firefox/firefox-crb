/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef mozilla_layers_CanvasDrawEventRecorder_h
#define mozilla_layers_CanvasDrawEventRecorder_h

#include <queue>

#include "mozilla/Atomics.h"
#include "mozilla/RefPtr.h"
#include "mozilla/UniquePtr.h"
#include "mozilla/gfx/DrawEventRecorder.h"
#include "mozilla/ipc/CrossProcessSemaphore.h"
#include "mozilla/ipc/SharedMemoryMapping.h"
#include "mozilla/layers/LayersTypes.h"

namespace mozilla {

using EventType = gfx::RecordedEvent::EventType;

namespace dom {
class ThreadSafeWorkerRef;
}

namespace layers {

typedef mozilla::CrossProcessSemaphoreHandle CrossProcessSemaphoreHandle;

class CanvasDrawEventRecorder final : public gfx::DrawEventRecorderPrivate,
                                      public gfx::ContiguousBufferStream {
 public:
  MOZ_DECLARE_REFCOUNTED_VIRTUAL_TYPENAME(CanvasDrawEventRecorder, final)

  explicit CanvasDrawEventRecorder(dom::ThreadSafeWorkerRef* aWorkerRef);
  ~CanvasDrawEventRecorder() override;

  // State of either endpoint of the shared event stream.
  enum class State : uint32_t {
    // Recording or replay is active or about to resume.
    Processing,

    // Publish this before rechecking for progress. The peer waits for the
    // decision so it cannot miss a transition to Waiting or Stopped.
    AboutToWait,

    // Blocked on the endpoint's cross-process semaphore.
    Waiting,

    // The translator paused replay until a follow-up IPC message arrives.
    Paused,

    // The translator is idle. The recorder requests a restart when it
    // publishes more events.
    Stopped,

    // The endpoint encountered a failure and cannot continue.
    Failed,
  };

  // Shared control block for the recorder (writer) and translator (reader).
  // Both sides publish progress here and can update the peer's state when
  // waking it.
  struct Header {
    // Number of events the recorder has published to the stream.
    Atomic<int64_t> eventCount;
    // Processed event count the recorder is waiting for.
    Atomic<int64_t> writerWaitCount;
    Atomic<State> writerState;
    // Keep the writer and reader field groups apart in shared memory.
    uint8_t padding1[44];
    // Number of events the translator has finished processing. A signal sent
    // during replay of an event precedes that event's increment.
    Atomic<int64_t> processedCount;
    Atomic<State> readerState;
  };

  class Helpers {
   public:
    virtual ~Helpers() = default;

    virtual bool InitTranslator(
        TextureType aTextureType, TextureType aWebglTextureType,
        gfx::BackendType aBackendType,
        ipc::MutableSharedMemoryHandle&& aReadHandle,
        nsTArray<ipc::ReadOnlySharedMemoryHandle>&& aBufferHandles,
        CrossProcessSemaphoreHandle&& aReaderSem,
        CrossProcessSemaphoreHandle&& aWriterSem) = 0;

    virtual bool AddBuffer(ipc::ReadOnlySharedMemoryHandle&& aBufferHandle) = 0;

    /**
     * @returns true if the canvas actor exists and either IPC can no longer
     *          be sent or application shutdown is impending.
     */
    virtual bool ReaderClosed() = 0;

    /**
     * Causes the reader to resume processing when it is in a stopped state.
     */
    virtual bool RestartReader() = 0;

    virtual already_AddRefed<layers::CanvasChild> GetCanvasChild() const = 0;
  };

  bool Init(TextureType aTextureType, TextureType aWebglTextureType,
            gfx::BackendType aBackendType, UniquePtr<Helpers> aHelpers);

  using DrawEventRecorderPrivate::RecordEvent;

  /**
   * Record an event for processing by the CanvasParent's CanvasTranslator.
   * @param aEvent the event to record
   */
  void RecordEvent(const gfx::RecordedEvent& aEvent) final;

  void DetachResources() final;

  void AddPendingDeletion(std::function<void()>&& aPendingDeletion) override;

  void StoreSourceSurfaceRecording(gfx::SourceSurface* aSurface,
                                   const char* aReason) final;

  void StoreImageRecording(const RefPtr<Image>& aImageOfSurfaceDescriptor,
                           const char* aReasony) final;

  gfx::RecorderType GetRecorderType() const override {
    return gfx::RecorderType::CANVAS;
  }

  void Flush() final { NS_ASSERT_OWNINGTHREAD(CanvasDrawEventRecorder); }

  // Record a checkpoint marker and return the event count before recording it.
  int64_t CreateCheckpoint();

  /**
   * Wait for the translator's processed event count to reach aCheckpoint.
   *
   * @param aCheckpoint the processed event count to wait for
   * @returns true if the count was reached, false if the reader closes or
   *          fails while waiting
   */
  bool WaitForCheckpoint(int64_t aCheckpoint);

  TextureType GetTextureType() { return mTextureType; }

  bool HasInvalidCurrentBuffer() { return !mCurrentBuffer.IsValid(); }

  void DropFreeBuffers();

  // Release references to external surfaces and images already processed by
  // the translator.
  void ClearProcessedExternalResources();

  already_AddRefed<layers::CanvasChild> GetCanvasChild() const override {
    return mHelpers->GetCanvasChild();
  }

 protected:
  gfx::ContiguousBuffer& GetContiguousBuffer(size_t aSize) final;

  void IncrementEventCount() final;

 private:
  void WriteInternalEvent(EventType aEventType);

  // Allocate a buffer with room for aSize bytes of event data and make it
  // current. Return a reference to mCurrentBuffer. If allocation or sending
  // fails, mark the writer as failed and invalidate mCurrentBuffer first.
  gfx::ContiguousBuffer& AllocateAndSwitchBuffer(size_t aSize);

  // Discard the current buffer and switch to the first recycled buffer.
  // The caller must ensure the current buffer is valid and the first recycled
  // buffer is ready for reuse.
  void DropCurrentAndSwitchToNextBuffer();

  // Move the default-sized current buffer into the reuse queue. Call this
  // after recording the event that ends the current buffer.
  void QueueCurrentBufferForReuse();

  // Take the first recycled buffer as the current buffer. The caller must
  // ensure it is ready for reuse and record the switch in the old buffer
  // before calling this.
  void SwitchToNextRecycledBuffer();

  // Return true if the queue has at least two buffers and processedCount is
  // strictly greater than the event count stored with the first buffer.
  bool HasSpareRecycledBuffer() const;

  void ClearProcessedExternalImages();

  void CheckAndSignalReader();

  void QueueProcessPendingDeletions(
      RefPtr<CanvasDrawEventRecorder>&& aRecorder);
  void QueueProcessPendingDeletionsLocked(
      RefPtr<CanvasDrawEventRecorder>&& aRecorder);

  size_t mDefaultBufferSize;
  size_t mMaxDefaultBuffers;
  uint32_t mMaxSpinCount;
  uint32_t mDropBufferLimit;
  // Remaining reuse switches that must leave a spare buffer before an
  // automatic drop. Reset to mDropBufferLimit after an automatic drop or
  // when a reuse switch leaves no spare buffer.
  uint32_t mBufferDropCountdown;

  UniquePtr<Helpers> mHelpers;

  TextureType mTextureType = TextureType::Unknown;
  ipc::SharedMemoryMapping mHeaderShmem;
  Header* mHeader = nullptr;

  struct CanvasBuffer : public gfx::ContiguousBuffer {
    ipc::SharedMemoryMapping shmem;

    CanvasBuffer() : ContiguousBuffer(nullptr) {}

    explicit CanvasBuffer(ipc::SharedMemoryMapping&& aShmem)
        : ContiguousBuffer(aShmem.DataAs<char>(), aShmem.Size()),
          shmem(std::move(aShmem)) {}

    size_t Capacity() { return shmem ? shmem.Size() : 0; }
  };

  struct RecycledBuffer {
    ipc::SharedMemoryMapping shmem;
    // The recorder's event count after recording RECYCLE_BUFFER or
    // PAUSE_TRANSLATION for this buffer. The initial spare starts at zero.
    int64_t eventCount = 0;
    explicit RecycledBuffer(ipc::SharedMemoryMapping&& aShmem,
                            int64_t aEventCount)
        : shmem(std::move(aShmem)), eventCount(aEventCount) {}
    size_t Capacity() { return shmem.Size(); }
  };

  CanvasBuffer mCurrentBuffer;
  std::queue<RecycledBuffer> mRecycledBuffers;

  // The recorder waits here and the translator signals it at the target count.
  UniquePtr<CrossProcessSemaphore> mWriterSemaphore;
  // The recorder signals this to wake a translator in State::Waiting.
  UniquePtr<CrossProcessSemaphore> mReaderSemaphore;

  RefPtr<dom::ThreadSafeWorkerRef> mWorkerRef;
  bool mIsOnWorker = false;
};

}  // namespace layers
}  // namespace mozilla

#endif  // mozilla_layers_CanvasDrawEventRecorder_h
