/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef mozilla_net_WebTransportSessionBase_h
#define mozilla_net_WebTransportSessionBase_h

#include <functional>
#include <utility>

#include "mozilla/Mutex.h"
#include "mozilla/TimeStamp.h"
#include "mozilla/dom/PWebTransport.h"
#include "nsISupportsImpl.h"
#include "nsIWebTransport.h"
#include "nsString.h"
#include "nsTArray.h"

class WebTransportSessionEventListener;

namespace mozilla::net {

class WebTransportStreamBase;
class Http3WebTransportSession;

// Wraps a WebTransportStatsData snapshot so it can be passed through the
// scriptable WebTransportSessionEventListener::OnSessionClosed/
// OnStatsAvailable methods; the raw data itself is only accessible to
// native (C++) consumers via the noscript GetRawStats().
class WebTransportSessionStatsWrapper final
    : public nsIWebTransportSessionStats {
 public:
  NS_DECL_THREADSAFE_ISUPPORTS

  explicit WebTransportSessionStatsWrapper(
      const mozilla::dom::WebTransportStatsData& aStats)
      : mStats(aStats) {}

  NS_IMETHOD GetRawStats(mozilla::dom::WebTransportStatsData** aStats) override;

 private:
  ~WebTransportSessionStatsWrapper() = default;

  mozilla::dom::WebTransportStatsData mStats;
};

class WebTransportSessionBase {
 public:
  NS_INLINE_DECL_PURE_VIRTUAL_REFCOUNTING

  WebTransportSessionBase() = default;

  void SetWebTransportSessionEventListener(
      WebTransportSessionEventListener* listener);

  virtual uint64_t GetStreamId() const = 0;
  virtual void CloseSession(uint32_t aStatus, const nsACString& aReason) = 0;
  virtual void GetMaxDatagramSize() = 0;
  virtual bool GetSendStreamStats(uint64_t aStreamId, uint64_t* aBytesWritten,
                                  uint64_t* aBytesSent,
                                  uint64_t* aBytesAcknowledged) = 0;
  virtual bool GetReceiveStreamStats(uint64_t aStreamId,
                                     uint64_t* aBytesReceived,
                                     uint64_t* aBytesRead) = 0;
  virtual void GetResponseHeaders(nsTArray<nsCString>& aNames,
                                  nsTArray<nsCString>& aValues) {}
  virtual nsresult ExportKeyingMaterial(const nsTArray<uint8_t>& aLabel,
                                        const nsTArray<uint8_t>& aContext,
                                        uint32_t aOutputLength,
                                        nsTArray<uint8_t>& aKeyingMaterial) = 0;
  virtual void GetNegotiatedProtocol(nsACString& aProtocol) = 0;
  virtual void GetStats() = 0;
  virtual void SetAnticipatedConcurrentIncomingUnidirectionalStreams(
      uint16_t aValue) = 0;
  virtual void SetAnticipatedConcurrentIncomingBidirectionalStreams(
      uint16_t aValue) = 0;
  // aTimestamp is when the datagram was written, for outgoingMaxAge.
  virtual void SendDatagram(nsTArray<uint8_t>&& aData, uint64_t aSendGroupId,
                            int64_t aSendOrder, TimeStamp aTimestamp) = 0;
  virtual void SetDatagramMaxBufferedDatagrams(
      uint32_t aMaxBufferedDatagrams) = 0;
  virtual void SetDatagramMaxAge(double aMaxAge) = 0;
  virtual nsresult RegisterSendGroup(uint64_t aGroupId) = 0;
  virtual void CreateOutgoingBidirectionalStream(
      std::function<void(Result<RefPtr<WebTransportStreamBase>, nsresult>&&)>&&
          aCallback,
      bool aWaitUntilAvailable = false) = 0;
  virtual void CreateOutgoingUnidirectionalStream(
      std::function<void(Result<RefPtr<WebTransportStreamBase>, nsresult>&&)>&&
          aCallback,
      bool aWaitUntilAvailable = false) = 0;
  virtual void StartReading() {}

  // Tells the listener that no further datagram will arrive until we return to
  // the event loop. Call it once after each run of OnDatagramReceived() calls,
  // so that a listener batching them for IPC knows the batch is complete.
  void FlushIncomingDatagrams();

  // Tell the listener the outgoing datagram queue has room again.
  void NotifyOutgoingDatagramSpaceAvailable();

  // Ask for one NotifyOutgoingDatagramSpaceAvailable() after the next output
  // pass.  neqo only signals space after rejecting a datagram, which a sender
  // that stays within the credit it was granted never causes.  Socket thread.
  void RequestOutgoingDatagramProgress() {
    mOutgoingDatagramProgressRequested = true;
  }
  bool TakeOutgoingDatagramProgressRequest() {
    return std::exchange(mOutgoingDatagramProgressRequested, false);
  }

  // A snapshot of the outgoing datagram queue, and its cumulative
  // sent/expired/dropped counts, for WebTransportParent's DatagramCapacity
  // feedback.  False if the session cannot report them.
  virtual bool GetDatagramQueueCapacity(size_t* aRemainingBytes,
                                        size_t* aQueuedDatagrams,
                                        size_t* aMaxQueuedBytes) {
    return false;
  }
  virtual bool GetDatagramSessionStats(uint64_t* aSent, uint64_t* aExpired,
                                       uint64_t* aDropped) {
    return false;
  }

  virtual Http3WebTransportSession* GetHttp3WebTransportSession() {
    return nullptr;
  }

  // Called when a stream has processed a 0x01 atomic write frame.  Tells the
  // listener, which sends AtomicWriteResult to the child to resolve or reject
  // the atomicWrite() promise.
  void ResolveAtomicWrite(uint64_t aStreamId, uint32_t aAtomicWriteId,
                          nsresult aResult);

  // Tell the DOM that a send stream's FIN went out, so it can settle the
  // close promise held as [[PendingOperation]].
  void NotifyStreamCloseComplete(uint64_t aStreamId);

 protected:
  virtual ~WebTransportSessionBase() = default;

  already_AddRefed<WebTransportSessionEventListener> GetListener();
  already_AddRefed<WebTransportSessionEventListener> TakeListener();

  Mutex mListenerLock{"WebTransportSessionBase::mListenerLock"};
  RefPtr<WebTransportSessionEventListener> mListener
      MOZ_GUARDED_BY(mListenerLock);
  bool mOutgoingDatagramProgressRequested = false;
};

}  // namespace mozilla::net

#endif  // mozilla_net_WebTransportSessionBase_h
