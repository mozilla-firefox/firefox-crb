/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "WebTransportSessionBase.h"

#include "HttpLog.h"
#include "nsIWebTransport.h"

namespace mozilla::net {

NS_IMPL_ISUPPORTS(WebTransportSessionStatsWrapper, nsIWebTransportSessionStats)

NS_IMETHODIMP WebTransportSessionStatsWrapper::GetRawStats(
    mozilla::dom::WebTransportStatsData** aStats) {
  *aStats = &mStats;
  return NS_OK;
}

void WebTransportSessionBase::SetWebTransportSessionEventListener(
    WebTransportSessionEventListener* listener) {
  MutexAutoLock lock(mListenerLock);
  mListener = listener;
}

already_AddRefed<WebTransportSessionEventListener>
WebTransportSessionBase::GetListener() {
  MutexAutoLock lock(mListenerLock);
  return do_AddRef(mListener);
}

void WebTransportSessionBase::FlushIncomingDatagrams() {
  RefPtr<WebTransportSessionEventListener> baseListener = GetListener();
  if (!baseListener) {
    return;
  }

  if (nsCOMPtr<WebTransportSessionEventListenerInternal> listener =
          do_QueryInterface(baseListener)) {
    listener->OnDatagramsFlushInternal();
  }
}

void WebTransportSessionBase::NotifyOutgoingDatagramSpaceAvailable() {
  RefPtr<WebTransportSessionEventListener> baseListener = GetListener();
  if (!baseListener) {
    return;
  }

  if (nsCOMPtr<WebTransportSessionEventListenerInternal> listener =
          do_QueryInterface(baseListener)) {
    listener->OnOutgoingDatagramSpaceAvailableInternal();
  }
}

already_AddRefed<WebTransportSessionEventListener>
WebTransportSessionBase::TakeListener() {
  MutexAutoLock lock(mListenerLock);
  return mListener.forget();
}

void WebTransportSessionBase::ResolveAtomicWrite(uint64_t aStreamId,
                                                 uint32_t aAtomicWriteId,
                                                 nsresult aResult) {
  LOG(("WebTransportSessionBase::ResolveAtomicWrite streamId=%" PRIu64
       " atomicWriteId=%u result=0x%x",
       aStreamId, aAtomicWriteId, static_cast<uint32_t>(aResult)));
  if (RefPtr<WebTransportSessionEventListener> listener = GetListener()) {
    listener->OnAtomicWriteResult(aStreamId, aAtomicWriteId, aResult);
  } else {
    LOG(("  No listener"));
  }
}

void WebTransportSessionBase::NotifyStreamCloseComplete(uint64_t aStreamId) {
  RefPtr<WebTransportSessionEventListener> listener = GetListener();
  if (listener) {
    listener->OnStreamCloseComplete(aStreamId);
  }
}

}  // namespace mozilla::net
