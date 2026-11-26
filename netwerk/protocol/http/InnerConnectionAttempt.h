/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef InnerConnectionAttempt_h_
#define InnerConnectionAttempt_h_

#include "ConnectionAttempt.h"
#include "HappyEyeballsConnMgrDelegate.h"
#include "InnerConnectionEstablisher.h"
#include "happy_eyeballs_glue/HappyEyeballs.h"
#include "mozilla/Maybe.h"
#include "mozilla/WeakPtr.h"
#include "nsHttpConnectionInfo.h"
#include "nsINamed.h"
#include "nsITimer.h"

namespace mozilla {
namespace net {

class ConnectionEntry;
class HttpConnectionBase;
class ProxyConnectResponseHead;

// Establishes the inner connection for one transaction through an already
// established outer connection to the proxy, publishing it only once it is
// usable. The real transaction waits in the pending queue meanwhile.
//
// Endpoints come from a Happy Eyeballs machine of its own, running
// ByNameWithHttpsRr: by name because the proxy resolves the origin, and with
// the origin's HTTPS record because its ALPN is what says an inner h3
// connection is possible. That query is answered negatively for now -- see
// AnswerDnsQueryWithoutLookup. Each endpoint becomes an
// InnerConnectionEstablisher, several can be in flight, and the first usable
// connection wins.
//
// It is a ConnectionAttempt so the pool counts it while in flight, which keeps
// ProcessPendingQ from starting a second connection for the transaction.
//
// One attempt, h3 racing the h2/h1 fallback, time running downwards. The two
// legs are independent InnerConnectionEstablishers.
//
//   InnerConnectionAttempt        h3 leg             h2/h1 leg
//   ----------------------        ------             ---------
//   Init
//    CreateHappyEyeballs
//      alt-svc h3 + h1/h2
//    drain the machine
//      SendDnsQuery ...... answered "no record"; the proxy resolves the origin
//      AttemptConnection(h3)
//        StartEndpoint --------> Start
//                                 CreateInnerConnection
//                                  (CONNECT-UDP on the h3 outer conn)
//                                 Activate -> CONNECT goes out
//      Timer(500ms)
//   [timer fires] drain again
//      AttemptConnection(h2/h1)
//        StartEndpoint ----------------------------> Start
//                                                    CreateInnerConnection
//                                                     (h2 tunnel stream)
//                                                    Activate -> CONNECT
//                                <- 200
//                                <- inner TLS done
//                                Finish(NS_OK)
//   OnEstablisherDone(ok) <------'
//    Succeeded
//      InsertIntoActiveConns
//      DetachSetupTransaction .. the driver still owns the conn in this stack
//      DispatchTransaction ..... the real transaction leaves the pending queue
//      CloseEndpoints ------------------------------------> Close (the loser)
//      RemoveConnectionAttempt . runs ProcessPendingQForEntry
//
class InnerConnectionAttempt final : public ConnectionAttempt,
                                     public nsITimerCallback,
                                     public nsINamed {
 public:
  NS_DECL_ISUPPORTS_INHERITED
  NS_DECL_NSITIMERCALLBACK
  NS_DECL_NSINAMED

  InnerConnectionAttempt(nsHttpConnectionInfo* aInnerConnInfo,
                         nsAHttpTransaction* aTrans, uint32_t aCaps,
                         HttpConnectionBase* aOuterConn);

  nsresult Init(ConnectionEntry* aEnt) override;
  void Abandon() override;
  double Duration(TimeStamp aEpoch) override;
  bool Claim(nsHttpTransaction* aNewTransaction = nullptr) override;
  // Dispatching the pending transaction elsewhere frees nothing here: the
  // attempt stays bound to its creator (see ConnectionAttempt::Unclaim).
  void Unclaim() override {}
  void OnTimeout() override;
  void PrintDiagnostics(nsCString& aLog) override;
  bool OwnsConnection(HttpConnectionBase* aConn) const override;

  // Test-only seams; call before Init().
  void SetConnMgrDelegateForTesting(HappyEyeballsConnMgrDelegate* aDelegate) {
    mConnMgrDelegate = aDelegate;
  }
  void SetEstablisherFactoryForTesting(
      InnerConnectionEstablisherFactory* aFactory) {
    mEstablisherFactory = aFactory;
  }

 private:
  // One endpoint the state machine handed us, in flight.
  struct Endpoint {
    uint64_t mId = 0;
    RefPtr<InnerConnectionEstablisher> mEstablisher;
  };

  // A refused CONNECT. Failed() hands it to the real transaction, so the
  // proxy's answer becomes the response rather than a connection error.
  struct RefusedConnect {
    RefPtr<ProxyConnectResponseHead> mHead;
    nsCString mBodyPrefix;
  };

  ~InnerConnectionAttempt();

  nsresult CreateHappyEyeballs();
  // Drains the machine's output queue. Inputs fed from inside the loop only
  // update the machine; the same loop picks up what they produce.
  nsresult ProcessHappyEyeballsOutput();

  // TODO: resolve it with DoH through the proxy, so the record comes from where
  // the origin is actually reached, and honor its ALPN and target name (see
  // EndpointConnInfo).
  void AnswerDnsQueryWithoutLookup(uint64_t aId,
                                   happy_eyeballs::DnsRecordType aType);

  // Connection info for aHost:aPort over aVersion.
  already_AddRefed<nsHttpConnectionInfo> EndpointConnInfo(
      const nsACString& aHost, uint16_t aPort,
      happy_eyeballs::ConnectionAttemptHttpVersions aVersion);
  void StartEndpoint(const nsACString& aHost, uint16_t aPort,
                     happy_eyeballs::ConnectionAttemptHttpVersions aVersion,
                     uint64_t aId);
  void CancelEndpoint(uint64_t aId);
  void CloseEndpoints(nsresult aReason);
  // Removes aId from the in-flight list and hands its establisher over.
  already_AddRefed<InnerConnectionEstablisher> TakeEndpoint(uint64_t aId);
  nsHttpTransaction* RealTransaction() const;

  void OnEstablisherDone(
      uint64_t aId, Result<RefPtr<HttpConnectionBase>, nsresult>&& aResult);
  // Publishes and dispatches before leaving the pool: leaving triggers
  // ProcessPendingQForEntry, which must not find the transaction still pending
  // with no attempt in flight.
  void Succeeded(ConnectionEntry* aEntry, HttpConnectionBase* aConn);
  void Failed(ConnectionEntry* aEntry, nsresult aReason);

  RefPtr<HttpConnectionBase> mOuterConn;
  WeakPtr<ConnectionEntry> mEntry;
  RefPtr<HappyEyeballs> mHappyEyeballs;
  RefPtr<HappyEyeballsConnMgrDelegate> mConnMgrDelegate;
  RefPtr<InnerConnectionEstablisherFactory> mEstablisherFactory;
  nsTArray<Endpoint> mEndpoints;
  // Kept alive until mWinnerConn is published.
  RefPtr<InnerConnectionEstablisher> mWinner;
  RefPtr<HttpConnectionBase> mWinnerConn;
  // The first refused CONNECT. The proxy has decided, so the attempt stops
  // there rather than asking again over another endpoint.
  Maybe<RefusedConnect> mRefusedConnect;
  TimeStamp mStart;
  nsresult mLastError = NS_OK;
  // The security info of a failed inner TLS handshake, which the real
  // transaction needs to report the certificate error.
  nsCOMPtr<nsITransportSecurityInfo> mFailedSecurityInfo;
  // The proxy demanded HTTP/1.1 for the CONNECT, so the restart has to drop
  // HTTP/2 for it.
  bool mProxyRequiresHttp11 = false;
  // Init() is pumping the machine: not in the pool yet, so a failure goes back
  // to the caller instead of being acted on.
  bool mInitializing = false;
  bool mDone = false;
};

}  // namespace net
}  // namespace mozilla

#endif  // InnerConnectionAttempt_h_
