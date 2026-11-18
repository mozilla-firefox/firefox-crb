/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef DOM_WEBTRANSPORT_API_WEBTRANSPORTDATAGRAMDUPLEXSTREAM_H_
#define DOM_WEBTRANSPORT_API_WEBTRANSPORTDATAGRAMDUPLEXSTREAM_H_

#include "mozilla/dom/DatagramCredit.h"
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
  // DatagramQueueCharge() and there is one, standing in for sendDatagrams
  // resolving the promise of a datagram that has left
  // [[OutgoingDatagramsQueue]] (steps 5.1.2.2/5.3.4 of
  // https://w3c.github.io/webtransport/#senddatagrams). Called by
  // WebTransportDatagramDuplexStream::OnDatagramCapacity()'s round-robin
  // drain across every algorithms instance. On success, *aResolvedBytes is
  // that promise's datagram size, for the caller to charge against its byte
  // credit.
  bool TryResolveOldestFromCredit(uint64_t aAvailableBytes,
                                  size_t* aResolvedBytes);

  // Lowers the in-flight count by aCount (never below 0), called from
  // WebTransportDatagramDuplexStream::OnDatagramCapacity() with the
  // sent+expired+dropped delta -- the aggregate signal that this many
  // datagrams have left neqo's queue one way or another, so writeDatagrams
  // step 9 has that many slots free again and that many future write()s can
  // resolve immediately. Independent of TryResolveOldestFromCredit(): this
  // only ever lets *new* writes in, it does not itself resolve anything
  // already deferred.
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

  // FIFO (oldest first) of write() promises writeDatagrams step 9 left
  // unresolved. Sent untracked, so they are resolved either by
  // TryResolveOldestFromCredit() or by Cleanup() -- never individually.
  nsTArray<PendingDatagram> mPendingDatagramPromises;

  // Stands in for the length of this writable's [[OutgoingDatagramsQueue]],
  // which really lives in the parent: datagrams handed to the parent
  // (resolved immediately or deferred alike) that RetireInFlight() hasn't yet
  // been told have left neqo's queue. Step 9 gates against this, not against
  // mPendingDatagramPromises.Length() -- that array counts only deferred
  // promises, which says nothing about how many datagrams are actually queued
  // once they are sent untracked.
  OutgoingDatagramInFlight mInFlight;

  // Set by Cleanup().  WritableStream dequeues one write() at a time, only
  // advancing once the previous one's promise settles, so a burst queued
  // synchronously is still draining across many later microtask turns
  // after Cleanup() itself already ran and returned, and Cleanup() cannot
  // resolve promises for writes that do not exist yet at the moment it
  // runs.  Once set, WriteCallbackImpl resolves every future write
  // immediately without queueing or forwarding it, since nothing will ever
  // grant more credit to release a deferred one again.
  bool mCleanedUp = false;
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

  // https://w3c.github.io/webtransport/#webtransport-cleanup steps 11-13.
  // Returns what [[Writables]] held, for ErrorWritables().
  //
  // Resolving the withheld write promises also lets
  // WritableStreamStartErroring() finish, since it only does once no write
  // is marked in flight.
  [[nodiscard]] nsTArray<RefPtr<WebTransportDatagramsWritable>> Cleanup();

  // https://w3c.github.io/webtransport/#webtransport-cleanup step 17, for
  // aWritables as returned by Cleanup() plus the default writable.
  MOZ_CAN_RUN_SCRIPT void ErrorWritables(
      JSContext* aCx,
      const nsTArray<RefPtr<WebTransportDatagramsWritable>>& aWritables,
      JS::Handle<JS::Value> aErrorValue);

  // https://w3c.github.io/webtransport/#webtransport-cleanup steps 18.5
  // (aClean) and 19.7 (!aClean, with aErrorValue as error).
  MOZ_CAN_RUN_SCRIPT void CloseOrErrorReadable(
      JSContext* aCx, bool aClean, JS::Handle<JS::Value> aErrorValue);

  void NewDatagramReceived(nsTArray<uint8_t>&& aData,
                           const mozilla::TimeStamp& aTimeStamp);

  // Queues a datagram for the next batched OutgoingDatagrams IPC message.
  // Called by every OutgoingDatagramStreamAlgorithms instance (the default
  // writable plus any from createWritable()) instead of sending immediately,
  // so a burst spread across writables still coalesces into one message.
  // Flushes immediately if the pending batch has reached
  // kMaxOutgoingMessageBytes; otherwise posts a flush runnable to the current
  // thread on the first datagram queued, which runs as a later task.  Since
  // this can send right away, an UpdateDatagramQueueParams meant to precede
  // these datagrams must be sent before the first is queued (SetChild()), and
  // one meant to follow datagrams already queued must flush first (the
  // setters).
  void QueueOutgoingDatagram(OutgoingDatagram&& aDatagram);

  // Sends whatever QueueOutgoingDatagram() has accumulated, split into
  // OutgoingDatagrams messages of at most about kMaxOutgoingMessageBytes or
  // kMaxOutgoingMessageDatagrams. Safe to call when there is nothing pending
  // (no-op) or when mChild is not yet set (also a no-op; SetChild() flushes
  // explicitly once it is).
  void FlushOutgoingDatagrams();

  // Handles a DatagramCapacity message, the parent's aggregate stand-in for
  // sendDatagrams (https://w3c.github.io/webtransport/#senddatagrams): raises
  // the credit limits (a decrease is ignored, matching MAX_DATA), adds
  // sentDelta/droppedDelta to their own running totals and expiredDelta to
  // mExpiredOutgoing, frees that many writeDatagrams step 9 slots on every
  // writable, then pays the resolutions steps 5.1.2.2/5.3.4 owe out of the
  // credit -- round-robin across every OutgoingDatagramStreamAlgorithms
  // instance, one deferred promise at a time from each while both credit
  // dimensions allow it, so no single writable can starve another's backlog.
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
  // via CreateWritable(), for the lifetime of the stream: the spec's
  // [[Writables]]. The default writable exposed via our `.writable` attribute
  // -- which the spec has dropped from WebTransportDatagramDuplexStream in
  // favor of createWritable(), and which we keep for now as a deprecated
  // historical entry -- isn't wrapped in a WebTransportDatagramsWritable
  // object, so it isn't in here; it's tracked separately via
  // mOutgoingAlgorithms, and anything walking [[Writables]] has to cover both.
  // Unlike mCreatedWritables, only emptied by Cleanup().
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

  // WebTransportDatagramStats' expiredOutgoing, fed by OnDatagramCapacity()'s
  // expiredDelta, which covers both expiry sites: neqo's own outgoingMaxAge
  // queue, and WebTransportParent's arrival-staleness drop (datagrams already
  // too old when they reach the parent), which neqo cannot see. getStats()
  // reports the parent's copy of the same total, folded together there.
  // https://w3c.github.io/webtransport/#dom-webtransportdatagramstats-expiredoutgoing
  uint64_t mExpiredOutgoing = 0;
  // Fed by OnDatagramCapacity()'s sentDelta/droppedDelta. Not exposed via
  // getStats() -- outgoing datagrams are sent untracked, so these are
  // aggregate counts with no per-datagram outcome behind them, and neither
  // has a field in WebTransportDatagramStats to report them in. Nothing is
  // spec'd for a datagram the local stack refused (the nearest field,
  // lostOutgoing, is for one that was sent and then lost in the network), and
  // a plain sent count isn't a "problem" stat like the rest of the dictionary.
  // Kept for future use (e.g. an adaptive sender wanting the full
  // sent/expired/dropped picture, or telemetry).
  uint64_t mSentOutgoing = 0;
  uint64_t mDroppedOutgoing = 0;

  // Outgoing datagrams accumulated by QueueOutgoingDatagram() for the next
  // OutgoingDatagrams message.
  nsTArray<OutgoingDatagram> mPendingOutgoing;
  size_t mPendingOutgoingBytes = 0;
  // Set while a FlushOutgoingDatagrams() runnable is posted but hasn't run
  // yet, so a burst within one task posts only one.
  bool mOutgoingFlushPending = false;

  // The latest DatagramCapacity grant and how much of it write() promises
  // have used, across every OutgoingDatagramStreamAlgorithms instance.
  OutgoingDatagramCredit mCredit;

 public:
  uint64_t GetDroppedIncoming() const { return mDroppedIncoming; }
  uint64_t GetExpiredIncoming() const { return mExpiredIncoming; }
  uint64_t GetExpiredOutgoing() const { return mExpiredOutgoing; }
  uint64_t GetSentOutgoing() const { return mSentOutgoing; }
  uint64_t GetDroppedOutgoing() const { return mDroppedOutgoing; }
};

}  // namespace mozilla::dom

#endif
