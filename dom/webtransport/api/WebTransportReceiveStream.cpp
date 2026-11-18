/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "mozilla/dom/WebTransportReceiveStream.h"

#include "mozilla/dom/Promise.h"
#include "mozilla/dom/ReadableByteStreamController.h"
#include "mozilla/dom/ReadableStream.h"
#include "mozilla/dom/UnderlyingSourceCallbackHelpers.h"
#include "mozilla/dom/WebTransport.h"
#include "mozilla/dom/WebTransportLog.h"
#include "mozilla/dom/WebTransportSendReceiveStreamBinding.h"
#include "mozilla/ipc/DataPipe.h"

using namespace mozilla::ipc;

namespace mozilla::dom {

NS_IMPL_CYCLE_COLLECTION_INHERITED(WebTransportReceiveStream, ReadableStream,
                                   mTransport)
NS_IMPL_ADDREF_INHERITED(WebTransportReceiveStream, ReadableStream)
NS_IMPL_RELEASE_INHERITED(WebTransportReceiveStream, ReadableStream)
NS_INTERFACE_MAP_BEGIN_CYCLE_COLLECTION(WebTransportReceiveStream)
NS_INTERFACE_MAP_END_INHERITING(ReadableStream)

WebTransportReceiveStream::WebTransportReceiveStream(nsIGlobalObject* aGlobal,
                                                     WebTransport* aTransport)
    : ReadableStream(aGlobal,
                     ReadableStream::HoldDropJSObjectsCaller::Explicit),
      mTransport(aTransport) {
  mozilla::HoldJSObjects(this);
}

WebTransportReceiveStream::~WebTransportReceiveStream() {
  mozilla::DropJSObjects(this);
}

// WebIDL Boilerplate

JSObject* WebTransportReceiveStream::WrapObject(
    JSContext* aCx, JS::Handle<JSObject*> aGivenProto) {
  return WebTransportReceiveStream_Binding::Wrap(aCx, this, aGivenProto);
}

already_AddRefed<WebTransportReceiveStream> WebTransportReceiveStream::Create(
    WebTransport* aWebTransport, nsIGlobalObject* aGlobal, uint64_t aStreamId,
    DataPipeReceiver* receiver, ErrorResult& aRv) {
  // https://w3c.github.io/webtransport/#webtransportreceivestream-create
  AutoJSAPI jsapi;
  if (!jsapi.Init(aGlobal)) {
    return nullptr;
  }
  JSContext* cx = jsapi.cx();

  auto stream = MakeRefPtr<WebTransportReceiveStream>(aGlobal, aWebTransport);
  stream->mStreamId = aStreamId;

  nsCOMPtr<nsIAsyncInputStream> inputStream = receiver;
  auto algorithms = MakeRefPtr<InputToReadableStreamAlgorithms>(
      cx, inputStream, (ReadableStream*)stream);

  stream->SetUpByteNative(cx, *algorithms, Some(0.0), aRv);
  if (aRv.Failed()) {
    return nullptr;
  }
  // Add to ReceiveStreams
  aWebTransport->mReceiveStreams.InsertOrUpdate(aStreamId, stream);
  return stream.forget();
}

already_AddRefed<Promise> WebTransportReceiveStream::GetStats(
    ErrorResult& aRv) {
  // https://w3c.github.io/webtransport/#dom-webtransportreceivestream-getstats
  // Step 1: Let p be a new promise.
  RefPtr<Promise> promise = Promise::Create(ReadableStream::mGlobal, aRv);
  if (aRv.Failed()) {
    return nullptr;
  }

  // Both bytesReceived and bytesRead can only increase per spec, and we have
  // no locally-tracked value for either yet, so when we can't gather real
  // stats, leave both members unconstructed (step 2.2.2's "for each member
  // ... the user agent wishes to expose") rather than reporting 0, which
  // would be a monotonicity-violating regression after a prior successful
  // getStats() call reported nonzero values.
  auto resolveUnavailable = [promise] {
    WebTransportReceiveStreamStats stats;
    promise->MaybeResolve(stats);
  };

  WebTransportChild* child = mTransport ? mTransport->SendChild() : nullptr;
  if (!child) {
    // Not in spec: if the transport IPC actor is gone, resolve immediately
    // since there is no transport to query.
    resolveUnavailable();
    return promise.forget();
  }

  // Step 2: Run the following steps in parallel:
  // Step 2.1: Let gatheredStats be the list of stats specific to this
  // WebTransportReceiveStream needed to populate the dictionary members of
  // WebTransportReceiveStreamStats accurately.
  // Implemented by sending an async IPC request to the networking process,
  // which queries neqo for bytesReceived and bytesRead.
  child->SendGetReceiveStreamStats(
      mStreamId,
      [promise, resolveUnavailable](Maybe<ReceiveStreamStats>&& aStats) {
        // Step 2.2: Queue a network task with transport to run the following:
        // Step 2.2.1: Let stats be a new WebTransportReceiveStreamStats object.
        // Step 2.2.2: For each member of stats that the user agent wishes to
        // expose, set member to the corresponding entry in gatheredStats.
        if (aStats) {
          WebTransportReceiveStreamStats stats;
          stats.mBytesReceived.Construct(aStats->bytesReceived());
          uint64_t bytesRead =
              std::min(aStats->bytesRead(), aStats->bytesReceived());
          stats.mBytesRead.Construct(bytesRead);
          // Step 2.2.3: Resolve p with stats.
          promise->MaybeResolve(stats);
        } else {
          resolveUnavailable();
        }
      },
      [resolveUnavailable](mozilla::ipc::ResponseRejectReason) {
        // Not in spec: IPC channel failed; resolve without stats.
        resolveUnavailable();
      });

  // Step 3: Return p.
  return promise.forget();
}

}  // namespace mozilla::dom
