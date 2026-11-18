/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef DOM_WEBTRANSPORT_API_WEBTRANSPORTDATAGRAMDUPLEXSTREAM_H_
#define DOM_WEBTRANSPORT_API_WEBTRANSPORTDATAGRAMDUPLEXSTREAM_H_

#include "mozilla/dom/DatagramQueueCharge.h"
#include "mozilla/dom/Promise.h"
#include "mozilla/dom/ReadableStream.h"
#include "mozilla/dom/TypedArray.h"
#include "mozilla/dom/WebTransport.h"
#include "mozilla/dom/WebTransportDatagramDuplexStreamBinding.h"
#include "mozilla/dom/WebTransportDatagramsWritable.h"
#include "mozilla/dom/WritableStream.h"
#include "nsCOMPtr.h"
#include "nsISupports.h"
#include "nsWrapperCache.h"

namespace mozilla::dom {

struct WebTransportSendOptions;

class IncomingDatagramStreamAlgorithms
    : public UnderlyingSourceAlgorithmsWrapper {
 public:
  explicit IncomingDatagramStreamAlgorithms(
      WebTransportDatagramDuplexStream* aDatagrams);

  NS_DECL_ISUPPORTS_INHERITED
  NS_DECL_CYCLE_COLLECTION_CLASS_INHERITED(IncomingDatagramStreamAlgorithms,
                                           UnderlyingSourceAlgorithmsWrapper)

  MOZ_CAN_RUN_SCRIPT already_AddRefed<Promise> PullCallbackImpl(
      JSContext* aCx, ReadableStreamControllerBase& aController,
      ErrorResult& aRv) override;

  MOZ_CAN_RUN_SCRIPT void ReturnDatagram(JSContext* aCx, ErrorResult& aRv);

  void NotifyDatagramAvailable();

 protected:
  ~IncomingDatagramStreamAlgorithms() override;

 private:
  RefPtr<WebTransportDatagramDuplexStream> mDatagrams;
  RefPtr<Promise> mIncomingDatagramsPullPromise;
};

class EarlyDatagram final {
 public:
  EarlyDatagram(DatagramEntry* aDatagram, Promise* aPromise)
      : mDatagram(aDatagram), mWaitConnectPromise(aPromise) {}

  UniquePtr<DatagramEntry> mDatagram;
  RefPtr<Promise> mWaitConnectPromise;

