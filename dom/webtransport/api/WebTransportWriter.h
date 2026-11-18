/* -*- Mode: C++; tab-width: 8; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* vim: set ts=8 sts=2 et sw=2 tw=80: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef DOM_WEBTRANSPORT_API_WEBTRANSPORTWRITER_H_
#define DOM_WEBTRANSPORT_API_WEBTRANSPORTWRITER_H_

#include "mozilla/dom/WritableStreamDefaultWriter.h"
#include "nsTArray.h"

namespace mozilla::dom {

class Promise;
class WebTransportSendStream;

class WebTransportWriter final : public WritableStreamDefaultWriter {
 public:
  NS_DECL_ISUPPORTS_INHERITED
  NS_DECL_CYCLE_COLLECTION_CLASS_INHERITED(WebTransportWriter,
                                           WritableStreamDefaultWriter)

  explicit WebTransportWriter(nsIGlobalObject* aGlobal,
                              WebTransportSendStream* aStream);

  JSObject* WrapObject(JSContext* aCx,
                       JS::Handle<JSObject*> aGivenProto) override;

  // WebIDL methods
  MOZ_CAN_RUN_SCRIPT already_AddRefed<Promise> AtomicWrite(
      JSContext* aCx, JS::Handle<JS::Value> aChunk, ErrorResult& aRv);
  void Commit();

 private:
  ~WebTransportWriter() override = default;

  RefPtr<WebTransportSendStream> mSendStream;
};

}  // namespace mozilla::dom

#endif  // DOM_WEBTRANSPORT_API_WEBTRANSPORTWRITER_H_
