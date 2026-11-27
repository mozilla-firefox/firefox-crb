/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef InnerConnectionEstablisher_h_
#define InnerConnectionEstablisher_h_

#include <functional>

#include "ConnectionHandle.h"
#include "TunnelSetupTransaction.h"
#include "mozilla/Result.h"
#include "nsHttpConnectionInfo.h"

namespace mozilla {
namespace net {

class HttpConnectionBase;

// Establishes one inner connection through a CONNECT tunnel: the analogue of
// ConnectionEstablisher, with a tunnel stream instead of a socket.
//
// Succeeds only once the connection is usable -- CONNECT 200 plus the inner TLS
// handshake for an https origin. A non-200 fails, keeping the response for
// InnerConnectionAttempt to hand to the real transaction.
class InnerConnectionEstablisher {
 public:
  NS_INLINE_DECL_REFCOUNTING(InnerConnectionEstablisher)

  using DoneCallback =
      std::function<void(Result<RefPtr<HttpConnectionBase>, nsresult>)>;

  InnerConnectionEstablisher(
      HttpConnectionBase* aOuterConn, nsHttpConnectionInfo* aInnerConnInfo,
      uint32_t aCaps, TunnelSetupTransaction::RequestHeaderSnapshot&& aHeaders,
      nsIInterfaceRequestor* aCallbacks);

  // Virtual for the gtest fake; there is one production implementation. Every
  // outcome, a failure to start included, is reported through aCallback.
  virtual void Start(DoneCallback&& aCallback);
  virtual void Close(nsresult aReason);

  // The caller published the connection: it is no longer ours to close.
  void HandedOver() { mHandedOver = true; }

  virtual HttpConnectionBase* ResultConn() const { return mResultConn; }
  virtual TunnelSetupTransaction* Transaction() const { return mTransaction; }

 protected:
  virtual ~InnerConnectionEstablisher();

 private:
  // aSynchronous calls back in this stack instead of unwinding first, so the
  // real transaction takes the tunnel over before the read loop delivers
  // anything else on it.
  void Finish(nsresult aResult, bool aSynchronous = false);
  void OnProxyConnectStatus(uint16_t aStatus);
  void OnInnerConnected(nsresult aStatus);
  // An h3 inner connection reports its own handshake rather than closing the
  // driver; see HttpConnectionUDP::SetHandshakeDoneCallback.
  void OnInnerHandshakeDone();

  RefPtr<HttpConnectionBase> mOuterConn;
  RefPtr<nsHttpConnectionInfo> mConnInfo;
  uint32_t mCaps = 0;
  nsCOMPtr<nsIInterfaceRequestor> mCallbacks;

  DoneCallback mCallback;
  RefPtr<TunnelSetupTransaction> mTransaction;
  RefPtr<ConnectionHandle> mHandle;
  RefPtr<HttpConnectionBase> mResultConn;

  bool mFinished = false;
  // Close() was called: a result Finish() already queued is dropped.
  bool mClosed = false;
  bool mHandedOver = false;
  // CONNECT returned 200; the inner handshake may still be outstanding.
  bool mTunnelOpen = false;
  // The h3 handshake finished, which can happen before the CONNECT response
  // is parsed.
  bool mInnerHandshakeDone = false;
};

class InnerConnectionEstablisherFactory {
 public:
  NS_INLINE_DECL_THREADSAFE_REFCOUNTING(InnerConnectionEstablisherFactory)

  virtual already_AddRefed<InnerConnectionEstablisher> Create(
      HttpConnectionBase* aOuterConn, nsHttpConnectionInfo* aInnerConnInfo,
      uint32_t aCaps, TunnelSetupTransaction::RequestHeaderSnapshot&& aHeaders,
      nsIInterfaceRequestor* aCallbacks) = 0;

 protected:
  virtual ~InnerConnectionEstablisherFactory() = default;
};

class DefaultInnerConnectionEstablisherFactory final
    : public InnerConnectionEstablisherFactory {
 public:
  already_AddRefed<InnerConnectionEstablisher> Create(
      HttpConnectionBase* aOuterConn, nsHttpConnectionInfo* aInnerConnInfo,
      uint32_t aCaps, TunnelSetupTransaction::RequestHeaderSnapshot&& aHeaders,
      nsIInterfaceRequestor* aCallbacks) override {
    return MakeAndAddRef<InnerConnectionEstablisher>(
        aOuterConn, aInnerConnInfo, aCaps, std::move(aHeaders), aCallbacks);
  }
};

}  // namespace net
}  // namespace mozilla

#endif  // InnerConnectionEstablisher_h_
