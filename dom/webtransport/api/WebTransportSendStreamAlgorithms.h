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
class AbortSignalImpl;

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

  // Runs the abort steps "create a WebTransportSendStream" step 7 adds to the
  // controller's signal: if a close() is still deferred, convert it into a
  // reset on the same ordered channel and reject [[PendingOperation]].
  void RunAbortSignalSteps(AbortSignalImpl* aSignal);

  // Issues the FIN that CloseCallbackImpl deferred, unless an abort already
  // preempted it.
  void IssueDeferredClose();

 protected:
  ~WebTransportSendStreamAlgorithms() override = default;

 private:
  nsCOMPtr<nsIGlobalObject> mGlobal;
  RefPtr<WebTransportSendStream> mStream;

  // True between CloseCallbackImpl() and the microtask that actually closes
  // the sender. While set, an abort can still preempt the FIN.
  bool mCloseSenderPending = false;

  // The sender to close once the deferral elapses, the stream whose queue an
  // abort has to go through, and the close() promise ([[PendingOperation]]) to
  // settle. Held directly because ReleaseObjects() can null mStream before
  // either the microtask or the abort steps run.
  RefPtr<mozilla::ipc::DataPipeSender> mDeferredCloseSender;
  RefPtr<WebTransportSendStream> mDeferredCloseStream;
  RefPtr<Promise> mDeferredClosePromise;
};

}  // namespace mozilla::dom

#endif  // mozilla_dom_WebTransportSendStreamAlgorithms_h
