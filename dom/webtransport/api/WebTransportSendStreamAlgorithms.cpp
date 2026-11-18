/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* vim:set ts=2 sw=2 sts=2 et cindent: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "mozilla/dom/WebTransportSendStreamAlgorithms.h"

#include <algorithm>

#include "mozilla/dom/BufferSourceBinding.h"
#include "mozilla/dom/Promise-inl.h"
#include "mozilla/dom/Promise.h"
#include "mozilla/dom/TypedArray.h"
#include "mozilla/dom/WebTransport.h"
#include "mozilla/dom/WebTransportChild.h"
#include "mozilla/dom/WebTransportError.h"
#include "mozilla/dom/WebTransportFraming.h"
#include "mozilla/dom/WebTransportLog.h"
#include "mozilla/dom/WebTransportSendStream.h"
#include "mozilla/dom/WritableStream.h"
#include "nsStreamUtils.h"

namespace mozilla::dom {

NS_IMPL_CYCLE_COLLECTION_INHERITED(WebTransportSendStreamAlgorithms,
                                   UnderlyingSinkAlgorithmsWrapper, mGlobal,
                                   mStream)
NS_IMPL_ADDREF_INHERITED(WebTransportSendStreamAlgorithms,
                         UnderlyingSinkAlgorithmsWrapper)
NS_IMPL_RELEASE_INHERITED(WebTransportSendStreamAlgorithms,
                          UnderlyingSinkAlgorithmsWrapper)
NS_INTERFACE_MAP_BEGIN_CYCLE_COLLECTION(WebTransportSendStreamAlgorithms)
NS_INTERFACE_MAP_END_INHERITING(UnderlyingSinkAlgorithmsWrapper)

WebTransportSendStreamAlgorithms::WebTransportSendStreamAlgorithms(
    nsIGlobalObject* aGlobal, WebTransportSendStream* aStream)
    : mGlobal(aGlobal), mStream(aStream) {}

void WebTransportSendStreamAlgorithms::ReleaseObjects() { mStream = nullptr; }

// + https://w3c.github.io/webtransport/#webtransportsendstream-write
already_AddRefed<Promise> WebTransportSendStreamAlgorithms::WriteCallbackImpl(
    JSContext* aCx, JS::Handle<JS::Value> aChunk,
    WritableStreamDefaultController& aController, ErrorResult& aRv) {
  RefPtr<Promise> promise = Promise::CreateInfallible(mGlobal);

  if (!mStream) {
    // ReleaseObjects() ran, so the stream is already closed or errored.
    promise->MaybeRejectWithInvalidStateError("Stream is no longer writable");
    return promise.forget();
  }

  // Step 2: If chunk is not a BufferSource, return a promise rejected with a
  // TypeError.
  //
  // BufferSource (not AllowSharedBufferSource) means a SharedArrayBuffer can
  // never reach ProcessTypedArraysFixed below, so there is no
  // same-buffer-mutated-during-copy hazard here to worry about.
  BufferSource chunk;
  if (!aChunk.isObject() || !chunk.Init(aCx, aChunk)) {
    JS_ClearPendingException(aCx);
    promise->MaybeRejectWithTypeError(
        "Chunk must be ArrayBuffer or ArrayBufferView");
    return promise.forget();
  }

  // Step 4: Let bytes be a copy of the byte sequence which chunk represents.
  nsTArray<uint8_t> bytes;
  ProcessTypedArraysFixed(
      chunk, [&](const Span<uint8_t>& aData) { bytes.AppendElements(aData); });

  // Step 5: If bytes' length is 0, resolve promise with undefined and return
  // promise.
  if (bytes.IsEmpty()) {
    promise->MaybeResolveWithUndefined();
    return promise.forget();
  }

  PendingWriteEntry entry;
  entry.mData = std::move(bytes);
  entry.mPromise = promise;

  // Step 8: Let atomic be true if stream.[[AtomicWriteRequests]] contains
  // inFlightWriteRequest or stream.[[InsideSynchronousAtomicWrite]] is true,
  // otherwise false.
  //
  // [[AtomicWriteRequests]] covers the deferred case, where this write was
  // queued behind an earlier one and is only now being drained.
  // [[InsideSynchronousAtomicWrite]] covers the synchronous case, where this
  // callback runs nested inside AtomicWrite()'s own WriteChunk() call, before
  // TrackAtomicWriteRequest() has registered the write, so the
  // inFlightWriteRequest lookup always misses for it.
  Promise* inFlight = aController.Stream()->GetInFlightWriteRequest();
  Maybe<uint32_t> atomicId =
      inFlight ? mStream->TakeAtomicWriteId(inFlight) : Nothing();
  if (atomicId.isNothing()) {
    // [[InsideSynchronousAtomicWrite]].
    atomicId = mStream->GetPendingAtomicWriteId();
  }

  if (atomicId.isSome() && mStream->TakeCancelledAtomicWriteId(*atomicId)) {
    // Aborted while queued behind a failed atomic write (spec step 6 of
    // "abort all atomic write requests"): consume the chunk without sending
    // it, which keeps the stream open.
    promise->MaybeResolveWithUndefined();
    return promise.forget();
  }

  entry.mAtomicWriteId = atomicId;
  if (atomicId.isSome()) {
    LOG(("Atomic write enqueued: streamId=%llu, atomicWriteId=%u, dataLen=%zu",
         (unsigned long long)mStream->GetStreamId(), atomicId.value(),
         entry.mData.Length()));
  } else {
    LOG(("Regular write enqueued: streamId=%llu, dataLen=%zu",
         (unsigned long long)mStream->GetStreamId(), entry.mData.Length()));
  }

  // Not in spec: the frame payload (data plus the 4-byte atomicWriteId for
  // atomic writes) must fit the parent's limit; otherwise the parent would
  // reject the frame and stall the stream. Reject the write here with a
  // clear error instead.
  size_t framePayloadLen =
      entry.mData.Length() + (entry.mAtomicWriteId ? 4 : 0);
  if (framePayloadLen > WEBTRANSPORT_FRAME_MAX_PAYLOAD) {
    promise->MaybeRejectWithTypeError(
        "Write chunk exceeds the maximum WebTransport frame size");
    return promise.forget();
  }

  InitializePendingWriteEntryHeader(entry);

  mStream->EnqueueWrite(std::move(entry));
  mStream->DrainQueue();

  return promise.forget();
}

template <typename CloseOp>
already_AddRefed<Promise> WebTransportSendStreamAlgorithms::CloseSenderHelper(
    CloseOp aCloseOp, const char* aLogPrefix) {
  RefPtr<Promise> promise = Promise::CreateInfallible(mGlobal);

  if (aLogPrefix) {
    LOG(("WebTransportSendStreamAlgorithms::%s [this=%p]", aLogPrefix, this));
  }

  if (mStream) {
    mozilla::ipc::DataPipeSender* sender = mStream->GetDataPipeSender();
    if (sender) {
      if (aLogPrefix) {
        LOG(("  Calling close operation"));
      }
      nsresult rv = aCloseOp(sender);
      if (aLogPrefix) {
        LOG(("  Close operation returned: 0x%x", static_cast<uint32_t>(rv)));
      }
      if (NS_FAILED(rv)) {
        promise->MaybeReject(rv);
      } else {
        promise->MaybeResolveWithUndefined();
      }
    } else {
      promise->MaybeResolveWithUndefined();
    }
  } else {
    if (aLogPrefix) {
      LOG(("  No mStream"));
    }
    promise->MaybeResolveWithUndefined();
  }

  return promise.forget();
}

already_AddRefed<Promise> WebTransportSendStreamAlgorithms::CloseCallbackImpl(
    JSContext* aCx, ErrorResult& aRv) {
  return CloseSenderHelper(
      [](mozilla::ipc::DataPipeSender* sender) { return sender->Close(); },
      "CloseCallbackImpl");
}

// https://w3c.github.io/webtransport/#webtransportsendstream-abort
// "To abort a WebTransportSendStream stream with reason"
already_AddRefed<Promise> WebTransportSendStreamAlgorithms::AbortCallbackImpl(
    JSContext* aCx, const Optional<JS::Handle<JS::Value>>& aReason,
    ErrorResult& aRv) {
  LOG(("WebTransportSendStreamAlgorithms::AbortCallbackImpl [this=%p]", this));

  // Step 3: Let code be 0.
  uint32_t wtCode = 0;

  // Step 5: If reason is a WebTransportError and reason.[[StreamErrorCode]]
  // is not null, then set code to reason.[[StreamErrorCode]].
  if (aReason.WasPassed() && aReason.Value().isObject()) {
    JS::Rooted<JSObject*> obj(aCx, &aReason.Value().toObject());
    RefPtr<WebTransportError> wtError;
    if (NS_SUCCEEDED(UNWRAP_OBJECT(WebTransportError, &obj, wtError))) {
      Nullable<uint32_t> streamErrorCode = wtError->GetStreamErrorCode();
      if (!streamErrorCode.IsNull()) {
        wtCode = streamErrorCode.Value();
        LOG(("  Extracted stream error code: WT=%u", wtCode));
      }
    }
  }

  // Reject all pending user-facing atomic write promises with the abort reason.
  // These are stored in transport keyed by atomicWriteId and resolved/rejected
  // independently of the WritableStream write request lifecycle.
  if (mStream) {
    WebTransport* transport = mStream->GetTransport();
    nsTArray<uint32_t> atomicIds = mStream->TakeAtomicWriteIds();
    JS::Rooted<JS::Value> reason(aCx, JS::UndefinedValue());
    if (aReason.WasPassed()) {
      reason = aReason.Value();
    }
    for (uint32_t id : atomicIds) {
      RefPtr<Promise> p =
          transport ? transport->TakeAtomicWritePromise(id) : nullptr;
      if (p) {
        p->MaybeReject(reason);
      }
    }
  }

  // Step 9: Run the following steps in parallel:
  // Step 9.1: Abort sending on stream.[[InternalStream]] with code and
  // committedOffset.
  // Not in spec: committedOffset isn't sent, since reliable reset
  // (RESET_STREAM_AT) isn't used yet; the abort is a plain RESET_STREAM.
  //
  // Close the outgoing (framed) pipe with the WebTransport error code encoded
  // as an nsresult; the parent (Http3WebTransportStream) decodes it and issues
  // the RESET_STREAM. Routing the abort through the framed pipe keeps it
  // ordered with the stream's data and avoids racing a separate SendResetStream
  // IPC against the pipe-close teardown -- that race could cancel the stream
  // with H3_REQUEST_CANCELLED before the intended code was applied.
  //
  // The nsresult carrier (NS_ERROR_WEBTRANSPORT_CODE_BASE..
  // NS_ERROR_WEBTRANSPORT_CODE_END) only reserves 256 values, so a code above
  // 255 must be clamped here rather than added unchecked -- otherwise it
  // would overflow into an unrelated nsresult's namespace.
  nsresult abortStatus = static_cast<nsresult>(
      static_cast<uint32_t>(NS_ERROR_WEBTRANSPORT_CODE_BASE) +
      std::min(wtCode, 255u));
  return CloseSenderHelper(
      [abortStatus](mozilla::ipc::DataPipeSender* sender) {
        return sender->CloseWithStatus(abortStatus);
      },
      "AbortCallbackImpl");
}

}  // namespace mozilla::dom
