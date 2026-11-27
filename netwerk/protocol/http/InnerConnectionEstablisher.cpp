/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "InnerConnectionEstablisher.h"

#include "HttpConnectionBase.h"
#include "HttpConnectionUDP.h"
#include "HttpLog.h"
#include "nsHttpHandler.h"
#include "nsQueryObject.h"
#include "nsThreadUtils.h"

namespace mozilla::net {

InnerConnectionEstablisher::InnerConnectionEstablisher(
    HttpConnectionBase* aOuterConn, nsHttpConnectionInfo* aInnerConnInfo,
    uint32_t aCaps, TunnelSetupTransaction::RequestHeaderSnapshot&& aHeaders,
    nsIInterfaceRequestor* aCallbacks)
    : mOuterConn(aOuterConn),
      mConnInfo(aInnerConnInfo),
      mCaps(aCaps),
      mCallbacks(aCallbacks) {
  LOG(("InnerConnectionEstablisher ctor %p outer=%p ci=%s", this, aOuterConn,
       aInnerConnInfo->HashKey().get()));
  mTransaction = new TunnelSetupTransaction(aInnerConnInfo, aCallbacks, aCaps,
                                            std::move(aHeaders));
}

InnerConnectionEstablisher::~InnerConnectionEstablisher() {
  LOG(("InnerConnectionEstablisher dtor %p", this));
}

void InnerConnectionEstablisher::Start(DoneCallback&& aCallback) {
  MOZ_ASSERT(OnSocketThread(), "not on socket thread");
  LOG(("InnerConnectionEstablisher::Start %p", this));

  mCallback = std::move(aCallback);

  mTransaction->SetProxyConnectCallback(
      [self = RefPtr{this}](uint16_t aStatus) {
        self->OnProxyConnectStatus(aStatus);
      });
  mTransaction->SetConnectedCallback([self = RefPtr{this}](nsresult aStatus) {
    self->OnInnerConnected(aStatus);
  });

  RefPtr<HttpConnectionBase> innerConn;
  nsresult rv = mOuterConn->CreateInnerConnection(mTransaction,
                                                  getter_AddRefs(innerConn));
  if (NS_FAILED(rv) || !innerConn) {
    LOG(("  CreateInnerConnection failed rv=%" PRIx32,
         static_cast<uint32_t>(rv)));
    Finish(NS_FAILED(rv) ? rv : NS_ERROR_FAILURE);
    return;
  }

  mResultConn = innerConn;
  innerConn->SetInTunnel();

  // An h3 handshake runs on its own QUIC session inside the tunnel and never
  // closes the driver, so ask the connection to report it.
  if (RefPtr<HttpConnectionUDP> udpConn = do_QueryObject(innerConn)) {
    udpConn->SetHandshakeDoneCallback(
        [self = RefPtr{this}]() { self->OnInnerHandshakeDone(); });
  }

  // The driver needs a connection of its own to reach OnHeadersAvailable.
  mHandle = new ConnectionHandle(innerConn);
  mTransaction->SetConnection(mHandle);

  // Activating runs CheckTunnelIsNeeded, which puts the CONNECT on the wire.
  rv = innerConn->Activate(mTransaction, mCaps, 0);
  if (NS_FAILED(rv)) {
    LOG(("  Activate failed rv=%" PRIx32, static_cast<uint32_t>(rv)));
    Finish(rv);
  }
}

void InnerConnectionEstablisher::OnProxyConnectStatus(uint16_t aStatus) {
  LOG(("InnerConnectionEstablisher::OnProxyConnectStatus %p status=%u", this,
       aStatus));

  if (aStatus != 200) {
    Finish(NS_ERROR_PROXY_CONNECTION_REFUSED);
    return;
  }

  mTunnelOpen = true;

  // Nothing orders the CONNECT response against the h3 handshake callback,
  // so whichever lands second completes the establisher.
  if (mInnerHandshakeDone) {
    Finish(NS_OK);
    return;
  }

  // No inner TLS, so no connected callback is coming.
  if (!mConnInfo->EndToEndSSL()) {
    LOG(("  plain-http origin, no inner TLS: tunnel is the whole handshake"));
    Finish(NS_OK, /* aSynchronous */ true);
  }
}

void InnerConnectionEstablisher::OnInnerConnected(nsresult aStatus) {
  LOG(("InnerConnectionEstablisher::OnInnerConnected %p status=%" PRIx32
       " tunnelOpen=%d",
       this, static_cast<uint32_t>(aStatus), mTunnelOpen));

  if (NS_SUCCEEDED(aStatus) && !mTunnelOpen) {
    // Closed cleanly with no CONNECT response: the outer connection went away.
    Finish(NS_ERROR_NET_INTERRUPT);
    return;
  }

  Finish(aStatus);
}

void InnerConnectionEstablisher::OnInnerHandshakeDone() {
  LOG(("InnerConnectionEstablisher::OnInnerHandshakeDone %p tunnelOpen=%d",
       this, mTunnelOpen));

  mInnerHandshakeDone = true;
  if (mTunnelOpen) {
    Finish(NS_OK);
  }
}

void InnerConnectionEstablisher::Finish(nsresult aResult, bool aSynchronous) {
  LOG(("InnerConnectionEstablisher::Finish %p result=%" PRIx32, this,
       static_cast<uint32_t>(aResult)));

  if (mFinished) {
    return;
  }
  mFinished = true;

  if (mTransaction) {
    // Keep the ref; the attempt still needs the captured response head.
    mTransaction->SetConnectedCallback(nullptr);
    mTransaction->SetProxyConnectCallback(nullptr);
  }
  if (RefPtr<HttpConnectionUDP> udpConn = do_QueryObject(mResultConn)) {
    udpConn->SetHandshakeDoneCallback(nullptr);
  }

  if (NS_FAILED(aResult)) {
    // Nobody is taking this one over. Leaving it open leaves a tunnel stream
    // firing its error condition, and leaving the handle set has
    // ~ConnectionHandle offer the closed connection back for reclaim.
    if (mResultConn) {
      mResultConn->Close(aResult);
      mResultConn = nullptr;
    }
    if (mHandle) {
      mHandle->Reset();
    }
  } else if (mHandle && mResultConn && !mResultConn->UsingSpdy() &&
             !mResultConn->UsingHttp3()) {
    // ~ConnectionHandle would reclaim it, closing an h1 inner connection out
    // from under the transaction we are handing it to.
    mHandle->Reset();
  }
  mHandle = nullptr;

  if (!mCallback) {
    return;
  }
  auto cb = std::move(mCallback);
  mCallback = nullptr;

  if (aSynchronous) {
    RefPtr<InnerConnectionEstablisher> self(this);
    if (NS_FAILED(aResult)) {
      cb(Err(aResult));
    } else {
      cb(RefPtr<HttpConnectionBase>{mResultConn});
    }
    return;
  }

  // Take the connection now: Close() clears mResultConn before this runs.
  NS_DispatchToCurrentThread(NS_NewRunnableFunction(
      "InnerConnectionEstablisher::Finish",
      [self = RefPtr{this}, aResult,
       conn = RefPtr<HttpConnectionBase>{mResultConn}, cb = std::move(cb)]() {
        if (self->mClosed) {
          return;
        }
        if (NS_FAILED(aResult)) {
          cb(Err(aResult));
          return;
        }
        cb(RefPtr<HttpConnectionBase>{conn});
      }));
}

void InnerConnectionEstablisher::Close(nsresult aReason) {
  LOG(("InnerConnectionEstablisher::Close %p reason=%" PRIx32, this,
       static_cast<uint32_t>(aReason)));

  if (mTransaction) {
    mTransaction->SetConnectedCallback(nullptr);
    mTransaction->SetProxyConnectCallback(nullptr);
  }

  // ~ConnectionHandle would offer the connection closed below back for
  // reclaim.
  if (mHandle) {
    mHandle->Reset();
    mHandle = nullptr;
  }

  if (mHandedOver) {
    // The real transaction runs on the connection now, and closing the driver
    // or the connection would end it.
    mResultConn = nullptr;
  } else {
    // A connection that still has the driver as its transaction keeps reading
    // into it after Close(), so let the connection close and drop it. This
    // also closes the connection, and with it the tunnel stream, so the proxy
    // drops its origin connection.
    if (mTransaction && mResultConn &&
        mResultConn->Transaction() == mTransaction) {
      mResultConn->CloseTransaction(mTransaction, aReason);
    } else if (mTransaction) {
      mTransaction->Close(aReason);
    }
    if (mResultConn) {
      mResultConn->Close(aReason);
      mResultConn = nullptr;
    }
  }

  mFinished = true;
  mClosed = true;
  mCallback = nullptr;
}

}  // namespace mozilla::net
