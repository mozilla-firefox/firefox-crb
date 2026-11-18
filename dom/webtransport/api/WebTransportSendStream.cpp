/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "mozilla/dom/WebTransportSendStream.h"

#include "mozilla/CycleCollectedJSContext.h"
#include "mozilla/dom/AbortFollower.h"
#include "mozilla/dom/Promise.h"
#include "mozilla/dom/ScriptSettings.h"
#include "mozilla/dom/UnderlyingSinkCallbackHelpers.h"
#include "mozilla/dom/WebTransport.h"
#include "mozilla/dom/WebTransportFraming.h"
#include "mozilla/dom/WebTransportLog.h"
#include "mozilla/dom/WebTransportSendGroup.h"
#include "mozilla/dom/WebTransportSendReceiveStreamBinding.h"
#include "mozilla/dom/WebTransportSendStreamAlgorithms.h"
#include "mozilla/dom/WebTransportWriter.h"
#include "mozilla/dom/WritableStream.h"
#include "mozilla/dom/WritableStreamDefaultWriter.h"
#include "mozilla/ipc/DataPipe.h"

using namespace mozilla::ipc;

namespace mozilla::dom {

// The mozilla::Queue helpers are global, and the binding headers declare
// overloads in this namespace that would otherwise hide them.
using ::ImplCycleCollectionTraverse;
using ::ImplCycleCollectionUnlink;

NS_IMPL_CYCLE_COLLECTION_INHERITED(WebTransportSendStream, WritableStream,
                                   mTransport, mSendGroup, mSender,
                                   mPendingOperation, mAbortWatcher,
                                   mAtomicWriteReqPromises, mPendingWrites,
                                   mUnconfirmedAtomicWrites)
NS_IMPL_ADDREF_INHERITED(WebTransportSendStream, WritableStream)
NS_IMPL_RELEASE_INHERITED(WebTransportSendStream, WritableStream)
NS_INTERFACE_MAP_BEGIN_CYCLE_COLLECTION(WebTransportSendStream)
  NS_INTERFACE_MAP_ENTRY(nsIOutputStreamCallback)
  NS_INTERFACE_MAP_ENTRY_AMBIGUOUS(nsISupports, WritableStream)
NS_INTERFACE_MAP_END_INHERITING(WritableStream)

WebTransportSendStream::WebTransportSendStream(nsIGlobalObject* aGlobal,
                                               WebTransport* aTransport)
    : WritableStream(aGlobal,
                     WritableStream::HoldDropJSObjectsCaller::Explicit),
      mTransport(aTransport) {
  mozilla::HoldJSObjects(this);
}

WebTransportSendStream::~WebTransportSendStream() {
  mozilla::DropJSObjects(this);
}

JSObject* WebTransportSendStream::WrapObject(
    JSContext* aCx, JS::Handle<JSObject*> aGivenProto) {
  return WebTransportSendStream_Binding::Wrap(aCx, this, aGivenProto);
}

// NOTE: this does not yet implement SendOrder; see bug 1816925
/* static */
namespace {

// https://w3c.github.io/webtransport/#send-stream-procedures
// "create a WebTransportSendStream" step 7: the steps added to the
// controller's abort signal. The work itself lives on the sink, which owns
// the close/abort algorithms.
class SendStreamAbortWatcher final : public AbortFollower {
 public:
  NS_DECL_CYCLE_COLLECTING_ISUPPORTS
  NS_DECL_CYCLE_COLLECTION_CLASS(SendStreamAbortWatcher)

  explicit SendStreamAbortWatcher(WebTransportSendStreamAlgorithms* aAlgorithms)
      : mAlgorithms(aAlgorithms) {}

  void RunAbortAlgorithm() override {
    RefPtr<WebTransportSendStreamAlgorithms> algorithms = mAlgorithms;
    if (algorithms) {
      algorithms->RunAbortSignalSteps(Signal());
    }
  }

 private:
  ~SendStreamAbortWatcher() = default;

