/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// HttpLog.h should generally be included first
#include "InnerConnectionAttempt.h"

#include "ConnectionEntry.h"
#include "HttpConnectionBase.h"
#include "HttpLog.h"
#include "PendingTransactionInfo.h"
#include "mozilla/StaticPrefs_network.h"
#include "mozilla/net/DNS.h"
#include "nsHttp.h"
#include "nsHttpConnection.h"
#include "nsHttpConnectionMgr.h"
#include "nsHttpHandler.h"
#include "nsHttpResponseHead.h"
#include "nsHttpTransaction.h"
#include "nsQueryObject.h"

namespace mozilla::net {

using happy_eyeballs::happy_eyeballs_process_connection_result;
using happy_eyeballs::happy_eyeballs_process_dns_response_a;
using happy_eyeballs::happy_eyeballs_process_dns_response_aaaa;
using happy_eyeballs::happy_eyeballs_process_dns_response_https;
using happy_eyeballs::happy_eyeballs_process_output;

NS_IMPL_ADDREF_INHERITED(InnerConnectionAttempt, ConnectionAttempt)
NS_IMPL_RELEASE_INHERITED(InnerConnectionAttempt, ConnectionAttempt)

NS_INTERFACE_MAP_BEGIN(InnerConnectionAttempt)
  NS_INTERFACE_MAP_ENTRY(nsISupportsWeakReference)
  NS_INTERFACE_MAP_ENTRY(nsITimerCallback)
  NS_INTERFACE_MAP_ENTRY(nsINamed)
NS_INTERFACE_MAP_END_INHERITING(ConnectionAttempt)

InnerConnectionAttempt::InnerConnectionAttempt(
    nsHttpConnectionInfo* aInnerConnInfo, nsAHttpTransaction* aTrans,
    uint32_t aCaps, HttpConnectionBase* aOuterConn)
    : ConnectionAttempt(aInnerConnInfo, aTrans, aCaps, /* speculative */ false,
                        /* urgentStart */ false),
      mOuterConn(aOuterConn),
      mConnMgrDelegate(new DefaultHappyEyeballsConnMgrDelegate()),
      mEstablisherFactory(new DefaultInnerConnectionEstablisherFactory()) {
  LOG(("InnerConnectionAttempt ctor %p outer=%p ci=%s", this, aOuterConn,
       aInnerConnInfo->HashKey().get()));
}

InnerConnectionAttempt::~InnerConnectionAttempt() {
  LOG(("InnerConnectionAttempt dtor %p", this));
}

nsresult InnerConnectionAttempt::Init(ConnectionEntry* aEnt) {
  MOZ_ASSERT(OnSocketThread(), "not on socket thread");
  LOG(("InnerConnectionAttempt::Init %p ent=%p", this, aEnt));

  mEntry = aEnt;
  mStart = TimeStamp::Now();

  nsresult rv = CreateHappyEyeballs();
  if (NS_FAILED(rv)) {
    LOG(("  CreateHappyEyeballs failed rv=%" PRIx32,
         static_cast<uint32_t>(rv)));
    return rv;
  }

  // Not in the pool yet, so this first drain publishes and removes nothing; a
  // failure here is the caller's to act on.
  mInitializing = true;
  rv = ProcessHappyEyeballsOutput();
  mInitializing = false;
  if (NS_FAILED(rv)) {
    return rv;
  }
  if (mDone) {
    return NS_FAILED(mLastError) ? mLastError : NS_ERROR_FAILURE;
  }
  return NS_OK;
}

nsresult InnerConnectionAttempt::CreateHappyEyeballs() {
  const uint16_t originPort = static_cast<uint16_t>(mConnInfo->OriginPort());

  // An h3 inner connection is a CONNECT-UDP tunnel, so it needs an h3 outer
  // connection. H2/H1 stay on as the fallback.
  const bool outerIsHttp3 = mOuterConn && mOuterConn->UsingHttp3();
  const bool http3Only = mConnInfo->GetHttp3Only();
  const bool useHttp3 = outerIsHttp3 && mConnInfo->IsHttp3() &&
                        nsHttpHandler::IsHttp3Enabled() &&
                        !(mCaps & NS_HTTP_DISALLOW_HTTP3);
  if (http3Only && !useHttp3) {
    // An http3-only conn info has h1/h2 disabled, so nothing is left. Not
    // NS_ERROR_NOT_AVAILABLE: the connection manager reads that as "queue the
    // transaction and wait", and nothing would retry it.
    LOG(
        ("InnerConnectionAttempt::CreateHappyEyeballs %p http3-only inner conn "
         "info through a non-HTTP/3 outer connection",
         this));
    return NS_ERROR_FAILURE;
  }
  happy_eyeballs::HttpVersions httpVersions{
      /* h1 */ !http3Only,
      /* h2 */ !http3Only && StaticPrefs::network_http_http2_enabled(),
      /* h3 */ useHttp3,
  };

  // h3 goes in as an alt-svc entry, as HappyEyeballsConnectionAttempt does it,
  // so the machine tries it first but still falls back to the origin. Name the
  // routed host: it is the authority the CONNECT-UDP target uses, so this keeps
  // the machine and the tunnel in agreement.
  const nsCString& routedHost = mConnInfo->GetRoutedHost();
  nsTArray<happy_eyeballs::AltSvc> altSvcArray;
  if (useHttp3) {
    happy_eyeballs::AltSvc altsvc{};
    altsvc.http_version = happy_eyeballs::HttpVersion::H3;
    if (!routedHost.IsEmpty()) {
      altsvc.host = routedHost;
      altsvc.port = static_cast<uint16_t>(mConnInfo->RoutedPort());
    }
    altSvcArray.AppendElement(std::move(altsvc));
  }

  // Endpoints come out by name -- the proxy resolves the origin -- so
  // IpPreference is unused: there is no address family to race. An IP-literal
  // origin is the exception and comes out as its address.
  LOG(("InnerConnectionAttempt::CreateHappyEyeballs %p origin=%s:%d h3=%d",
       this, mConnInfo->Origin(), originPort, useHttp3));
  return HappyEyeballs::Init(
      getter_AddRefs(mHappyEyeballs), mConnInfo->GetOrigin(), originPort,
      &altSvcArray, happy_eyeballs::IpPreference::DualStackPreferV6,
      httpVersions, happy_eyeballs::ResolutionMode::ByNameWithHttpsRr,
      StaticPrefs::
          network_http_happy_eyeballs_inner_connection_attempt_delay());
}

nsresult InnerConnectionAttempt::ProcessHappyEyeballsOutput() {
  MOZ_ASSERT(OnSocketThread(), "not on socket thread");

  while (!mDone) {
    happy_eyeballs::Output event{};
    nsTArray<uint8_t> echConfig;
    nsCString dnsHostname;
    nsresult rv = happy_eyeballs_process_output(mHappyEyeballs, &event,
                                                &echConfig, &dnsHostname);
    if (NS_FAILED(rv)) {
      LOG(
          ("InnerConnectionAttempt::ProcessHappyEyeballsOutput %p failed "
           "rv=%" PRIx32,
           this, static_cast<uint32_t>(rv)));
      return rv;
    }

    switch (event.tag) {
      case happy_eyeballs::Output::Tag::SendDnsQuery:
        AnswerDnsQueryWithoutLookup(event.send_dns_query.id,
                                    event.send_dns_query.record_type);
        break;

      case happy_eyeballs::Output::Tag::Timer:
        SetupAttemptTimer(event.timer.duration_us, this);
        return NS_OK;

      case happy_eyeballs::Output::Tag::AttemptConnectionByName:
        StartEndpoint(dnsHostname, event.attempt_connection_by_name.port,
                      event.attempt_connection_by_name.http_version,
                      event.attempt_connection_by_name.id);
        break;

      case happy_eyeballs::Output::Tag::AttemptConnection: {
        // An IP-literal origin or alt-svc host needs no resolution, so the
        // machine offers its address. The proxy is asked for the same literal,
        // named as the conn info names it, which EndpointConnInfo matches on.
        const auto& attempt = event.attempt_connection;
        const bool altSvcRoute =
            attempt.http_version ==
                happy_eyeballs::ConnectionAttemptHttpVersions::H3 &&
            !mConnInfo->GetRoutedHost().IsEmpty();
        StartEndpoint(
            altSvcRoute ? mConnInfo->GetRoutedHost() : mConnInfo->GetOrigin(),
            attempt.port, attempt.http_version, attempt.id);
        break;
      }

      case happy_eyeballs::Output::Tag::CancelConnection:
        CancelEndpoint(event.cancel_connection.id);
        break;

      case happy_eyeballs::Output::Tag::Succeeded:
        // OnEstablisherDone published the winner already.
        return NS_OK;

      case happy_eyeballs::Output::Tag::Failed: {
        LOG(("InnerConnectionAttempt %p failed reason=%d", this,
             static_cast<uint32_t>(event.failed.reason)));
        nsresult reason =
            NS_FAILED(mLastError) ? mLastError : NS_ERROR_CONNECTION_REFUSED;
        if (mInitializing) {
          // Not even one endpoint could be started. Init() reports this.
          mDone = true;
          mLastError = reason;
          CancelAttemptTimer();
          return NS_OK;
        }
        RefPtr<ConnectionEntry> entry(mEntry);
        if (!entry) {
          Abandon();
          return NS_OK;
        }
        Failed(entry, reason);
        return NS_OK;
      }

      case happy_eyeballs::Output::Tag::None:
        return NS_OK;
    }
  }

  return NS_OK;
}

void InnerConnectionAttempt::AnswerDnsQueryWithoutLookup(
    uint64_t aId, happy_eyeballs::DnsRecordType aType) {
  LOG(("InnerConnectionAttempt::AnswerDnsQueryWithoutLookup %p id=%" PRIu64
       " type=%d",
       this, aId, static_cast<uint32_t>(aType)));

  switch (aType) {
    case happy_eyeballs::DnsRecordType::Https: {
      // An empty answer is a negative one, so the machine falls back to the
      // origin by name.
      nsTArray<happy_eyeballs::ServiceInfo> noRecords;
      (void)happy_eyeballs_process_dns_response_https(
          mHappyEyeballs, aId, &noRecords, /* is_trr */ false,
          /* stale */ false);
      break;
    }
    case happy_eyeballs::DnsRecordType::Aaaa: {
      MOZ_ASSERT_UNREACHABLE("AAAA query for an inner connection");
      nsTArray<happy_eyeballs::IpAddr> noAddrs;
      (void)happy_eyeballs_process_dns_response_aaaa(
          mHappyEyeballs, aId, &noAddrs, /* is_trr */ false, /* stale */ false);
      break;
    }
    case happy_eyeballs::DnsRecordType::A: {
      MOZ_ASSERT_UNREACHABLE("A query for an inner connection");
      nsTArray<happy_eyeballs::IpAddr> noAddrs;
      (void)happy_eyeballs_process_dns_response_a(
          mHappyEyeballs, aId, &noAddrs, /* is_trr */ false, /* stale */ false);
      break;
    }
  }
}

already_AddRefed<nsHttpConnectionInfo> InnerConnectionAttempt::EndpointConnInfo(
    const nsACString& aHost, uint16_t aPort,
    happy_eyeballs::ConnectionAttemptHttpVersions aVersion) {
  const bool wantsHttp3 =
      aVersion == happy_eyeballs::ConnectionAttemptHttpVersions::H3;
  const uint16_t port =
      aPort ? aPort : static_cast<uint16_t>(mConnInfo->OriginPort());

  // The alt-svc alternate, which the conn info already describes. Match
  // authority and protocol, not the host alone: an "h3=:port" route carries the
  // origin's host, so a host-only test would swallow the origin's own H2/H1
  // fallback endpoint.
  const nsCString& routedHost = mConnInfo->GetRoutedHost();
  const uint16_t routedPort = static_cast<uint16_t>(mConnInfo->RoutedPort());
  if (!routedHost.IsEmpty() && aHost.Equals(routedHost) && aPort &&
      aPort == routedPort && wantsHttp3 == mConnInfo->IsHttp3()) {
    return do_AddRef(mConnInfo);
  }

  // The machine only ever names the origin or the alt-svc route we gave it, and
  // the CONNECT authority comes from the origin either way (see
  // MakeConnectString), so the host needs no further say.
  MOZ_ASSERT(aHost.Equals(mConnInfo->GetOrigin()),
             "endpoint host is neither the origin nor the alt-svc route");

  if (port == mConnInfo->OriginPort() && wantsHttp3 == mConnInfo->IsHttp3()) {
    return do_AddRef(mConnInfo);
  }

  // A different protocol -- the H2/H1 fallback for an h3 origin -- needs its
  // own conn info: the ALPN and CreateInnerConnection's tunnel choice both come
  // from it.
  RefPtr<nsHttpConnectionInfo> info =
      mConnInfo->CloneAndAdoptPortAndAlpn(port, aVersion);
  LOG(("InnerConnectionAttempt %p endpoint ci=%s (origin ci=%s)", this,
       info->HashKey().get(), mConnInfo->HashKey().get()));
  return info.forget();
}

void InnerConnectionAttempt::StartEndpoint(
    const nsACString& aHost, uint16_t aPort,
    happy_eyeballs::ConnectionAttemptHttpVersions aVersion, uint64_t aId) {
  RefPtr<nsHttpConnectionInfo> info = EndpointConnInfo(aHost, aPort, aVersion);
  LOG(("InnerConnectionAttempt::StartEndpoint %p id=%" PRIu64 " ci=%s", this,
       aId, info->HashKey().get()));

  nsCOMPtr<nsIInterfaceRequestor> callbacks;
  if (mTransaction) {
    mTransaction->GetSecurityCallbacks(getter_AddRefs(callbacks));
  }

  RefPtr<InnerConnectionEstablisher> establisher = mEstablisherFactory->Create(
      mOuterConn, info, mCaps,
      TunnelSetupTransaction::SnapshotHeaders(mTransaction), callbacks);
  mEndpoints.AppendElement(Endpoint{aId, establisher});

  // Start reports everything through the callback, synchronous failures
  // included.
  establisher->Start(
      [self = RefPtr{this},
       aId](Result<RefPtr<HttpConnectionBase>, nsresult>&& aResult) {
        self->OnEstablisherDone(aId, std::move(aResult));
      });
}

already_AddRefed<InnerConnectionEstablisher>
InnerConnectionAttempt::TakeEndpoint(uint64_t aId) {
  for (size_t i = 0; i < mEndpoints.Length(); ++i) {
    if (mEndpoints[i].mId != aId) {
      continue;
    }
    RefPtr<InnerConnectionEstablisher> establisher =
        std::move(mEndpoints[i].mEstablisher);
    mEndpoints.RemoveElementAt(i);
    return establisher.forget();
  }
  return nullptr;
}

nsHttpTransaction* InnerConnectionAttempt::RealTransaction() const {
  return mTransaction ? mTransaction->QueryHttpTransaction() : nullptr;
}

void InnerConnectionAttempt::CancelEndpoint(uint64_t aId) {
  LOG(("InnerConnectionAttempt::CancelEndpoint %p id=%" PRIu64, this, aId));

  if (RefPtr<InnerConnectionEstablisher> establisher = TakeEndpoint(aId)) {
    establisher->Close(NS_ERROR_ABORT);
  }
}

void InnerConnectionAttempt::CloseEndpoints(nsresult aReason) {
  nsTArray<Endpoint> endpoints = std::move(mEndpoints);
  for (const auto& endpoint : endpoints) {
    if (endpoint.mEstablisher) {
      endpoint.mEstablisher->Close(aReason);
    }
  }
}

void InnerConnectionAttempt::OnEstablisherDone(
    uint64_t aId, Result<RefPtr<HttpConnectionBase>, nsresult>&& aResult) {
  MOZ_ASSERT(OnSocketThread(), "not on socket thread");
  const bool succeeded = aResult.isOk();
  LOG(("InnerConnectionAttempt::OnEstablisherDone %p id=%" PRIu64 " ok=%d",
       this, aId, succeeded));

  if (mDone) {
    return;
  }

  // Publishing or failing below drops us from the pool, which may hold the last
  // reference.
  RefPtr<InnerConnectionAttempt> deleteProtector(this);

  // Out of the in-flight list but kept alive: we still need its connection or
  // the CONNECT response it captured.
  RefPtr<InnerConnectionEstablisher> establisher = TakeEndpoint(aId);
  if (!establisher) {
    LOG(("  endpoint %" PRIu64 " is gone; ignoring its result", aId));
    return;
  }

  RefPtr<ConnectionEntry> entry(mEntry);
  if (!entry) {
    LOG(("  entry is gone"));
    // An entry only goes away once its pending queue is empty, so the
    // transaction was closed or dispatched elsewhere and is not ours; wind
    // down as the other entry-gone paths do. The endpoint taken above is no
    // longer in the list CloseEndpoints walks.
    if (establisher) {
      establisher->Close(NS_ERROR_ABORT);
    }
    Abandon();
    return;
  }

  if (succeeded) {
    mWinner = establisher;
    mWinnerConn = aResult.unwrap();
    if (TunnelSetupTransaction* setup =
            establisher ? establisher->Transaction() : nullptr) {
      mEstablishedConnect = setup->ResponseHead();
    }
    // Tell the machine first so it stops handing out endpoints. Publishing
    // must not wait on an output event.
    nsresult rv =
        happy_eyeballs_process_connection_result(mHappyEyeballs, aId, NS_OK);
    if (NS_FAILED(rv)) {
      LOG(("  feeding the machine failed rv=%" PRIx32,
           static_cast<uint32_t>(rv)));
    }
    Succeeded(entry, mWinnerConn);
    return;
  }

  mLastError = aResult.unwrapErr();

  TunnelSetupTransaction* driver =
      establisher ? establisher->Transaction() : nullptr;
  if (driver && driver->FailedSecurityInfo()) {
    mFailedSecurityInfo = driver->FailedSecurityInfo();
  }
  if (driver && driver->Http2ForProxyDisabled()) {
    mProxyRequiresHttp11 = true;
    // Only a reset makes nsHttpTransaction::Close restart the transaction,
    // and that restart is what reaches a fresh outer connection.
    mLastError = NS_ERROR_NET_RESET;
  }

  // The proxy has decided, and every other endpoint over this outer connection
  // gets the same answer: a non-200 is the response to deliver, and
  // HTTP_1_1_REQUIRED on the CONNECT stream is a demand for a different outer
  // connection. Either way, stop here.
  const bool refused =
      driver && driver->ProxyConnectFailed() && driver->ResponseHead();
  if (refused || mProxyRequiresHttp11) {
    if (refused && mRefusedConnect.isNothing()) {
      mRefusedConnect.emplace(
          RefusedConnect{driver->ResponseHead(), driver->ResponseBodyPrefix()});
    }
    if (mInitializing) {
      // Not in the pool yet; Init() reports this and the transaction stays
      // pending.
      mDone = true;
      CancelAttemptTimer();
      CloseEndpoints(NS_ERROR_ABORT);
      return;
    }
    Failed(entry, mLastError);
    return;
  }

  nsresult rv =
      happy_eyeballs_process_connection_result(mHappyEyeballs, aId, mLastError);
  if (NS_FAILED(rv)) {
    LOG(("  feeding the machine failed rv=%" PRIx32,
         static_cast<uint32_t>(rv)));
    return;
  }
  rv = ProcessHappyEyeballsOutput();
  if (NS_FAILED(rv)) {
    LOG(("  draining the machine failed rv=%" PRIx32,
         static_cast<uint32_t>(rv)));
    Failed(entry, rv);
  }
}

void InnerConnectionAttempt::Succeeded(ConnectionEntry* aEntry,
                                       HttpConnectionBase* aConn) {
  LOG(("InnerConnectionAttempt::Succeeded %p conn=%p", this, aConn));

  mDone = true;
  CancelAttemptTimer();
  RefPtr<ConnectionEntry> entry(aEntry);
  RefPtr<HttpConnectionBase> conn(aConn);

  CloseEndpoints(NS_ERROR_ABORT);

  mConnMgrDelegate->InsertIntoActiveConns(entry, conn);

  // On a synchronous handover we are inside the driver's WriteSegments, so it
  // is still this connection's transaction and Activate refuses a connection
  // that has one. Drop it without closing, so the read loop hands what the
  // origin already sent to the real transaction.
  if (mWinner) {
    if (RefPtr<nsHttpConnection> connTCP = do_QueryObject(conn)) {
      connTCP->DetachSetupTransaction(mWinner->Transaction());
    }
  }

  RefPtr<nsHttpTransaction> trans = RealTransaction();
  bool dispatched = false;
  if (trans) {
    RefPtr<PendingTransactionInfo> pending =
        mConnMgrDelegate->FindTransaction(true, entry, trans);
    if (pending) {
      trans->SetConnection(nullptr);
      // A connect-only consumer wants the tunnel, not a request over it. The
      // driver read the CONNECT response, so pass it on: without it the
      // transaction closes empty and the channel sees a bogus HTTP/0.9 reply.
      if ((mCaps & NS_HTTP_CONNECT_ONLY) && mEstablishedConnect) {
        LOG(("  handing CONNECT status=%u to connect-only trans=%p",
             mEstablishedConnect->Head().Status(), trans.get()));
        trans->OnProxyConnectComplete(mEstablishedConnect);
        trans->InjectProxyConnectResponse(mEstablishedConnect->Head(),
                                          EmptyCString());
      }
      nsresult rv = mConnMgrDelegate->DispatchTransaction(
          entry, pending->Transaction(), conn);
      if (NS_FAILED(rv)) {
        trans->Close(rv);
      } else {
        dispatched = true;
      }
    } else {
      LOG(("  transaction no longer pending; not dispatching onto conn %p",
           conn.get()));
    }
  }
  mTransaction = nullptr;

  if (!dispatched && !conn->UsingSpdy() && !conn->UsingHttp3()) {
    // An HTTP/1 connection with nothing on it is invisible to the idle-dispatch
    // step and nothing would ever reclaim it from the active list, so return it
    // to the pool the way the outer path does in ProcessTCPConn.
    if (RefPtr<nsHttpConnection> h1 = do_QueryObject(conn)) {
      h1->SetIsReusedAfter(950);
    }
    mConnMgrDelegate->ReclaimConnection(conn);
  }

  // Only now: publishing can take the connection h2, and the sweep that follows
  // asks OwnsConnection which attempt to spare.
  if (mWinner) {
    mWinner->HandedOver();
  }
  mWinner = nullptr;
  mWinnerConn = nullptr;

  // Last: this triggers ProcessPendingQForEntry once the pool empties.
  mConnMgrDelegate->RemoveConnectionAttempt(entry, this, /* abandon = */ false);
}

void InnerConnectionAttempt::Failed(ConnectionEntry* aEntry, nsresult aReason) {
  LOG(("InnerConnectionAttempt::Failed %p reason=%" PRIx32, this,
       static_cast<uint32_t>(aReason)));

  mDone = true;
  CancelAttemptTimer();
  RefPtr<ConnectionEntry> entry(aEntry);
  CloseEndpoints(NS_ERROR_ABORT);

  // Only a transaction still waiting on this attempt is ours to complete. The
  // entry may have dispatched it onto another connection meanwhile (an idle
  // tunnel a sibling attempt published, say), in which case it is live there
  // and the proxy's answer to our CONNECT means nothing to it.
  RefPtr<nsHttpTransaction> trans = RealTransaction();
  RefPtr<PendingTransactionInfo> pending =
      trans ? mConnMgrDelegate->FindTransaction(true, entry, trans) : nullptr;
  if (trans && !pending) {
    LOG(("  trans=%p no longer pending; leaving it alone", trans.get()));
  } else if (trans) {
    if (mRefusedConnect.isSome()) {
      // The proxy answered, so its answer is the response rather than a
      // connection error. Completing with NS_OK lets nsHttpChannel run
      // ProcessResponse, which routes 407 to auth and the rest to
      // ProcessFailedProxyConnect.
      RefPtr<ProxyConnectResponseHead> head = mRefusedConnect->mHead;
      LOG(("  delivering CONNECT status=%u to trans=%p", head->Head().Status(),
           trans.get()));
      trans->SetProxyConnectFailed();
      trans->OnProxyConnectComplete(head);
      trans->InjectProxyConnectResponse(head->Head(),
                                        mRefusedConnect->mBodyPrefix);
      trans->Close(NS_OK);
    } else {
      // No answer at all: a genuine connection failure.
      nsresult reason = aReason;
      if (mProxyRequiresHttp11) {
        // HTTP_1_1_REQUIRED on the CONNECT stream. Carry the demand over, or
        // the restart asks the same HTTP/2 proxy the same question.
        LOG(("  proxy requires HTTP/1.1; disabling HTTP/2 for trans=%p",
             trans.get()));
        trans->DisableHttp2ForProxy();
      } else if ((aReason == NS_ERROR_UNEXPECTED ||
                  aReason == NS_ERROR_NET_INTERRUPT) &&
                 mOuterConn && !mOuterConn->CanReuse()) {
        // The outer connection went away under the attempt: no session left
        // to open the tunnel on, or the tunnel closed cleanly before any
        // CONNECT response. Only a reset makes nsHttpTransaction::Close
        // restart, and the restart is what reaches a fresh outer connection.
        // A session error stays as it is, as it would for any transaction on
        // that session; restarting would meet the same failure again.
        LOG(("  outer conn %p is gone; closing trans=%p with a reset",
             mOuterConn.get(), trans.get()));
        reason = NS_ERROR_NET_RESET;
      }
      if (mFailedSecurityInfo) {
        trans->SetSecurityInfo(mFailedSecurityInfo);
      }
      trans->Close(reason);
    }
  }
  mTransaction = nullptr;

  mConnMgrDelegate->RemoveConnectionAttempt(entry, this, /* abandon = */ false);
}

void InnerConnectionAttempt::Abandon() {
  LOG(("InnerConnectionAttempt::Abandon %p", this));

  mDone = true;
  RefPtr<InnerConnectionAttempt> deleteProtector(this);
  CancelAttemptTimer();
  CloseEndpoints(NS_ERROR_ABORT);
  if (mWinner) {
    // Won but never published, so nobody else will close it.
    mWinner->Close(NS_ERROR_ABORT);
    mWinner = nullptr;
  }
  mWinnerConn = nullptr;
  mRefusedConnect.reset();
  mTransaction = nullptr;
  mEntry = nullptr;
  mOuterConn = nullptr;
}

double InnerConnectionAttempt::Duration(TimeStamp aEpoch) {
  if (mStart.IsNull()) {
    return 0;
  }
  return (aEpoch - mStart).ToMilliseconds();
}

bool InnerConnectionAttempt::Claim(nsHttpTransaction*) {
  // One attempt per transaction; never free for another to claim.
  if (mFreeToUse) {
    mFreeToUse = false;
    return true;
  }
  return false;
}

void InnerConnectionAttempt::OnTimeout() {
  LOG(("InnerConnectionAttempt::OnTimeout %p", this));

  if (mDone) {
    return;
  }
  RefPtr<ConnectionEntry> entry(mEntry);
  if (!entry) {
    Abandon();
    return;
  }
  Failed(entry, NS_ERROR_NET_TIMEOUT);
}

bool InnerConnectionAttempt::OwnsConnection(HttpConnectionBase* aConn) const {
  if (!aConn) {
    return false;
  }
  if (mWinner && mWinner->ResultConn() == aConn) {
    return true;
  }
  for (const auto& endpoint : mEndpoints) {
    if (endpoint.mEstablisher && endpoint.mEstablisher->ResultConn() == aConn) {
      return true;
    }
  }
  return false;
}

NS_IMETHODIMP InnerConnectionAttempt::Notify(nsITimer*) {
  if (mDone) {
    return NS_OK;
  }

  RefPtr<InnerConnectionAttempt> deleteProtector(this);
  nsresult rv = ProcessHappyEyeballsOutput();
  if (NS_FAILED(rv) && !mDone) {
    if (RefPtr<ConnectionEntry> entry = mEntry.get()) {
      Failed(entry, rv);
    } else {
      Abandon();
    }
  }
  return rv;
}

NS_IMETHODIMP InnerConnectionAttempt::GetName(nsACString& aName) {
  aName.AssignLiteral("InnerConnectionAttempt");
  return NS_OK;
}

void InnerConnectionAttempt::PrintDiagnostics(nsCString& aLog) {
  aLog.AppendPrintf(
      "     ::: InnerConnectionAttempt %p conn-info=%s in-flight=%zu\n", this,
      mConnInfo ? mConnInfo->HashKey().get() : "", mEndpoints.Length());
}

}  // namespace mozilla::net
