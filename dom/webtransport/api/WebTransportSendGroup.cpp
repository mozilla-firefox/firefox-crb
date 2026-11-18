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
#include "nsISupportsImpl.h"

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

namespace {
// Refcounted fan-in state shared by every FetchStats() callback below: the
// last one to complete resolves the group's promise.  Holds the streams
// gathered in step 3 and the contribution of streams already folded into the
// group when the gather started.
class StatsGather final {
 public:
  NS_INLINE_DECL_REFCOUNTING(StatsGather)
  StatsGather(nsTArray<RefPtr<WebTransportSendStream>>&& aMembers,
              uint64_t aBytesWritten, uint64_t aBytesSent,
              uint64_t aBytesAcknowledged)
      : mMembers(std::move(aMembers)),
        mBytesWritten(aBytesWritten),
        mBytesSent(aBytesSent),
        mBytesAcknowledged(aBytesAcknowledged),
        mRemaining(mMembers.Length()) {}
  // Returns true exactly once, when the last outstanding fetch completes.
  bool Decrement() { return --mRemaining == 0; }

  const nsTArray<RefPtr<WebTransportSendStream>> mMembers;
  const uint64_t mBytesWritten;
  const uint64_t mBytesSent;
  const uint64_t mBytesAcknowledged;

 private:
  ~StatsGather() = default;
  size_t mRemaining;
};

void ResolveWithTotals(Promise* aPromise, const StatsGather& aGather) {
  // Finishes step 4.1's gather over the streams of step 3, each of which has
  // just refreshed its own stats, then runs step 4.2.
  // bytesWritten is a local counter on the DOM thread, so it needs no IPC.
  uint64_t bytesWritten = aGather.mBytesWritten;
  uint64_t bytesSent = aGather.mBytesSent;
  uint64_t bytesAcknowledged = aGather.mBytesAcknowledged;
  for (const auto& stream : aGather.mMembers) {
    bytesWritten += stream->GetBytesWritten();
    bytesSent += stream->GetBytesSent();
    bytesAcknowledged += stream->GetBytesAcknowledged();
  }

  // Step 4.2: Queue a network task with transport to run the following
  // steps:
  // Step 4.2.1: Let stats be a new WebTransportSendStreamStats object.
  WebTransportSendStreamStats stats;
  // Step 4.2.2: For each member of stats that the user agent wishes to
  // expose, set member to the corresponding entry in gatheredStats.
  stats.mBytesWritten.Construct(bytesWritten);
  stats.mBytesSent.Construct(bytesSent);
  stats.mBytesAcknowledged.Construct(bytesAcknowledged);
  // Step 4.2.3: Resolve p with stats.
  aPromise->MaybeResolve(stats);
}
}  // namespace

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
  // Step 4.1: Let gatheredStats be the list of aggregated stats from all
  // streams in streams needed to populate the dictionary members of
  // WebTransportSendStreamStats accurately.
  // Streams already accounted for by AddFinalStreamStats() (see
  // WebTransport::Cleanup()) are no longer in mWebTransport->mSendStreams, so
  // start from this group's own contribution for them.  Snapshot it now: a
  // Cleanup() while the fetches are in flight would otherwise count a member
  // both here and in the sum over members.
  nsTArray<RefPtr<WebTransportSendStream>> members;
  if (mWebTransport) {
    for (const auto& stream : mWebTransport->mSendStreams.Values()) {
      if (stream->GetSendGroup() == this) {
        members.AppendElement(stream);
      }
    }
  }

  RefPtr<StatsGather> gather =
      new StatsGather(std::move(members), mCachedBytesWritten, mCachedBytesSent,
                      mCachedBytesAcknowledged);
  if (gather->mMembers.IsEmpty()) {
    // Step 4.2 (see ResolveWithTotals()): no member to query, so run it
    // immediately.
    ResolveWithTotals(promise, *gather);
    // Step 5: Return p.
    return promise.forget();
  }

  for (const auto& stream : gather->mMembers) {
    stream->FetchStats([promise, gather]() {
      // Step 4.2 (see ResolveWithTotals()), deferred until every member's
      // fetch above has settled.
      if (gather->Decrement()) {
        ResolveWithTotals(promise, *gather);
      }
    });
  }
  // Step 5: Return p.
  return promise.forget();
}

}  // namespace mozilla::dom
