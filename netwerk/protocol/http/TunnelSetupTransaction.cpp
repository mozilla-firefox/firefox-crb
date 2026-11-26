/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// HttpLog.h should generally be included first
#include "TunnelSetupTransaction.h"

#include "HttpLog.h"
#include "nsAHttpConnection.h"
#include "nsHttpConnection.h"
#include "nsHttpConnectionInfo.h"
#include "nsHttpHandler.h"
#include "nsHttpRequestHead.h"
#include "nsQueryObject.h"

namespace mozilla::net {

// Larger than this is a protocol error rather than something to buffer.
static const uint32_t kMaxResponseHeadSize = 32 * 1024;
static const uint32_t kReadChunkSize = 4096;

TunnelSetupTransaction::TunnelSetupTransaction(
    nsHttpConnectionInfo* aConnInfo, nsIInterfaceRequestor* aCallbacks,
    uint32_t aCaps, RequestHeaderSnapshot&& aHeaders)
    : SpeculativeTransaction(aConnInfo, aCallbacks, aCaps,
                             /* aCallback */ nullptr,
                             /* reportActivity */ false),
      mHeaders(std::move(aHeaders)) {
  LOG(("TunnelSetupTransaction ctor %p ci=%s", this,
       aConnInfo->HashKey().get()));
}

TunnelSetupTransaction::~TunnelSetupTransaction() {
  LOG(("TunnelSetupTransaction dtor %p", this));
}

// static
TunnelSetupTransaction::RequestHeaderSnapshot
TunnelSetupTransaction::SnapshotHeaders(nsAHttpTransaction* aTrans) {
  RequestHeaderSnapshot snapshot;
  if (!aTrans) {
    return snapshot;
  }
  const nsHttpRequestHead* head = aTrans->RequestHead();
  if (!head) {
    return snapshot;
  }

  // Everything else in the CONNECT comes from the connection info.
  nsAutoCString value;
  if (NS_SUCCEEDED(const_cast<nsHttpRequestHead*>(head)->GetHeader(
          nsHttp::Proxy_Authorization, value))) {
    snapshot.mProxyAuthorization = value;
  }
  if (NS_SUCCEEDED(const_cast<nsHttpRequestHead*>(head)->GetHeader(
          nsHttp::Upgrade, value))) {
    snapshot.mUpgrade = value;
  }
  return snapshot;
}

const nsHttpRequestHead* TunnelSetupTransaction::RequestHead() {
  // The base builds the head lazily; this call is the one that creates it, so
  // the snapshot goes in here.
  const bool created = !mRequestHead;
  const nsHttpRequestHead* head = NullHttpTransaction::RequestHead();
  if (!created || !head) {
    return head;
  }

  // NullHttpTransaction has no Proxy-Authorization to offer; we took one off
  // the real transaction.
  if (!mHeaders.mProxyAuthorization.IsEmpty()) {
    (void)mRequestHead->SetHeader(nsHttp::Proxy_Authorization,
                                  mHeaders.mProxyAuthorization);
  }
  if (!mHeaders.mUpgrade.IsEmpty()) {
    (void)mRequestHead->SetHeader(nsHttp::Upgrade, mHeaders.mUpgrade);
  }
  return mRequestHead;
}

// The error the connection captured when its inner TLS handshake failed (see
// nsHttpConnection::PostProcessNPNSetup), kept with the failed security info.
// A driver that reported a clean close instead would turn it into a generic
// failure.
nsresult TunnelSetupTransaction::HandshakeError() {
  if (RefPtr<nsAHttpConnection> handle = Connection()) {
    RefPtr<HttpConnectionBase> base = handle->HttpConnection();
    if (RefPtr<nsHttpConnection> conn = do_QueryObject(base)) {
      nsresult rv = conn->HandshakeError();
      if (NS_FAILED(rv) && !mFailedSecurityInfo) {
        nsCOMPtr<nsITLSSocketControl> tlsCtrl;
        conn->GetTLSSocketControl(getter_AddRefs(tlsCtrl));
        if (tlsCtrl) {
          tlsCtrl->GetSecurityInfo(getter_AddRefs(mFailedSecurityInfo));
        }
      }
      return rv;
    }
  }
  return NS_OK;
}

static nsresult ReadRequestSegment(nsIInputStream* aStream, void* aClosure,
                                   const char* aBuf, uint32_t aOffset,
                                   uint32_t aCount, uint32_t* aCountRead) {
  auto* reader = static_cast<nsAHttpSegmentReader*>(aClosure);
  return reader->OnReadSegment(aBuf, aCount, aCountRead);
}

nsresult TunnelSetupTransaction::ReadSegments(nsAHttpSegmentReader* aReader,
                                              uint32_t aCount,
                                              uint32_t* aCountRead) {
  if (nsresult rv = HandshakeError(); NS_FAILED(rv)) {
    *aCountRead = 0;
    return rv;
  }

  if (!mRequestStream) {
    return SpeculativeTransaction::ReadSegments(aReader, aCount, aCountRead);
  }

  nsresult rv = mRequestStream->ReadSegments(ReadRequestSegment, aReader,
                                             aCount, aCountRead);
  if (NS_FAILED(rv) && rv != NS_BASE_STREAM_WOULD_BLOCK) {
    return rv;
  }

  uint64_t available = 0;
  if (NS_FAILED(mRequestStream->Available(&available)) || !available) {
    mRequestDone = true;
  }
  return NS_OK;
}

nsresult TunnelSetupTransaction::ParseResponseHead(nsHttpResponseHead& aHead,
                                                   uint32_t aHeadLength) {
  nsDependentCSubstring block(mResponseBuffer, 0, aHeadLength);

  bool haveStatusLine = false;
  for (const nsACString& rawLine : block.Split('\n')) {
    nsDependentCSubstring line(rawLine);
    if (!line.IsEmpty() && line.Last() == '\r') {
      line.Rebind(line.BeginReading(), line.Length() - 1);
    }
    if (line.IsEmpty()) {
      continue;
    }

    if (!haveStatusLine) {
      // A head defaults to status 200, so an unparsable line must not pass
      // for an open tunnel.
      if (NS_FAILED(aHead.ParseStatusLine(line))) {
        return NS_ERROR_UNEXPECTED;
      }
      haveStatusLine = true;
      continue;
    }
    if (NS_FAILED(aHead.ParseHeaderLine(line))) {
      return NS_ERROR_UNEXPECTED;
    }
  }

  return haveStatusLine ? NS_OK : NS_ERROR_UNEXPECTED;
}

nsresult TunnelSetupTransaction::WriteSegments(nsAHttpSegmentWriter* aWriter,
                                               uint32_t aCount,
                                               uint32_t* aCountWritten) {
  *aCountWritten = 0;

  if (mHeadersDone) {
    // On success the inner connection owns the rest of the bytes; on failure
    // keep reading, the body is the real transaction's.
    if (!mProxyConnectFailed) {
      if (nsresult rv = HandshakeError(); NS_FAILED(rv)) {
        return rv;
      }
      LOG(
          ("TunnelSetupTransaction::WriteSegments %p CONNECT already accepted, "
           "returning NS_BASE_STREAM_CLOSED",
           this));
      return NS_BASE_STREAM_CLOSED;
    }
  }

  char buf[kReadChunkSize];
  uint32_t toRead = std::min(aCount, kReadChunkSize);
  uint32_t read = 0;
  nsresult rv = aWriter->OnWriteSegment(buf, toRead, &read);
  if (rv == NS_BASE_STREAM_WOULD_BLOCK) {
    // Nothing written: the connection re-arms the socket from the writer's
    // would-block condition, but not from this return value.
    return NS_OK;
  }
  if (NS_FAILED(rv)) {
    return rv;
  }
  if (!read) {
    return NS_BASE_STREAM_CLOSED;
  }
  *aCountWritten = read;

  if (mHeadersDone) {
    mResponseBodyPrefix.Append(buf, read);
    return NS_OK;
  }

  mResponseBuffer.Append(buf, read);
  if (mResponseBuffer.Length() > kMaxResponseHeadSize) {
    LOG(("TunnelSetupTransaction::WriteSegments %p oversized CONNECT response",
         this));
    return NS_ERROR_UNEXPECTED;
  }

  // Tolerate LFLF as nsHttpTransaction::ParseHead does.
  int32_t terminator = mResponseBuffer.Find("\r\n\r\n");
  uint32_t terminatorLength = 4;
  if (terminator == kNotFound) {
    terminator = mResponseBuffer.Find("\n\n");
    terminatorLength = 2;
  }
  if (terminator == kNotFound) {
    return NS_OK;  // wait for more
  }

  nsHttpResponseHead responseHead;
  rv = ParseResponseHead(responseHead, static_cast<uint32_t>(terminator));
  if (NS_FAILED(rv)) {
    LOG(("TunnelSetupTransaction::WriteSegments %p unparsable CONNECT response",
         this));
    return rv;
  }

  mHeadersDone = true;
  const uint32_t consumed = terminator + terminatorLength;
  if (consumed < mResponseBuffer.Length()) {
    nsDependentCSubstring rest(mResponseBuffer, consumed);
    if (responseHead.Status() == 200) {
      // Everything tunnelled here has the client speak first, TLS and HTTP
      // alike, so bytes behind a 200 are a protocol error. There is no way to
      // hand them to the tunnel's next reader, so fail rather than lose them.
      LOG(
          ("TunnelSetupTransaction::WriteSegments %p %zu unexpected bytes "
           "behind an accepted CONNECT",
           this, rest.Length()));
      return NS_ERROR_UNEXPECTED;
    }
    mResponseBodyPrefix = rest;
  }
  mResponseBuffer.Truncate();

  LOG(
      ("TunnelSetupTransaction::WriteSegments %p CONNECT response status=%u "
       "bodyPrefix=%zu",
       this, responseHead.Status(), mResponseBodyPrefix.Length()));

  // Hand it over as nsHttpTransaction would: HandleTunnelResponse calls back
  // into OnProxyConnectComplete / SetProxyConnectFailed.
  if (RefPtr<nsAHttpConnection> conn = Connection()) {
    (void)RequestHead();
    bool reset = false;
    rv = conn->OnHeadersAvailable(this, mRequestHead, &responseHead, &reset);
    if (NS_FAILED(rv)) {
      return rv;
    }
  }

  return NS_OK;
}

void TunnelSetupTransaction::OnProxyConnectComplete(
    ProxyConnectResponseHead* aHead) {
  MOZ_ASSERT(aHead);
  mProxyConnectResponseHead = aHead;

  const uint16_t status = aHead->Head().Status();
  LOG(("TunnelSetupTransaction::OnProxyConnectComplete %p status=%u", this,
       status));

  if (ProxyConnectCallback callback = std::move(mProxyConnectCallback)) {
    callback(status);
  }
}

}  // namespace mozilla::net
