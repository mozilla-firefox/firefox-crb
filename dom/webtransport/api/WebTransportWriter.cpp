/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* vim:set ts=2 sw=2 sts=2 et cindent: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "mozilla/dom/WebTransportWriter.h"

#include "mozilla/dom/BufferSourceBinding.h"
#include "mozilla/dom/Promise-inl.h"
#include "mozilla/dom/TypedArray.h"
#include "mozilla/dom/WebTransport.h"
#include "mozilla/dom/WebTransportLog.h"
#include "mozilla/dom/WebTransportSendStream.h"
#include "mozilla/dom/WebTransportWriterBinding.h"
#include "mozilla/dom/WritableStreamDefaultWriter.h"

namespace mozilla::dom {

namespace {
// Not in spec: mirrors WebTransportSendStreamAlgorithms::WriteCallbackImpl's
// own Step 5 ("If bytes' length is 0...") test, so AtomicWrite() can decide
// *before* setting up IPC-based atomic-write tracking whether this write
// will take that short-circuit and resolve synchronously without ever
// reaching the DataPipe or the parent process. A chunk that fails to parse
// as a BufferSource is treated as non-empty; WriteChunk()'s own validation
// is what surfaces the right TypeError for that case.
bool IsEmptyWriteChunk(JSContext* aCx, JS::Handle<JS::Value> aChunk) {
  if (!aChunk.isObject()) {
    return false;
  }
  BufferSource chunk;
  if (!chunk.Init(aCx, aChunk)) {
    JS_ClearPendingException(aCx);
    return false;
  }
  bool isEmpty = true;
  ProcessTypedArraysFixed(
      chunk, [&](const Span<uint8_t>& aData) { isEmpty = aData.IsEmpty(); });
  return isEmpty;
}
}  // namespace

NS_IMPL_CYCLE_COLLECTION_INHERITED(WebTransportWriter,
                                   WritableStreamDefaultWriter, mSendStream)
NS_IMPL_ADDREF_INHERITED(WebTransportWriter, WritableStreamDefaultWriter)
NS_IMPL_RELEASE_INHERITED(WebTransportWriter, WritableStreamDefaultWriter)
NS_INTERFACE_MAP_BEGIN_CYCLE_COLLECTION(WebTransportWriter)
NS_INTERFACE_MAP_END_INHERITING(WritableStreamDefaultWriter)

WebTransportWriter::WebTransportWriter(nsIGlobalObject* aGlobal,
                                       WebTransportSendStream* aStream)
    : WritableStreamDefaultWriter(aGlobal), mSendStream(aStream) {}

JSObject* WebTransportWriter::WrapObject(JSContext* aCx,
                                         JS::Handle<JSObject*> aGivenProto) {
  return WebTransportWriter_Binding::Wrap(aCx, this, aGivenProto);
}

already_AddRefed<Promise> WebTransportWriter::AtomicWrite(
    JSContext* aCx, JS::Handle<JS::Value> aChunk, ErrorResult& aRv) {
  // https://w3c.github.io/webtransport/#dom-webtransportwriter-atomicwrite
  LOG(("WebTransportWriter::AtomicWrite [this=%p]", this));

  // Step 1: Let stream be this.stream ([[stream]] of
  // WritableStreamDefaultWriter).
  // Step 2: If stream is undefined, return a promise rejected with a
  // TypeError -- WriteChunk() below handles this.
  if (!GetStream()) {
    return WriteChunk(aCx, aChunk);
  }

  // Not in spec: an empty chunk resolves synchronously via WriteChunk()'s own
  // Step 5 short-circuit, without ever reaching the DataPipe or the parent
  // process. There is nothing for the parent to confirm over IPC in that
  // case, so userPromise below -- which only resolves via that confirmation
  // -- would hang forever. Skip all atomic-write tracking for it.
  if (IsEmptyWriteChunk(aCx, aChunk)) {
    return WriteChunk(aCx, aChunk);
  }

  // Non-spec: generate a unique ID to correlate this atomic write with its
  // IPC-level flow-control notification.
  static Atomic<uint32_t> sNextAtomicWriteId{1};
  uint32_t atomicWriteId = sNextAtomicWriteId++;

  // Non-spec: create the user-facing promise resolved via IPC once flow
  // control is confirmed. The spec's step 7.3 says "return undefined", but
  // that assumes [[WriteAlgorithm]] resolves only after the network send
  // completes (spec's webtransportsendstream-write step 9.2). Our
  // [[WriteAlgorithm]] resolves as soon as bytes reach the DataPipe (before
  // the network process sends them and before the flow-control window
  // check), so we need a separate IPC notification to determine whether the
  // atomic write actually succeeded.
  //
  // This can't be fixed by making the write algorithm's own promise wait for
  // that IPC confirmation instead of a separate one: doing so leaves this
  // write's underlying sink-algorithm promise pending, but
  // WritableStream::StartErroring() only finishes erroring -- which is what
  // runs our AbortCallbackImpl -- once no operation is marked in-flight,
  // i.e. once that promise settles. So writer.abort() would have to wait for
  // the parent's flow-control response before it could even run our abort
  // logic, instead of being able to preempt it; confirmed by
  // webtransport-writer-advanced.https.any.js's abort tests failing when
  // this was tried.
  RefPtr<Promise> userPromise = Promise::Create(GetParentObject(), aRv);
  if (aRv.Failed()) {
    return nullptr;
  }

  // Step 3: Set stream.[[InsideSynchronousAtomicWrite]] to true.
  mSendStream->SetPendingAtomicWriteId(atomicWriteId);

  // Step 4: Let p be the result of writing chunk to this.
  RefPtr<Promise> writeRequestPromise = WriteChunk(aCx, aChunk);

  // Step 5: Set stream.[[InsideSynchronousAtomicWrite]] to false.
  mSendStream->ClearPendingAtomicWriteId();

  LOG(("Atomic write via pipeline: streamId=%llu, atomicWriteId=%u",
       (unsigned long long)mSendStream->GetStreamId(), atomicWriteId));

  // Step 6: Append p to stream.[[AtomicWriteRequests]].
  mSendStream->TrackAtomicWriteRequest(writeRequestPromise, atomicWriteId);

  // Non-spec: store the user promise for IPC resolution when the atomic
  // write completes, and track the ID for abort handling.
  if (WebTransport* transport = mSendStream->GetTransport()) {
    transport->StoreAtomicWritePromise(atomicWriteId, userPromise);
  }
  mSendStream->TrackAtomicWriteId(atomicWriteId);

  // Step 7: Return the result of reacting to p with the following steps:
  Result<RefPtr<Promise>, nsresult> result =
      writeRequestPromise->ThenCatchWithCycleCollectedArgs(
          // Fulfill handler (p fulfilled):
          [](JSContext*, JS::Handle<JS::Value>, ErrorResult&,
             RefPtr<WebTransportSendStream> aSendStream,
             RefPtr<Promise> aWriteRequestPromise,
             RefPtr<Promise> aUserPromise) -> already_AddRefed<Promise> {
            // Step 7.1: If stream.[[AtomicWriteRequests]] contains p, remove p.
            aSendStream->TakeAtomicWriteId(aWriteRequestPromise.get());
            // Step 7.3: Return undefined.
            // Non-spec: we return userPromise instead of undefined so that
            // the IPC-based flow-control result (resolved elsewhere) is
            // surfaced.
            return do_AddRef(aUserPromise);
          },
          // Reject handler (p rejected with reason r):
          [](JSContext*, JS::Handle<JS::Value> aReason, ErrorResult&,
             RefPtr<WebTransportSendStream> aSendStream,
             RefPtr<Promise> aWriteRequestPromise,
             RefPtr<Promise> aUserPromise) -> already_AddRefed<Promise> {
            // Step 7.1: If stream.[[AtomicWriteRequests]] contains p, remove p.
            if (Maybe<uint32_t> atomicWriteId =
                    aSendStream->TakeAtomicWriteId(aWriteRequestPromise.get());
                atomicWriteId.isSome()) {
              if (WebTransport* transport = aSendStream->GetTransport()) {
                transport->RemoveAtomicWritePromise(*atomicWriteId);
              }
              aSendStream->UntrackAtomicWriteId(*atomicWriteId);
            }
            // Step 7.2: If p was rejected with reason r, then return a promise
            // rejected with r.
            // We return aUserPromise rather than Promise::CreateRejected(...)
            // because the abort handler may have already rejected
            // aUserPromise with a more specific error (AbortError). aReason
            // may be undefined if abort() was called without a reason.
            // MaybeReject is a no-op if aUserPromise is already settled.
            aUserPromise->MaybeReject(aReason);
            return do_AddRef(aUserPromise);
          },
          RefPtr(mSendStream), RefPtr(writeRequestPromise),
          RefPtr(userPromise));

  if (result.isErr()) {
    aRv.Throw(result.unwrapErr());
    return nullptr;
  }

  return result.unwrap().forget();
}

void WebTransportWriter::Commit() {
  if (!mSendStream) {
    return;
  }

  // Step 1: Set stream.[[CommittedOffset]] to the value of
  // stream.[[BytesWritten]].
  mSendStream->SetCommittedOffset(mSendStream->GetBytesWritten());
}

}  // namespace mozilla::dom
