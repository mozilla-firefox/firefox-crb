/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef mozilla_net_Http3WebTransportStream_h
#define mozilla_net_Http3WebTransportStream_h

#include <functional>

#include "Http3StreamBase.h"
#include "WebTransportStreamBase.h"
#include "mozilla/Maybe.h"
#include "mozilla/Result.h"
#include "mozilla/ResultVariant.h"

class nsIWebTransportSendStreamStats;
class nsIWebTransportReceiveStreamStats;

namespace mozilla::net {

class Http3WebTransportSession;

class Http3WebTransportStream final : public WebTransportStreamBase,
                                      public Http3StreamBase,
                                      public nsAHttpSegmentWriter,
                                      public nsAHttpSegmentReader {
 public:
  NS_DECL_THREADSAFE_ISUPPORTS
  NS_DECL_NSAHTTPSEGMENTWRITER
  NS_DECL_NSAHTTPSEGMENTREADER
  NS_DECL_NSIINPUTSTREAMCALLBACK
  NS_DECL_NSIOUTPUTSTREAMCALLBACK

  explicit Http3WebTransportStream(
      Http3SessionBase* aSession, uint64_t aSessionId,
      WebTransportStreamType aType,
      std::function<void(Result<RefPtr<WebTransportStreamBase>, nsresult>&&)>&&
          aCallback,
      bool aWaitUntilAvailable = false);
  explicit Http3WebTransportStream(Http3SessionBase* aSession,
                                   uint64_t aSessionId,
                                   WebTransportStreamType aType,
                                   uint64_t aStreamId);

  class StreamId WebTransportStreamId() const override;
  uint64_t GetStreamId() const override;

  Http3WebTransportSession* GetHttp3WebTransportSession() override {
    return nullptr;
  }
  Http3WebTransportStream* GetHttp3WebTransportStream() override {
    return this;
  }
  Http3Stream* GetHttp3Stream() override { return nullptr; }
  Http3ConnectUDPStream* GetHttp3ConnectUDPStream() override { return nullptr; }
  Http3StreamTunnel* GetHttp3StreamTunnel() override { return nullptr; }

  void SetSendOrder(int64_t aSendOrder) override;
  void SetSendGroup(uint64_t aSendGroupId) override;

  [[nodiscard]] nsresult ReadSegments() override;
  [[nodiscard]] nsresult WriteSegments() override;

  bool Done() const override;
  void Close(nsresult aResult) override;

  void SetResponseHeaders(nsTArray<uint8_t>& aResponseHeaders, bool fin,
                          bool interim) override {}

  uint64_t SessionId() const { return mSessionId; }

  void SendFin() override;
  void Reset(uint64_t aErrorCode) override;
  void AbortSending(uint32_t aErrorCode) override;
  void Commit() override;
  void SendStopSending(uint64_t aErrorCode) override;

  already_AddRefed<nsIWebTransportSendStreamStats> GetSendStreamStats()
      override;
  already_AddRefed<nsIWebTransportReceiveStreamStats> GetReceiveStreamStats()
      override;

  // When mRecvState is RECV_DONE, this means we already received the FIN.
  bool RecvDone() const override { return mRecvState == RECV_DONE; }

  uint64_t TotalReceived() const { return mTotalReceived; }

  bool SentReset() const { return mResetError.isSome(); }

  // RESET_STREAM or STOP_SENDING from the peer on a bidirectional stream ends
  // only the receive or the send half, respectively; the other half stays
  // usable until it finishes on its own.
  void CloseReceiveSide(nsresult aResult);
  void CloseSendSide(nsresult aResult);

  bool WaitUntilAvailable() const { return mWaitUntilAvailable; }

 private:
  friend class Http3WebTransportSession;
  virtual ~Http3WebTransportStream();

  nsresult TryActivating();
  static nsresult ReadRequestSegment(nsIInputStream*, void*, const char*,
                                     uint32_t, uint32_t, uint32_t*);
  static nsresult WritePipeSegment(nsIOutputStream*, void*, char*, uint32_t,
                                   uint32_t, uint32_t*);

  // Sends aPayload atomically now via WebTransportSendStreamAtomic(), which
  // fails if it does not fit.  Returns whether it succeeded.
  bool TrySendAtomicPayload(nsTArray<uint8_t>&& aPayload);
  // Looks up the owning Http3WebTransportSession and resolves the DOM-side
  // atomicWrite() promise for aAtomicWriteId.
  void ResolveAtomicWrite(uint32_t aAtomicWriteId, bool aSuccess);
  // Looks up the owning Http3WebTransportSession and tells the DOM the FIN
  // for this stream went out, settling its close() promise.
  void NotifyCloseComplete();
  // Retries atomic writes deferred because regular data was still draining
  // ahead of them; called whenever mPendingRegularFrameData empties out.
  void TryDrainPendingAtomicWrites();
  // Fails (rather than retries) any atomic writes still deferred in
  // mPendingAtomicWrites; called from Close()/Reset() since the stream is
  // going away and TryDrainPendingAtomicWrites() will never run again to
  // settle their DOM-side promises otherwise.
  void FailPendingAtomicWrites();

  uint64_t mTotalSent = 0;
  uint64_t mTotalReceived = 0;
  // TODO: neqo doesn't expose this information for now.
  uint64_t mTotalAcknowledged = 0;
  bool mSendFin{false};
  // The error code used to reset the stream. Should be only set once.
  Maybe<uint64_t> mResetError;
  // The error code used for STOP_SENDING. Should be only set once.
  Maybe<uint64_t> mStopSendingError;

  // This is used when SendFin or Reset is called when mSendState is SENDING.
  nsTArray<std::function<void()>> mPendingTasks;

  // Controls behavior when stream quota is exhausted
  bool mWaitUntilAvailable{false};

  // Buffer for accumulating partial frames from DataPipe
  // Frame format: [1 byte type][4 bytes length][N bytes data]
  nsTArray<uint8_t> mPartialFrameBuffer;

  // Buffer for Regular frame data that couldn't be sent due to flow control
  // When OnReadSegment can't send all data, remainder is stored here
  nsTArray<uint8_t> mPendingRegularFrameData;

  struct PendingAtomicWrite {
    uint32_t mAtomicWriteId;
    nsTArray<uint8_t> mPayload;
  };
  // Atomic writes deferred, in order, because regular data written before
  // them was still draining out of mPendingRegularFrameData; retried via
  // TryDrainPendingAtomicWrites() once that buffer empties out.
  nsTArray<PendingAtomicWrite> mPendingAtomicWrites;

  // True when stream close is detected but we have pending data to send first
  bool mDeferredClose{false};
};

}  // namespace mozilla::net

#endif  // mozilla_net_Http3WebTransportStream_h
