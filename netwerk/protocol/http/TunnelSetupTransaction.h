/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef TunnelSetupTransaction_h_
#define TunnelSetupTransaction_h_

#include <functional>

#include "SpeculativeTransaction.h"
#include "nsHttpResponseHead.h"
#include "nsIInputStream.h"
#include "nsITransportSecurityInfo.h"

namespace mozilla {
namespace net {

// Drives the CONNECT exchange for one inner connection in place of the real
// transaction. It parses the response head itself: NullHttpTransaction never
// parses one, and HandleTunnelResponse is only reachable through
// OnHeadersAvailable, which only nsHttpTransaction calls.
//
// Deliberately not a HappyEyeballsTransaction: IsHappyEyeballsTransaction()
// must stay false so nsHttpConnection::Activate runs CheckTunnelIsNeeded.
class TunnelSetupTransaction final : public SpeculativeTransaction {
 public:
  // What MakeConnectString reads off the real transaction's request head.
  struct RequestHeaderSnapshot {
    nsCString mProxyAuthorization;
    nsCString mUpgrade;
  };

  // 200 means the tunnel is open, not that the connection is usable; the
  // caller waits for SetConnectedCallback.
  using ProxyConnectCallback = std::function<void(uint16_t aStatus)>;

  TunnelSetupTransaction(nsHttpConnectionInfo* aConnInfo,
                         nsIInterfaceRequestor* aCallbacks, uint32_t aCaps,
                         RequestHeaderSnapshot&& aHeaders);

  static RequestHeaderSnapshot SnapshotHeaders(nsAHttpTransaction* aTrans);

  // CONNECT-UDP carries the request through the stream's own ReadSegments
  // instead of nsHttpConnection's proxy-connect stream, so the driver emits
  // it. Unset for a CONNECT tunnel.
  void SetRequestStream(nsIInputStream* aStream) { mRequestStream = aStream; }

  nsresult ReadSegments(nsAHttpSegmentReader* aReader, uint32_t aCount,
                        uint32_t* aCountRead) override;
  // Only the request stream knows when a CONNECT-UDP request is fully out;
  // without one, only the base class' notion of done applies.
  bool IsDone() override {
    return mRequestDone || SpeculativeTransaction::IsDone();
  }

  void SetProxyConnectCallback(ProxyConnectCallback&& aCallback) {
    mProxyConnectCallback = std::move(aCallback);
  }

  // Fires when the inner connection finishes its handshake, or fails.
  void SetConnectedCallback(std::function<void(nsresult)>&& aCallback) {
    mCloseCallback = std::move(aCallback);
  }

  const nsHttpRequestHead* RequestHead() override;
  nsresult WriteSegments(nsAHttpSegmentWriter* aWriter, uint32_t aCount,
                         uint32_t* aCountWritten) override;
  void SetProxyConnectFailed() override { mProxyConnectFailed = true; }
  // Http2StreamTunnel calls this on an HTTP_1_1_REQUIRED reset.
  // NullHttpTransaction ignores it, so record it for the attempt to pass on.
  void DisableHttp2ForProxy() override { mHttp2ProxyDisabled = true; }
  bool Http2ForProxyDisabled() const { return mHttp2ProxyDisabled; }
  void OnProxyConnectComplete(ProxyConnectResponseHead* aHead) override;

  bool ProxyConnectFailed() const { return mProxyConnectFailed; }
  ProxyConnectResponseHead* ResponseHead() const {
    return mProxyConnectResponseHead;
  }
  // The security info of a failed inner TLS handshake, for the real
  // transaction to report the certificate error with.
  nsITransportSecurityInfo* FailedSecurityInfo() const {
    return mFailedSecurityInfo;
  }
  // Body bytes after the response head; only a failed CONNECT has any.
  const nsCString& ResponseBodyPrefix() const { return mResponseBodyPrefix; }

 private:
  ~TunnelSetupTransaction();

  nsresult ParseResponseHead(nsHttpResponseHead& aHead, uint32_t aHeadLength);
  nsresult HandshakeError();

  RequestHeaderSnapshot mHeaders;
  ProxyConnectCallback mProxyConnectCallback;
  RefPtr<ProxyConnectResponseHead> mProxyConnectResponseHead;

  nsCOMPtr<nsIInputStream> mRequestStream;
  bool mRequestDone = false;
  nsCString mResponseBuffer;
  nsCString mResponseBodyPrefix;
  nsCOMPtr<nsITransportSecurityInfo> mFailedSecurityInfo;
  bool mHeadersDone = false;
  bool mProxyConnectFailed = false;
  bool mHttp2ProxyDisabled = false;
};

}  // namespace net
}  // namespace mozilla

#endif  // TunnelSetupTransaction_h_