  ~EarlyDatagram() = default;
};

class OutgoingDatagramStreamAlgorithms final
    : public UnderlyingSinkAlgorithmsWrapper {
  NS_DECL_ISUPPORTS_INHERITED
  NS_DECL_CYCLE_COLLECTION_CLASS_INHERITED(OutgoingDatagramStreamAlgorithms,
                                           UnderlyingSinkAlgorithmsWrapper)

  explicit OutgoingDatagramStreamAlgorithms(
      WebTransportDatagramDuplexStream* aDatagrams,
      WebTransportSendGroup* aSendGroup = nullptr, int64_t aSendOrder = 0)
      : mDatagrams(aDatagrams),
        mSendGroup(aSendGroup),
        mSendOrder(aSendOrder) {}

  void SetChild(WebTransportChild* aChild);
  WebTransportChild* GetChild() const { return mChild; }

  void SetSendGroup(WebTransportSendGroup* aSendGroup) {
    mSendGroup = aSendGroup;
  }
  void SetSendOrder(int64_t aSendOrder) { mSendOrder = aSendOrder; }

  void SetOwnerWritable(WebTransportDatagramsWritable* aWritable) {
    mOwnerWritable = aWritable;
  }

  // Streams algorithms

  already_AddRefed<Promise> WriteCallbackImpl(
      JSContext* aCx, JS::Handle<JS::Value> aChunk,
      WritableStreamDefaultController& aController,
      ErrorResult& aError) override;

  // Resolves the oldest deferred promise, if aAvailableBytes covers its
  // DatagramQueueCharge() and there is one, as part of
  // WebTransportDatagramDuplexStream::OnDatagramCapacity()'s round-robin drain
  // across every algorithms instance. On success, *aResolvedBytes is that
  // promise's datagram size, for the caller to charge against its byte credit.
  bool TryResolveOldestFromCredit(uint64_t aAvailableBytes,
                                  size_t* aResolvedBytes);

  // Lowers the in-flight count by aCount (never below 0), called from
  // WebTransportDatagramDuplexStream::OnDatagramCapacity() with the
  // sent+expired+dropped delta -- the aggregate signal that this many
  // datagrams have left neqo's queue one way or another, freeing that many
  // local pipeline slots for future write()s to resolve immediately again.
  // Independent of TryResolveOldestFromCredit(): this only ever lets *new*
  // writes in, it does not itself resolve anything already deferred.
  void RetireInFlight(uint64_t aCount);

  // Send queue parameter updates to parent
  void UpdateQueueParams(uint32_t aMaxBufferedDatagrams, double aMaxAge);

  // Resolves this writable's withheld write promise, if any, so the
  // WritableStream is not left waiting on it once the session is torn down.
  // See WebTransportDatagramDuplexStream::Cleanup().
  void Cleanup();

 private:
  ~OutgoingDatagramStreamAlgorithms() override = default;

  struct QueuedDatagram {
    UniquePtr<DatagramEntry> mEntry;
    RefPtr<Promise> mPromise;

    QueuedDatagram(UniquePtr<DatagramEntry>&& aEntry, RefPtr<Promise> aPromise)
        : mEntry(std::move(aEntry)), mPromise(std::move(aPromise)) {}
  };

  struct PendingDatagram {
    RefPtr<Promise> mPromise;
    size_t mBytes;
  };

  // So nsTArray<QueuedDatagram>/nsTArray<PendingDatagram>'s generic
  // cycle-collection support (see nsTArray.h) can reach mPromise via the
  // overloads below, which need to name these otherwise-private types.
  friend void ImplCycleCollectionTraverse(nsCycleCollectionTraversalCallback&,
                                          QueuedDatagram&, const char*,
                                          uint32_t);
  friend void ImplCycleCollectionUnlink(QueuedDatagram&);
  friend void ImplCycleCollectionTraverse(nsCycleCollectionTraversalCallback&,
                                          PendingDatagram&, const char*,
                                          uint32_t);
  friend void ImplCycleCollectionUnlink(PendingDatagram&);

  RefPtr<WebTransportDatagramDuplexStream> mDatagrams;
  RefPtr<WebTransportChild> mChild;
  RefPtr<WebTransportDatagramsWritable> mOwnerWritable;
  // Queue for datagrams sent before connection is ready
  nsTArray<QueuedDatagram> mWaitConnectQueue;

  // Send group and order for this writable stream (null/0 for default)
  RefPtr<WebTransportSendGroup> mSendGroup;
  int64_t mSendOrder;

  // FIFO (oldest first) of write() promises deferred past
  // outgoingMaxBufferedDatagrams, sent untracked and so resolved either by
  // TryResolveOldestFromCredit() or by Cleanup() -- never individually.
  nsTArray<PendingDatagram> mPendingDatagramPromises;

  // Datagrams handed to the parent (resolved immediately or deferred alike)
  // that RetireInFlight() hasn't yet been told have left neqo's queue.
  // outgoingMaxBufferedDatagrams gates against this, not against
  // mPendingDatagramPromises.Length() -- that array counts only deferred
  // promises, which says nothing about how many are actually in flight once
  // datagrams are sent untracked.
  size_t mInFlightCount = 0;
};

class WebTransportDatagramDuplexStream final : public nsISupports,
                                               public nsWrapperCache {
  friend class IncomingDatagramStreamAlgorithms;
  friend class OutgoingDatagramStreamAlgorithms;
  friend class WebTransportDatagramsWritable;

 public:
  WebTransportDatagramDuplexStream(nsIGlobalObject* aGlobal,
                                   WebTransport* aWebTransport);

  void Init(bool aUseByteStream, ErrorResult& aError);

  NS_DECL_CYCLE_COLLECTING_ISUPPORTS_FINAL
  NS_DECL_CYCLE_COLLECTION_WRAPPERCACHE_CLASS(WebTransportDatagramDuplexStream)

  void SetChild(WebTransportChild* aChild);

  // https://w3c.github.io/webtransport/#webtransport-cleanup step 11: empty
  // every outgoing datagram writable's [[OutgoingDatagramsQueue]].
  //
  // The queued chunk's promise is also our WritableStream sink's write
  // promise, which the spec leaves unsettled here; dropping it would wedge
  // WritableStreamStartErroring(), which only finishes erroring -- and so
  // only reaches CloseOrErrorWritables() below -- once no write is marked in
  // flight. Resolving with undefined matches how sendDatagrams settles a
  // datagram dropped without being sent (step 5.1.2.2).
  void Cleanup();

  // https://w3c.github.io/webtransport/#webtransport-cleanup steps 16.5/17.7:
  // close (aClean) or error (!aClean, with aErrorValue) every outgoing
  // datagram writable -- the default one plus every one from
  // createWritable(). Must run after Cleanup().
  MOZ_CAN_RUN_SCRIPT void CloseOrErrorWritables(
      JSContext* aCx, bool aClean, JS::Handle<JS::Value> aErrorValue);

  void NewDatagramReceived(nsTArray<uint8_t>&& aData,
                           const mozilla::TimeStamp& aTimeStamp);

  // Sends a datagram to the parent in an OutgoingDatagrams IPC message.
  // Called by every OutgoingDatagramStreamAlgorithms instance (the default
  // writable plus any from createWritable()) once mChild is set.
  void QueueOutgoingDatagram(OutgoingDatagram&& aDatagram);

  // Sends whatever has accumulated in mPendingOutgoing, split into
  // OutgoingDatagrams messages of at most about kMaxOutgoingMessageBytes or
  // kMaxOutgoingMessageDatagrams; a no-op if nothing has.
  void FlushOutgoingDatagrams();

  // Handles a DatagramCapacity message: raises the credit limits (a
  // decrease is ignored, matching MAX_DATA), adds sentDelta/droppedDelta to
  // their own running totals and expiredDelta to mExpiredOutgoing, then
  // round-robins across every OutgoingDatagramStreamAlgorithms instance
  // resolving one deferred promise at a time from each while both credit
  // dimensions allow it, so no single writable can starve another's
  // backlog.
  void OnDatagramCapacity(uint64_t aCumulativeDatagrams,
                          uint64_t aCumulativeBytes, uint64_t aSentDelta,
                          uint64_t aExpiredDelta, uint64_t aDroppedDelta,
                          uint64_t aDatagramPrefixBytes);

  // WebIDL Boilerplate
  nsIGlobalObject* GetParentObject() const;

  JSObject* WrapObject(JSContext* aCx,
                       JS::Handle<JSObject*> aGivenProto) override;

  // WebIDL Interface
  already_AddRefed<ReadableStream> Readable() const {
    RefPtr<ReadableStream> result(mReadable);
    return result.forget();
  }
  already_AddRefed<WritableStream> Writable() {
    RefPtr<WritableStream> result(mWritable);
    return result.forget();
  }

  uint64_t MaxDatagramSize() const { return mOutgoingMaxDataSize; }
  void SetMaxDatagramSize(const uint64_t& aMaxDatagramSize) {
    mOutgoingMaxDataSize = aMaxDatagramSize;
  }
  Nullable<double> GetIncomingMaxAge(ErrorResult& aRv) const {
    return mIncomingMaxAge;
  }
  void SetIncomingMaxAge(const Nullable<double>& aMaxAge, ErrorResult& aRv);
  Nullable<double> GetOutgoingMaxAge(ErrorResult& aRv) const {
    return mOutgoingMaxAge;
  }
  void SetOutgoingMaxAge(const Nullable<double>& aMaxAge, ErrorResult& aRv);
  uint32_t IncomingMaxBufferedDatagrams() const {
    return mIncomingMaxBufferedDatagrams;
  }
  void SetIncomingMaxBufferedDatagrams(uint32_t aValue);
  uint32_t OutgoingMaxBufferedDatagrams() const {
    return mOutgoingMaxBufferedDatagrams;
  }
  void SetOutgoingMaxBufferedDatagrams(uint32_t aValue);

  already_AddRefed<WebTransportDatagramsWritable> CreateWritable(
      const WebTransportSendOptions& aOptions, ErrorResult& aRv);

 private:
  ~WebTransportDatagramDuplexStream() = default;

  MOZ_CAN_RUN_SCRIPT static void CloseOrErrorWritable(
      JSContext* aCx, WritableStream* aWritable, bool aClean,
      JS::Handle<JS::Value> aErrorValue);

  nsCOMPtr<nsIGlobalObject> mGlobal;
  RefPtr<WebTransport> mWebTransport;
  RefPtr<ReadableStream> mReadable;
  RefPtr<WritableStream> mWritable;
  RefPtr<IncomingDatagramStreamAlgorithms> mIncomingAlgorithms;
  RefPtr<OutgoingDatagramStreamAlgorithms> mOutgoingAlgorithms;
  // WebTransportDatagramsWritable objects from CreateWritable() calls made
  // before the session connected, waiting for SetChild() to flush their
  // queued datagrams.
  nsTArray<RefPtr<WebTransportDatagramsWritable>> mCreatedWritables;
  // Every WebTransportDatagramsWritable this duplex stream has ever created
  // via CreateWritable(), for the lifetime of the stream. The default
  // writable exposed via `.writable` isn't wrapped in a
  // WebTransportDatagramsWritable object, so it's tracked separately via
  // mOutgoingAlgorithms instead. Unlike mCreatedWritables, never cleared, so
  // Cleanup() can always reach all of them.
  nsTArray<RefPtr<WebTransportDatagramsWritable>> mAllWritables;

  // https://w3c.github.io/webtransport/#webtransportdatagramduplexstream-create
  // null means no maximum age (infinite)
  Nullable<double> mIncomingMaxAge;
  Nullable<double> mOutgoingMaxAge;
  // Both are implementation-defined; for the outgoing one the spec asks only
  // that it be "tuned to ensure decent throughput, without jeopardizing the
  // timeliness of transmitted data".
  //
  // outgoingMaxBufferedDatagrams is the length of the sink's send queue.
  // writeDatagrams withholds write()'s promise once the queue reaches it, so
  // the WritableStream holds back further writes, awaited or not, until
  // datagrams leave the queue. (The incoming side is deliberately different:
  // receiveDatagrams drops whatever exceeds incomingMaxBufferedDatagrams.)
  //
  // 5 rather than Chromium's and WebKit's 1 is deliberate: our outgoing queue
  // lives in the parent process, so a slot frees up only once a
  // DatagramCapacity grant comes back over IPC. The count is therefore
  // pipeline depth measured in IPC round trips, not in local queue slots, and
  // 1 would serialize a sender on them.
  uint32_t mIncomingMaxBufferedDatagrams = 5;
  uint32_t mOutgoingMaxBufferedDatagrams = 5;
  uint64_t mOutgoingMaxDataSize = 1024;  // implementation-defined integer

  mozilla::Queue<UniquePtr<DatagramEntry>, 32> mIncomingDatagramsQueue;
  uint64_t mDroppedIncoming = 0;
  uint64_t mExpiredIncoming = 0;

  // Fed by OnDatagramCapacity()'s expiredDelta, which covers both expiry
  // sites: neqo's own outgoingMaxAge queue, and WebTransportParent's
  // arrival-staleness drop (datagrams already too old when they reach the
  // parent), which neqo cannot see.
  uint64_t mExpiredOutgoing = 0;
  // Fed by OnDatagramCapacity()'s sentDelta/droppedDelta. Not exposed via
  // getStats() -- outgoing datagrams are sent untracked, so these are
  // aggregate counts with no per-datagram outcome behind them, and neither
  // has a defined field in WebTransportDatagramStats (droppedOutgoing isn't
  // spec'd at all; sent isn't a "problem" stat like the others). Kept for
  // future use (e.g. an adaptive sender wanting the full sent/expired/
  // dropped picture, or telemetry).
  uint64_t mSentOutgoing = 0;
  uint64_t mDroppedOutgoing = 0;

  // Outgoing datagrams accumulated by QueueOutgoingDatagram() or SetChild()
  // for the next OutgoingDatagrams message.
  nsTArray<OutgoingDatagram> mPendingOutgoing;

  // Mirrors neqo-transport's SenderFlowControl (limit/used/available),
  // separately for each credit dimension. mCredit*Limit is the latest
  // DatagramCapacity grant; mCredit*Used is how much of it has been spent
  // resolving write() promises, immediately or from every
  // OutgoingDatagramStreamAlgorithms instance's own mPendingDatagramPromises.
  uint64_t mCreditDatagramsLimit = 0;
  uint64_t mCreditDatagramsUsed = 0;
  uint64_t mCreditBytesLimit = 0;
  uint64_t mCreditBytesUsed = 0;
  // From DatagramCapacity; 0 until the first grant.
  uint64_t mDatagramPrefixBytes = 0;

  // Charged when a write() promise resolves, immediately or not, which can be
  // before the parent has been told about the datagram.  Bytes are charged the
  // way neqo's queue charges them, payload plus a fixed overhead.
  void ChargeCredit(uint64_t aPayloadBytes) {
    mCreditDatagramsUsed++;
    mCreditBytesUsed +=
        DatagramQueueCharge(aPayloadBytes, mDatagramPrefixBytes);
  }
  uint64_t CreditBytesAvailable() const {
    return mCreditBytesLimit > mCreditBytesUsed
               ? mCreditBytesLimit - mCreditBytesUsed
               : 0;
  }
  bool HasCreditBytesFor(uint64_t aPayloadBytes) const {
    return DatagramQueueCharge(aPayloadBytes, mDatagramPrefixBytes) <=
           CreditBytesAvailable();
  }

 public:
  uint64_t GetDroppedIncoming() const { return mDroppedIncoming; }
  uint64_t GetExpiredIncoming() const { return mExpiredIncoming; }
  uint64_t GetExpiredOutgoing() const { return mExpiredOutgoing; }
  uint64_t GetSentOutgoing() const { return mSentOutgoing; }
  uint64_t GetDroppedOutgoing() const { return mDroppedOutgoing; }
};

}  // namespace mozilla::dom

#endif