  RefPtr<WebTransportSendStreamAlgorithms> mAlgorithms;
};

NS_IMPL_CYCLE_COLLECTION(SendStreamAbortWatcher, mAlgorithms)
NS_IMPL_CYCLE_COLLECTING_ADDREF(SendStreamAbortWatcher)
NS_IMPL_CYCLE_COLLECTING_RELEASE(SendStreamAbortWatcher)
NS_INTERFACE_MAP_BEGIN_CYCLE_COLLECTION(SendStreamAbortWatcher)
  NS_INTERFACE_MAP_ENTRY(nsISupports)
NS_INTERFACE_MAP_END

}  // namespace

already_AddRefed<WebTransportSendStream> WebTransportSendStream::Create(
    WebTransport* aWebTransport, nsIGlobalObject* aGlobal, uint64_t aStreamId,
    DataPipeSender* aSender, int64_t aSendOrder,
    WebTransportSendGroup* aSendGroup, ErrorResult& aRv) {
  // https://w3c.github.io/webtransport/#webtransportsendstream-create
  AutoJSAPI jsapi;
  if (!jsapi.Init(aGlobal)) {
    return nullptr;
  }
  JSContext* cx = jsapi.cx();

  auto stream = MakeRefPtr<WebTransportSendStream>(aGlobal, aWebTransport);

  stream->mStreamId = aStreamId;
  stream->mSendGroup = aSendGroup;
  // The parent only sends a UnidirectionalStream/BidirectionalStream response
  // with a valid sender (a NewDataPipe failure resolves the error variant), and
  // callers reject other response types, so aSender is always non-null here.
  // The underlying sink created below dereferences it unconditionally.
  MOZ_ASSERT(aSender);
  stream->mSender = aSender;

  stream->mSendOrder = aSendOrder;

  // Use custom underlying sink that frames all writes
  // NOTE: Must create after setting mStreamId, mSender since sink uses them
  auto algorithms = MakeRefPtr<WebTransportSendStreamAlgorithms>(
      stream->GetParentObject(), stream);

  // Steps 2-5
  RefPtr<QueuingStrategySize> writableSizeAlgorithm;
  stream->SetUpNative(cx, *algorithms, Nothing(), writableSizeAlgorithm, aRv);

  // Step 6: Let abortSignal be stream's [[controller]].[[abortController]].
  // [[signal]].
  // Step 7: Add the following steps to abortSignal. (7.1-7.6 implemented in
  // WebTransportSendStreamAlgorithms::RunAbortSignalSteps.)
  if (WritableStreamDefaultController* controller = stream->Controller()) {
    if (AbortSignal* signal = controller->Signal()) {
      stream->mAbortWatcher = new SendStreamAbortWatcher(algorithms);
      stream->mAbortWatcher->Follow(signal);
    }
  }

  // Step 8: Append stream to transport.[[SendStreams]].
  aWebTransport->mSendStreams.InsertOrUpdate(aStreamId, stream);
  // Step 9: Return stream.
  return stream.forget();
}

void WebTransportSendStream::SetSendOrder(int64_t aSendOrder) {
  mSendOrder = aSendOrder;
  mTransport->SendSetSendOrder(mStreamId, aSendOrder);
}

void WebTransportSendStream::SetSendGroup(WebTransportSendGroup* aSendGroup,
                                          ErrorResult& aRv) {
  // https://w3c.github.io/webtransport/#send-stream-attributes (sendGroup
  // setter)

  // Step 1: If value is non-null and value.[[Transport]] ≠
  // this.[[Transport]], throw an "InvalidStateError" DOMException.
  if (aSendGroup && aSendGroup->GetTransport() != mTransport) {
    aRv.ThrowInvalidStateError("SendGroup belongs to different transport");
    return;
  }
  // Step 2: Set this.[[SendGroup]] to value.
  mSendGroup = aSendGroup;
  // Propagate the new send group to the parent process so the neqo scheduler
  // sees the updated group assignment. groupId 0 means no group (null
  // sendGroup).
  uint64_t groupId = aSendGroup ? aSendGroup->GetGroupId() : 0;
  mTransport->SendSetSendGroup(mStreamId, groupId);
}

already_AddRefed<Promise> WebTransportSendStream::GetStats() {
  RefPtr<Promise> promise = Promise::CreateInfallible(WritableStream::mGlobal);
  promise->MaybeRejectWithNotSupportedError("GetStats isn't supported yet");
  return promise.forget();
}

// https://w3c.github.io/webtransport/#dom-webtransportsendstream-getwriter
// https://w3c.github.io/webtransport/#webtransportwriter-create
already_AddRefed<WebTransportWriter> WebTransportSendStream::GetWriter(
    ErrorResult& aRv) {
  RefPtr<WebTransportWriter> writer =
      new WebTransportWriter(GetParentObject(), this);

  writer->SetUp(this, aRv);
  if (aRv.Failed()) {
    return nullptr;
  }

  return writer.forget();
}

void WebTransportSendStream::EnqueueWrite(PendingWriteEntry&& aEntry) {
  LOG(
      ("WebTransportSendStream::EnqueueWrite streamId=%llu, isAtomic=%d, "
       "dataLen=%zu",
       (unsigned long long)mStreamId, aEntry.mAtomicWriteId.isSome(),
       aEntry.mData.Length()));

  mPendingWrites.Push(std::move(aEntry));
}

bool WebTransportSendStream::WriteBufferToDataPipe(const uint8_t* aBuffer,
                                                   uint32_t aTotalSize,
                                                   uint32_t& aBytesWritten,
                                                   const char* aPhase) {
  // Loop until all bytes written, would block, or error
  while (aBytesWritten < aTotalSize) {
    uint32_t remaining = aTotalSize - aBytesWritten;
    const uint8_t* ptr = aBuffer + aBytesWritten;
    uint32_t written = 0;
    nsresult rv =
        mSender->Write(reinterpret_cast<const char*>(ptr), remaining, &written);

    LOG(("DataPipe Write %s: rv=0x%x, written=%u, remaining=%u", aPhase,
         static_cast<uint32_t>(rv), written, remaining));

    if (written > 0) {
      aBytesWritten += written;
      // Continue loop to try writing more
      continue;
    }

    // No progress made: a hard error (anything other than WOULD_BLOCK)
    if (NS_FAILED(rv) && rv != NS_BASE_STREAM_WOULD_BLOCK) {
      LOG(("DataPipe write error during %s: rv=0x%x", aPhase,
           static_cast<uint32_t>(rv)));
      mPendingWrites.Iterate([](PendingWriteEntry& pendingEntry) {
        pendingEntry.mPromise->MaybeRejectWithInvalidStateError(
            "Failed to write to DataPipe");
      });
      mPendingWrites.Clear();
      return false;  // Error occurred
    }

    // WOULD_BLOCK, or success with no bytes written: pipe is full - wait for
    // space using AsyncWait
    LOG(("DataPipe full during %s write, waiting via AsyncWait", aPhase));
    mWaitingForDrain = true;
    rv = mSender->AsyncWait(this, 0, 0, GetCurrentSerialEventTarget());
    if (NS_FAILED(rv)) {
      LOG(("AsyncWait failed: rv=0x%x", static_cast<uint32_t>(rv)));
      mWaitingForDrain = false;
      mPendingWrites.Iterate([](PendingWriteEntry& pendingEntry) {
        pendingEntry.mPromise->MaybeRejectWithInvalidStateError(
            "Failed to wait for DataPipe space");
      });
      mPendingWrites.Clear();
    }
    return false;  // Need to wait
  }

  return true;  // All bytes written
}

void WebTransportSendStream::DrainQueue() {
  LOG((
      "WebTransportSendStream::DrainQueue streamId=%llu, queueLength=%zu, "
      "waiting=%d",
      (unsigned long long)mStreamId, mPendingWrites.Count(), mWaitingForDrain));

  if (mWaitingForDrain) {
    // Already waiting for AsyncWait callback
    return;
  }

  while (!mPendingWrites.IsEmpty()) {
    PendingWriteEntry& entry = mPendingWrites.FirstElement();

    // Phase 1: Write header
    if (!WriteBufferToDataPipe(entry.mHeader, entry.mHeaderLen,
                               entry.mHeaderBytesWritten, "header")) {
      return;  // Waiting or error
    }

    // Phase 2: Write data
    if (!WriteBufferToDataPipe(entry.mData.Elements(), entry.mData.Length(),
                               entry.mDataBytesWritten, "data")) {
      return;  // Waiting or error
    }

    // Entry complete - settle promise and remove
    if (entry.mAtomicWriteId) {
      // An atomic write's bytes being in the DataPipe says nothing about
      // whether they fit the flow-control window; only the parent's
      // AtomicWriteResult does. Keep its write request unsettled until then
      // so the atomic write stays the in-flight one and WritableStream
      // dispatches nothing behind it: a later failure can then reject the
      // whole pipeline, which is what the spec's "abort all atomic write
      // requests" assumes. abort() waits on that round trip too, since a
      // write request in flight blocks erroring; atomic writes are rare and
      // small enough that the stall beats diverging from Streams.
      //
      // [[BytesWritten]] only counts it once confirmed.
      mUnconfirmedAtomicBytes = entry.mData.Length();
      mUnconfirmedAtomicWrites.InsertOrUpdate(*entry.mAtomicWriteId,
                                              entry.mPromise);
    } else {
      mBytesWritten += entry.mData.Length();
      entry.mPromise->MaybeResolveWithUndefined();
    }

    mPendingWrites.Pop();
  }

  LOG(("DrainQueue complete, queue empty"));
}

void WebTransportSendStream::ResolveAtomicWriteRequest(uint32_t aId,
                                                       bool aConfirmed) {
  RefPtr<Promise> promise;
  if (auto entry = mUnconfirmedAtomicWrites.Lookup(aId)) {
    promise = entry.Data();
    entry.Remove();
  }
  if (!promise) {
    return;
  }
  LOG(("WebTransportSendStream::ResolveAtomicWriteRequest streamId=%llu, id=%u",
       (unsigned long long)mStreamId, aId));
  if (aConfirmed) {
    mBytesWritten += mUnconfirmedAtomicBytes;
  }
  mUnconfirmedAtomicBytes = 0;
  // Settling the write request runs it through the normal
  // FinishInFlightWrite() path, which is what clears
  // [[inFlightWriteRequest]] and lets the stream make progress (close, error
  // or the next write). That only happens once SpiderMonkey processes the
  // resolution as a microtask, and our caller is an IPC message handler
  // rather than script execution, so force a checkpoint here.
  nsAutoMicroTask mt;
  promise->MaybeResolveWithUndefined();
}

void WebTransportSendStream::RejectUnconfirmedAtomicWrites(
    JS::Handle<JS::Value> aReason) {
  if (mUnconfirmedAtomicWrites.IsEmpty()) {
    return;
  }
  LOG(("WebTransportSendStream::RejectUnconfirmedAtomicWrites streamId=%llu",
       (unsigned long long)mStreamId));
  nsTArray<RefPtr<Promise>> promises;
  for (const auto& promise : mUnconfirmedAtomicWrites.Values()) {
    promises.AppendElement(promise);
  }
  mUnconfirmedAtomicWrites.Clear();
  mUnconfirmedAtomicBytes = 0;
  // Rejecting takes the FinishInFlightWriteWithError() path, which errors the
  // stream.
  for (const auto& promise : promises) {
    promise->MaybeReject(aReason);
  }
}

void WebTransportSendStream::RejectPendingWrites(
    JS::Handle<JS::Value> aReason) {
  nsTArray<RefPtr<Promise>> promises;
  mPendingWrites.Iterate([&](PendingWriteEntry& aEntry) {
    promises.AppendElement(aEntry.mPromise);
  });
  mPendingWrites.Clear();
  for (const auto& promise : promises) {
    promise->MaybeReject(aReason);
  }
}

// https://w3c.github.io/webtransport/#webtransportsendstream-abort-all-atomic-write-requests
void WebTransportSendStream::AbortAllAtomicWriteRequests(uint32_t aFailedId) {
  LOG(("WebTransportSendStream::AbortAllAtomicWriteRequests streamId=%llu",
       (unsigned long long)mStreamId));

  WebTransport* transport = mTransport;
  if (!transport) {
    return;
  }

  // Step 1: Let writeRequests be stream.writeRequests.
  // Step 2: Let requestsToAbort be stream.[[AtomicWriteRequests]].
  // Step 3: If writeRequests contains a promise not in requestsToAbort,
  //         then error stream with AbortError, and abort these steps.
  // requestsToAbort always contains the write currently in flight -- this
  // only runs for its own flow-control failure -- so it is exactly one
  // bigger than the atomic subset of writeRequests, which excludes the
  // in-flight one. writeRequests reaching parity with it therefore means
  // every queued write is atomic; anything beyond that is a non-atomic one.
  // mPendingAtomicWriteIds is used rather than mAtomicWriteReqPromises,
  // which can already be missing the in-flight write's own entry:
  // WriteCallbackImpl removes it there at dispatch time for a write that
  // was deferred rather than sent synchronously.
  bool hasNonAtomic = WriteRequestCount() >= mPendingAtomicWriteIds.Length();

  // Step 4: Empty stream.[[AtomicWriteRequests]].
  nsTArray<uint32_t> atomicWriteIds = std::move(mPendingAtomicWriteIds);

  // Step 5: For each promise in requestsToAbort, reject promise with
  //         AbortError.
  //
  // Per spec this promise (p, per atomicWrite()'s algorithm) is the same
  // object as the write-request promise that erroring the stream rejects on
  // its own, so the spec's step 3 skips straight past 4-6 when it errors
  // the stream instead. Our atomicWrite() (WebTransportWriter::AtomicWrite)
  // returns a *separate* user-facing promise, decoupled from the sink's own
  // write-progress promise -- nothing else settles it, so it must be
  // rejected here explicitly regardless of which branch runs below.
  for (uint32_t atomicWriteId : atomicWriteIds) {
    LOG(("  Rejecting sent atomic write id=%u", atomicWriteId));
    RefPtr<Promise> promise = transport->TakeAtomicWritePromise(atomicWriteId);
    if (promise) {
      promise->MaybeRejectWithAbortError(
          "Atomic write failed - insufficient flow control window"_ns);
    }
  }

  if (hasNonAtomic) {
    // Step 3, continued: "then error stream with AbortError, and abort these
    // steps."  Rejecting the failed atomic write's own write request -- still
    // in flight, holding everything else back -- is what errors it, via the
    // standard FinishInFlightWriteWithError() -> WritableStreamStartErroring()
    // path, which also rejects the write requests queued behind it.
    LOG(("  Non-atomic write pending, erroring stream"));
    AutoJSAPI jsapi;
    if (jsapi.Init(GetParentObject())) {
      JSContext* cx = jsapi.cx();
      JS::Rooted<JS::Value> error(cx);
      ErrorResult rv;
      rv.ThrowAbortError(
          "Non-atomic writes queued behind atomic writes during abort");
      MOZ_ASSERT(rv.Failed());
      rv.WouldReportJSException();
      if (ToJSValue(cx, std::move(rv), &error)) {
        RejectUnconfirmedAtomicWrites(error);
      }
    }
    return;
  }

  // Only atomic writes are pending, so the stream must stay open and just
  // the individual atomicWrite() promises reject -- which happened above.
  // Their write requests are therefore resolved, not rejected: rejecting
  // one runs FinishInFlightWriteWithError(), which errors the whole stream.
  //
  // Step 6: In parallel, for each promise in requestsToAbort, abort the
  //         sending of bytes associated with promise.
  // Only aFailedId's write request is in flight; the others are still queued
  // in the WritableStream and have not been sent.  Record them as cancelled
  // first, since resolving aFailedId's request is what dispatches the next
  // queued write, and WriteCallbackImpl then drops each cancelled one
  // instead of sending it.
  for (uint32_t atomicWriteId : atomicWriteIds) {
    if (atomicWriteId != aFailedId) {
      mCancelledAtomicWriteIds.AppendElement(atomicWriteId);
    }
  }
  LOG(("  Completing atomic write id=%u without erroring stream", aFailedId));
  ResolveAtomicWriteRequest(aFailedId, /* aConfirmed = */ false);
}

NS_IMETHODIMP WebTransportSendStream::OnOutputStreamReady(
    nsIAsyncOutputStream* aStream) {
  LOG(("WebTransportSendStream::OnOutputStreamReady streamId=%llu",
       (unsigned long long)mStreamId));

  mWaitingForDrain = false;

  // Resume draining the queue
  DrainQueue();

  return NS_OK;
}

}  // namespace mozilla::dom
