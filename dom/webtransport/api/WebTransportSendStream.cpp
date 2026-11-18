/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "mozilla/dom/WebTransportSendStream.h"

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

NS_IMPL_CYCLE_COLLECTION_INHERITED(WebTransportSendStream, WritableStream,
                                   mTransport, mSendGroup, mSender,
                                   mAtomicWriteReqPromises)
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

  // Step 6:  Add the following steps to stream’s [[controller]]'s [[signal]].
  // Step 6.1: If stream.[[PendingOperation]] is null, then abort these steps.
  // Step 6.2: Let reason be stream’s [[controller]]'s [[signal]]'s abort
  // reason. Step 6.3: Let abortPromise be the result of aborting stream with
  // reason. Step 6.4: Upon fulfillment of abortPromise, reject promise with
  // reason. Step 6.5: Let pendingOperation be stream.[[PendingOperation]].
  // Step 6.6: Set stream.[[PendingOperation]] to null.
  // Step 6.7: Resolve pendingOperation with promise.
  // XXX TODO

  // Step 7: Append stream to SendStreams
  aWebTransport->mSendStreams.InsertOrUpdate(aStreamId, stream);
  // Step 8: return stream
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

    // Entry complete - increment bytes written, resolve promise and remove
    mBytesWritten += entry.mData.Length();

    // Always resolve the write callback promise (the underlying sink's write
    // algorithm promise) so WritableStream can continue processing queued
    // writes. For atomic writes, the user-facing promise (stored in the
    // transport) is resolved separately via IPC once the parent confirms the
    // flow-control window.
    //
    // This promise can't be left pending until that IPC confirmation instead:
    // WritableStream::StartErroring() only calls FinishErroring() -- which is
    // what invokes our AbortCallbackImpl -- once
    // !HasOperationMarkedInFlight(), i.e. once this promise settles. Leaving
    // it pending would make writer.abort() wait for the parent's flow-control
    // response before it can even run our abort logic, instead of being able
    // to preempt it -- confirmed by webtransport-writer-advanced.https.any.js's
    // abort tests failing when this was tried.
    entry.mPromise->MaybeResolveWithUndefined();

    mPendingWrites.Pop();
  }

  LOG(("DrainQueue complete, queue empty"));
}

// https://w3c.github.io/webtransport/#webtransportsendstream-abort-all-atomic-write-requests
void WebTransportSendStream::AbortAllAtomicWriteRequests() {
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
  bool hasNonAtomic = false;
  mPendingWrites.Iterate([&](const PendingWriteEntry& entry) {
    if (entry.mAtomicWriteId.isNothing()) {
      hasNonAtomic = true;
    }
  });

  if (hasNonAtomic) {
    LOG(("  Non-atomic writes found in queue, erroring stream"));
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
        IgnoredErrorResult ignored;
        ErrorNative(cx, error, ignored);
      }
    }
    return;
  }

  // Step 4: Empty stream.[[AtomicWriteRequests]].
  nsTArray<uint32_t> atomicWriteIds = std::move(mPendingAtomicWriteIds);

  // Step 5: For each promise in requestsToAbort, reject promise with
  //         AbortError.
  // Reject promises for atomic writes sent to parent (tracked via IPC)
  for (uint32_t atomicWriteId : atomicWriteIds) {
    LOG(("  Rejecting sent atomic write id=%u", atomicWriteId));
    RefPtr<Promise> promise = transport->TakeAtomicWritePromise(atomicWriteId);
    if (promise) {
      promise->MaybeRejectWithAbortError(
          "Atomic write failed - insufficient flow control window"_ns);
    }
  }

  // The atomicWrite() user-facing promise for entries still queued locally
  // was already rejected above (their IDs are also in atomicWriteIds).
  // Resolve, rather than reject, their sink write-progress promise
  // (entry.mPromise): WritableStreamDefaultControllerProcessWrite awaits it
  // as [[inFlightWriteRequest]], and rejecting it would run
  // FinishInFlightWriteWithError, which errors the *whole* WritableStream --
  // whereas "abort all atomic write requests" must leave the stream open and
  // only reject the individual atomicWrite() promises.
  mPendingWrites.Iterate([&](PendingWriteEntry& entry) {
    if (entry.mAtomicWriteId) {
      LOG(("  Completing queued atomic write id=%u without erroring stream",
           *entry.mAtomicWriteId));
      if (entry.mPromise) {
        entry.mPromise->MaybeResolveWithUndefined();
      }
    }
  });
  mPendingWrites.Clear();

  // Step 6: In parallel, for each promise in requestsToAbort, abort the
  //         sending of bytes associated with promise.
  // The parent process will handle cancellation of in-flight sends when
  // it sees subsequent writes or stream reset.
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
