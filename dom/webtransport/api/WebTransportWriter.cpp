/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* vim:set ts=2 sw=2 sts=2 et cindent: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "mozilla/dom/WebTransportWriter.h"

#include "js/ArrayBuffer.h"
#include "js/RootingAPI.h"
#include "js/TypeDecls.h"
#include "mozilla/dom/Promise.h"
#include "mozilla/dom/WebTransport.h"
#include "mozilla/dom/WebTransportSendStream.h"
#include "mozilla/dom/WebTransportWriterBinding.h"
#include "mozilla/dom/WritableStreamDefaultWriter.h"

namespace mozilla::dom {

NS_IMPL_CYCLE_COLLECTION_INHERITED(WebTransportWriter,
                                   WritableStreamDefaultWriter, mSendStream,
                                   mAtomicWriteRequests)
NS_IMPL_ADDREF_INHERITED(WebTransportWriter, WritableStreamDefaultWriter)
NS_IMPL_RELEASE_INHERITED(WebTransportWriter, WritableStreamDefaultWriter)
NS_INTERFACE_MAP_BEGIN_CYCLE_COLLECTION(WebTransportWriter)
NS_INTERFACE_MAP_END_INHERITING(WritableStreamDefaultWriter)

WebTransportWriter::WebTransportWriter(nsIGlobalObject* aGlobal,
                                       WebTransportSendStream* aStream)
    : WritableStreamDefaultWriter(aGlobal), mSendStream(aStream) {}

JSObject* WebTransportWriter::WrapObject(JSContext* aCx,
                                         JS::Handle<JSObject*> aGivenProto) {
  return WebTransportWriter_Binding::Wrap(aCx, this, aGivenProto);
}

already_AddRefed<Promise> WebTransportWriter::AtomicWrite(
    JSContext* aCx, JS::Handle<JS::Value> aChunk, ErrorResult& aRv) {
  RefPtr<Promise> promise = Promise::Create(GetParentObject(), aRv);
  if (aRv.Failed()) {
    return nullptr;
  }

  if (!mSendStream) {
    promise->MaybeRejectWithInvalidStateError("Stream not available");
    return promise.forget();
  }

  WebTransport* transport = mSendStream->GetTransport();
  if (!transport) {
    promise->MaybeRejectWithInvalidStateError("WebTransport not available");
    return promise.forget();
  }

  // For the initial implementation, just call the regular Write() method
  // A full implementation would:
  // 1. Get chunk size from aChunk
  // 2. Query flow control window via IPC
  // 3. Check if chunkSize fits in window
  // 4. Write atomically or reject with AbortError

  RefPtr<Promise> writePromise = Write(aCx, aChunk, aRv);
  if (aRv.Failed()) {
    return nullptr;
  }

  // Track this as an atomic write request
  mAtomicWriteRequests.AppendElement(writePromise);

  // For now, just return the write promise
  // The full implementation would wrap it to enforce atomicity
  return writePromise.forget();
}

void WebTransportWriter::Commit() {
  if (!mSendStream) {
    return;
  }

  mSendStream->SetCommittedOffset(0);
}

}  // namespace mozilla::dom
