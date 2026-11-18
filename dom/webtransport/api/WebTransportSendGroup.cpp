/* -*- Mode: C++; tab-width: 8; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* vim: set ts=8 sts=2 et sw=2 tw=80: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "WebTransportSendGroup.h"

#include "mozilla/dom/Promise.h"
#include "mozilla/dom/WebTransport.h"
#include "mozilla/dom/WebTransportLog.h"
#include "mozilla/dom/WebTransportSendReceiveStreamBinding.h"
#include "mozilla/dom/WebTransportSendStream.h"

namespace mozilla::dom {

NS_IMPL_CYCLE_COLLECTION_WRAPPERCACHE(WebTransportSendGroup, mGlobal,
                                      mWebTransport)
NS_IMPL_CYCLE_COLLECTING_ADDREF(WebTransportSendGroup)
NS_IMPL_CYCLE_COLLECTING_RELEASE(WebTransportSendGroup)
NS_INTERFACE_MAP_BEGIN_CYCLE_COLLECTION(WebTransportSendGroup)
  NS_WRAPPERCACHE_INTERFACE_MAP_ENTRY
  NS_INTERFACE_MAP_ENTRY(nsISupports)
NS_INTERFACE_MAP_END

WebTransportSendGroup::WebTransportSendGroup(nsIGlobalObject* aGlobal,
                                             WebTransport* aWebTransport)
    : mGlobal(aGlobal), mWebTransport(aWebTransport) {
  LOG(("WebTransportSendGroup %p created", this));
}

WebTransportSendGroup::~WebTransportSendGroup() {
  LOG(("WebTransportSendGroup %p destroyed", this));
}

JSObject* WebTransportSendGroup::WrapObject(JSContext* aCx,
                                            JS::Handle<JSObject*> aGivenProto) {
  return WebTransportSendGroup_Binding::Wrap(aCx, this, aGivenProto);
}

already_AddRefed<Promise> WebTransportSendGroup::GetStats(ErrorResult& aRv) {
  // https://w3c.github.io/webtransport/#dom-webtransportsendgroup-getstats
  // Step 1: Let transport be this.[[Transport]]. (implicit)

  // Step 2: Let p be a new promise.
  RefPtr<Promise> promise = Promise::Create(mGlobal, aRv);
  if (aRv.Failed()) {
    return nullptr;
  }

  // Step 3: Let streams be all WebTransportSendStreams whose [[SendGroup]] is
  // this.
  // Step 4: Run the following steps in parallel:
  // Note: implemented synchronously because bytesWritten is a local counter
  // on the DOM thread; no IPC to the networking process is needed.
  // Step 4.1: Let gatheredStats be the list of aggregated stats from all
  // streams in streams needed to populate the dictionary members of
  // WebTransportSendStreamStats accurately.
  // Streams already accounted for by AddFinalStreamStats() (see
  // WebTransport::Cleanup()) are no longer enumerable via
  // mWebTransport->mSendStreams, so start from their cached contribution.
  uint64_t bytesWritten = mCachedBytesWritten;
  uint64_t bytesSent = mCachedBytesSent;
  uint64_t bytesAcknowledged = mCachedBytesAcknowledged;
  if (mWebTransport) {
    for (const auto& stream : mWebTransport->mSendStreams.Values()) {
      if (stream->GetSendGroup() == this) {
        bytesWritten += stream->GetBytesWritten();
        // These are the last-known values reported by a prior per-stream
        // GetStats() call (see WebTransportSendStream::GetStats()); they
        // will read 0 for a stream whose stats have never been queried.
        bytesSent += stream->GetBytesSent();
        bytesAcknowledged += stream->GetBytesAcknowledged();
      }
    }
  }

  // Step 4.2: Queue a network task with transport to run the following:
  // Step 4.2.1: Let stats be a new WebTransportSendStreamStats object.
  WebTransportSendStreamStats stats;
  // Step 4.2.2: For each member of stats that the user agent wishes to expose,
  // set member to the corresponding entry in gatheredStats.
  stats.mBytesWritten.Construct(bytesWritten);
  stats.mBytesSent.Construct(bytesSent);
  stats.mBytesAcknowledged.Construct(bytesAcknowledged);
  // Step 4.2.3: Resolve p with stats.
  promise->MaybeResolve(stats);
  // Step 5: Return p.
  return promise.forget();
}

}  // namespace mozilla::dom
