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
                                   mTransport, mAlgorithms)
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
  auto algorithms =
      MakeRefPtr<InputToReadableStreamAlgorithms>(cx, inputStream, stream);

  stream->SetUpByteNative(cx, *algorithms, Some(0.0), aRv);
  if (aRv.Failed()) {
    return nullptr;
  }
  stream->mAlgorithms = algorithms;
  // Add to ReceiveStreams
  aWebTransport->mReceiveStreams.InsertOrUpdate(aStreamId, stream);
  return stream.forget();
}

already_AddRefed<Promise> WebTransportReceiveStream::GetStats(
    ErrorResult& aRv) {
  // https://w3c.github.io/webtransport/#dom-webtransportreceivestream-getstats
  // Step 1: Let transport be this.[[Transport]]. (implicit)

  // Step 2: Let p be a new promise.
  RefPtr<Promise> promise = Promise::Create(ReadableStream::mGlobal, aRv);
  if (aRv.Failed()) {
    return nullptr;
  }

  // bytesRead is tracked locally (see InputToReadableStreamAlgorithms::
  // BytesPulled()) and is always accurate and monotonic on its own,
  // independent of whether the networking process can still report
  // bytesReceived -- so it's always safe to report, even
  // when we can't gather real stats otherwise. bytesReceived has no local
  // equivalent, and per spec can only increase, so report the last value the
  // networking process gave us (never less than bytesRead), or leave it
  // unconstructed (step 2.2.2's "for each member ... the user agent wishes to
  // expose") if it never reported one, rather than reporting 0, which would
  // be a monotonicity-violating regression.
  const uint64_t bytesRead = mAlgorithms->BytesPulled();
  auto resolveUnavailable = [promise, bytesRead,
                             cachedBytesReceived = mCachedBytesReceived] {
    WebTransportReceiveStreamStats stats;
    if (cachedBytesReceived) {
      stats.mBytesReceived.Construct(std::max(*cachedBytesReceived, bytesRead));
    }
    stats.mBytesRead.Construct(bytesRead);
    promise->MaybeResolve(stats);
  };

  WebTransportChild* child = mTransport ? mTransport->SendChild() : nullptr;
  if (!child) {
    // Not in spec: if the transport IPC actor is gone, resolve immediately
    // since there is no transport to query.
    resolveUnavailable();
    return promise.forget();
  }

  // Step 3: Run the following steps in parallel:
  // Step 3.1: Let gatheredStats be the list of stats specific to this
  // WebTransportReceiveStream needed to populate the dictionary members of
  // WebTransportReceiveStreamStats accurately.
  // bytesReceived comes from neqo via an async IPC request to the networking
  // process; bytesRead is only known here, see BytesPulled().
  child->SendGetReceiveStreamStats(
      mStreamId,
      [self = RefPtr{this}, promise, resolveUnavailable,
       bytesRead](Maybe<ReceiveStreamStats>&& aStats) {
        // Step 3.2: Queue a network task with transport to run the following
        // steps:
        // Step 3.2.1: Let stats be a new WebTransportReceiveStreamStats object.
        // Step 3.2.2: For each member of stats that the user agent wishes to
        // expose, set member to the corresponding entry in gatheredStats.
        if (aStats) {
          self->mCachedBytesReceived = Some(aStats->bytesReceived());
          WebTransportReceiveStreamStats stats;
          stats.mBytesReceived.Construct(aStats->bytesReceived());
          // The spec requires bytesRead <= bytesReceived, and the networking
          // process' count can lag what it already forwarded to us.
          stats.mBytesRead.Construct(
              std::min(bytesRead, aStats->bytesReceived()));
          // Step 3.2.3: Resolve p with stats.
          promise->MaybeResolve(stats);
        } else {
          resolveUnavailable();
        }
      },
      [resolveUnavailable](mozilla::ipc::ResponseRejectReason) {
        // Not in spec: IPC channel failed; resolve without stats.
        resolveUnavailable();
      });

  // Step 4: Return p.
  return promise.forget();
}

}  // namespace mozilla::dom
