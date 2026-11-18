/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef DOM_WEBTRANSPORT_API_WEBTRANSPORTSENDSTREAM_H_
#define DOM_WEBTRANSPORT_API_WEBTRANSPORTSENDSTREAM_H_

#include "WebTransportFraming.h"
#include "mozilla/Queue.h"
#include "mozilla/dom/WritableStream.h"
#include "nsIAsyncOutputStream.h"

namespace mozilla::ipc {
class DataPipeSender;
}

namespace mozilla::dom {

class WebTransport;
class WebTransportSendGroup;
class WebTransportWriter;
class Promise;

// Represents a pending write operation (either regular write or atomic write)
// queued for writing to the DataPipe
struct PendingWriteEntry {
  nsTArray<uint8_t> mData;
  Maybe<uint32_t> mAtomicWriteId;
  RefPtr<Promise>
      mPromise;  // Resolved when drained (for WritableStream progress)

  // Pre-framed header to avoid repeated framing/copying
  uint8_t mHeader[WEBTRANSPORT_FRAME_MAX_HEADER_SIZE];
  uint32_t mHeaderLen;  // Actual header length (5 for Regular, 9 for Atomic)

  // Track partial writes separately for header and data
  uint32_t mHeaderBytesWritten{0};
  uint32_t mDataBytesWritten{0};
};

class WebTransportSendStream final : public WritableStream,
                                     public nsIOutputStreamCallback {
 public:
  NS_DECL_ISUPPORTS_INHERITED
  NS_DECL_CYCLE_COLLECTION_CLASS_INHERITED(WebTransportSendStream,
                                           WritableStream)
  NS_DECL_NSIOUTPUTSTREAMCALLBACK

  WebTransportSendStream(nsIGlobalObject* aGlobal, WebTransport* aTransport);

  static already_AddRefed<WebTransportSendStream> Create(
      WebTransport* aWebTransport, nsIGlobalObject* aGlobal, uint64_t aStreamId,
      mozilla::ipc::DataPipeSender* aSender, int64_t aSendOrder,
      WebTransportSendGroup* aSendGroup, ErrorResult& aRv);

  // WebIDL Boilerplate
  JSObject* WrapObject(JSContext* aCx,
                       JS::Handle<JSObject*> aGivenProto) override;

  // WebIDL Interface
  int64_t SendOrder() { return mSendOrder; }

  void SetSendOrder(int64_t aSendOrder);

  WebTransportSendGroup* GetSendGroup() { return mSendGroup; }

  void SetSendGroup(WebTransportSendGroup* aSendGroup, ErrorResult& aRv);

  already_AddRefed<Promise> GetStats();

  already_AddRefed<WebTransportWriter> GetWriter(ErrorResult& aRv);

  uint64_t GetBytesWritten() const { return mBytesWritten; }
  uint64_t GetCommittedOffset() const { return mCommittedOffset; }
  void SetCommittedOffset(uint64_t aOffset) { mCommittedOffset = aOffset; }

  uint64_t GetStreamId() const { return mStreamId; }
  WebTransport* GetTransport() const { return mTransport; }

  mozilla::ipc::DataPipeSender* GetDataPipeSender() const { return mSender; }

  // Enqueue a write operation (from WriteCallbackImpl)
  void EnqueueWrite(PendingWriteEntry&& aEntry);

  // Attempt to drain the write queue to the DataPipe
  void DrainQueue();

  // [[InsideSynchronousAtomicWrite]] slot — set before delegating to write()
  // so WriteCallbackImpl can detect and configure the entry as atomic.
  Maybe<uint32_t> GetPendingAtomicWriteId() const {
    return mPendingAtomicWriteId;
  }
  void SetPendingAtomicWriteId(uint32_t aId) {
    mPendingAtomicWriteId = Some(aId);
  }
  void ClearPendingAtomicWriteId() { mPendingAtomicWriteId = Nothing(); }

  // [[AtomicWriteRequests]] — tracks IDs of all in-flight atomic writes
  // (both queued and sent) so AbortCallbackImpl can reject their promises.
  void TrackAtomicWriteId(uint32_t aId) {
    mPendingAtomicWriteIds.AppendElement(aId);
  }
  void UntrackAtomicWriteId(uint32_t aId) {
    mPendingAtomicWriteIds.RemoveElement(aId);
  }
  nsTArray<uint32_t> TakeAtomicWriteIds() {
    return std::move(mPendingAtomicWriteIds);
  }

  // Returns the atomicWriteId for aPromise (and removes the entry), or Nothing
  Maybe<uint32_t> TakeAtomicWriteId(Promise* aPromise) {
    for (size_t i = 0; i < mAtomicWriteReqPromises.Length(); i++) {
      if (mAtomicWriteReqPromises[i] == aPromise) {
        uint32_t id = mAtomicWriteReqIds[i];
        mAtomicWriteReqPromises.RemoveElementAt(i);
        mAtomicWriteReqIds.RemoveElementAt(i);
        return Some(id);
      }
    }
    return Nothing();
  }

  void TrackAtomicWriteRequest(Promise* aPromise, uint32_t aId) {
    mAtomicWriteReqPromises.AppendElement(aPromise);
    mAtomicWriteReqIds.AppendElement(aId);
  }

  // https://w3c.github.io/webtransport/#webtransportsendstream-abort-all-atomic-write-requests
  void AbortAllAtomicWriteRequests();

 private:
  ~WebTransportSendStream() override;

  // Helper to write buffer to DataPipe with AsyncWait handling
  // Returns: true if write complete, false if needs to wait or error occurred
  bool WriteBufferToDataPipe(const uint8_t* aBuffer, uint32_t aTotalSize,
                             uint32_t& aBytesWritten, const char* aPhase);

  // We must hold a reference to the WebTransport so it can't go away on
  // us.  This forms a cycle with WebTransport that will be broken when the
  // CC runs.   WebTransport::CleanUp() will destroy all the send and receive
  // streams, breaking the cycle.
  RefPtr<WebTransport> mTransport;
  RefPtr<WebTransportSendGroup> mSendGroup;
  RefPtr<mozilla::ipc::DataPipeSender> mSender;
  uint64_t mStreamId;
  int64_t mSendOrder;
  uint64_t mBytesWritten{0};
  uint64_t mCommittedOffset{0};

  // Queue of pending write operations (both regular and atomic writes)
  mozilla::Queue<PendingWriteEntry> mPendingWrites;

  // [[InsideSynchronousAtomicWrite]] — atomicWriteId set during AtomicWrite()
  // so WriteCallbackImpl (called synchronously from Write()) can read it.
  Maybe<uint32_t> mPendingAtomicWriteId;

  // [[AtomicWriteRequests]] — IDs of all in-flight atomic writes
  nsTArray<uint32_t> mPendingAtomicWriteIds;

  // Maps write request promises → atomicWriteIds for writes queued by
  // WritableStream (async case: WriteCallbackImpl called after Write() returns)
  nsTArray<RefPtr<Promise>> mAtomicWriteReqPromises;
  nsTArray<uint32_t> mAtomicWriteReqIds;

  // True if we're waiting for AsyncWait callback
  bool mWaitingForDrain{false};
};

}  // namespace mozilla::dom

#endif
