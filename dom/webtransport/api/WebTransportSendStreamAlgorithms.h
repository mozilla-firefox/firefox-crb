/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* vim:set ts=2 sw=2 sts=2 et cindent: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef mozilla_dom_WebTransportSendStreamAlgorithms_h
#define mozilla_dom_WebTransportSendStreamAlgorithms_h

#include "mozilla/dom/UnderlyingSinkCallbackHelpers.h"
#include "mozilla/ipc/DataPipe.h"

namespace mozilla::dom {

class WebTransportSendStream;

// Custom underlying sink for WebTransportSendStream that frames
// all writes before sending them to the DataPipe
class WebTransportSendStreamAlgorithms final
    : public UnderlyingSinkAlgorithmsWrapper {
 public:
  NS_DECL_ISUPPORTS_INHERITED
  NS_DECL_CYCLE_COLLECTION_CLASS_INHERITED(WebTransportSendStreamAlgorithms,
                                           UnderlyingSinkAlgorithmsWrapper)

  WebTransportSendStreamAlgorithms(nsIGlobalObject* aGlobal,
                                   WebTransportSendStream* aStream);

  // UnderlyingSinkAlgorithmsWrapper virtual implementation
  already_AddRefed<Promise> WriteCallbackImpl(
      JSContext* aCx, JS::Handle<JS::Value> aChunk,
      WritableStreamDefaultController& aController, ErrorResult& aRv) override;

  already_AddRefed<Promise> CloseCallbackImpl(JSContext* aCx,
                                              ErrorResult& aRv) override;

  already_AddRefed<Promise> AbortCallbackImpl(
      JSContext* aCx, const Optional<JS::Handle<JS::Value>>& aReason,
      ErrorResult& aRv) override;

  // Drops mStream once the stream is closed or errored, which is what makes
  // WriteCallbackImpl()'s null check reachable at all.
  void ReleaseObjects() override;

 protected:
  ~WebTransportSendStreamAlgorithms() override = default;

 private:
  // Helper for Close/Abort callbacks - takes a callable for the close operation
  template <typename CloseOp>
  already_AddRefed<Promise> CloseSenderHelper(CloseOp aCloseOp,
                                              const char* aLogPrefix = nullptr);

  nsCOMPtr<nsIGlobalObject> mGlobal;
  RefPtr<WebTransportSendStream> mStream;
};

}  // namespace mozilla::dom

#endif  // mozilla_dom_WebTransportSendStreamAlgorithms_h
