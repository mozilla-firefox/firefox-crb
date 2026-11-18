/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "Http3WebTransportStream.h"

#include <limits>

#include "Http3Session.h"
#include "Http3WebTransportSession.h"
#include "HttpLog.h"
#include "mozilla/TimeStamp.h"
#include "mozilla/dom/WebTransportFraming.h"
#include "nsHttpHandler.h"
#include "nsIOService.h"
#include "nsIPipe.h"
#include "nsIWebTransportStream.h"
#include "nsSocketTransportService2.h"

namespace mozilla::net {

namespace {

// Bytes neqo has refused that are held in mPendingRegularFrameData before
// ReadSegments() stops reading the send pipe.
constexpr size_t kMaxPendingRegularFrameDataBytes = 512 * 1024;

// This is an nsAHttpTransaction that does nothing.
class DummyWebTransportStreamTransaction : public nsAHttpTransaction {
 public:
  NS_DECL_THREADSAFE_ISUPPORTS

  DummyWebTransportStreamTransaction() = default;

  void SetConnection(nsAHttpConnection*) override {}
  nsAHttpConnection* Connection() override { return nullptr; }
  void GetSecurityCallbacks(nsIInterfaceRequestor**) override {}
  void OnTransportStatus(nsITransport* transport, nsresult status,
                         int64_t progress) override {}
  bool IsDone() override { return false; }
  nsresult Status() override { return NS_OK; }
  uint32_t Caps() override { return 0; }
  [[nodiscard]] nsresult ReadSegments(nsAHttpSegmentReader*, uint32_t,
                                      uint32_t*) override {
    return NS_OK;
  }
  [[nodiscard]] nsresult WriteSegments(nsAHttpSegmentWriter*, uint32_t,
                                       uint32_t*) override {
    return NS_OK;
  }
  void Close(nsresult reason) override {}
  nsHttpConnectionInfo* ConnectionInfo() override { return nullptr; }
  void SetProxyConnectFailed() override {}
  const nsHttpRequestHead* RequestHead() override { return nullptr; }
  uint32_t Http1xTransactionCount() override { return 0; }
  [[nodiscard]] nsresult TakeSubTransactions(
      nsTArray<RefPtr<nsAHttpTransaction>>& outTransactions) override {
    return NS_OK;
  }

 private:
  virtual ~DummyWebTransportStreamTransaction() = default;
};

NS_IMPL_ISUPPORTS(DummyWebTransportStreamTransaction, nsISupportsWeakReference)

class WebTransportSendStreamStats : public nsIWebTransportSendStreamStats {
 public:
  NS_DECL_THREADSAFE_ISUPPORTS

  explicit WebTransportSendStreamStats(uint64_t aSent, uint64_t aAcked)
      : mTimeStamp(TimeStamp::Now()),
        mTotalSent(aSent),
        mTotalAcknowledged(aAcked) {}

  NS_IMETHOD GetTimestamp(mozilla::TimeStamp* aTimestamp) override {
    *aTimestamp = mTimeStamp;
    return NS_OK;
  }
  NS_IMETHOD GetBytesSent(uint64_t* aBytesSent) override {
    *aBytesSent = mTotalSent;
    return NS_OK;
  }
  NS_IMETHOD GetBytesAcknowledged(uint64_t* aBytesAcknowledged) override {
    *aBytesAcknowledged = mTotalAcknowledged;
    return NS_OK;
  }

 private:
  virtual ~WebTransportSendStreamStats() = default;

  TimeStamp mTimeStamp;
  uint64_t mTotalSent;
  uint64_t mTotalAcknowledged;
};

NS_IMPL_ISUPPORTS(WebTransportSendStreamStats, nsIWebTransportSendStreamStats)

class WebTransportReceiveStreamStats
    : public nsIWebTransportReceiveStreamStats {
 public:
  NS_DECL_THREADSAFE_ISUPPORTS

  explicit WebTransportReceiveStreamStats(uint64_t aReceived)
      : mTimeStamp(TimeStamp::Now()), mTotalReceived(aReceived) {}

  NS_IMETHOD GetTimestamp(mozilla::TimeStamp* aTimestamp) override {
    *aTimestamp = mTimeStamp;
    return NS_OK;
  }
  NS_IMETHOD GetBytesReceived(uint64_t* aByteReceived) override {
    *aByteReceived = mTotalReceived;
    return NS_OK;
  }

 private:
  virtual ~WebTransportReceiveStreamStats() = default;

  TimeStamp mTimeStamp;
  uint64_t mTotalReceived;
};

NS_IMPL_ISUPPORTS(WebTransportReceiveStreamStats,
                  nsIWebTransportReceiveStreamStats)

}  // namespace

NS_IMPL_ISUPPORTS(Http3WebTransportStream, nsIInputStreamCallback,
                  nsIOutputStreamCallback)

Http3WebTransportStream::Http3WebTransportStream(
    Http3SessionBase* aSession, uint64_t aSessionId,
    WebTransportStreamType aType,
    std::function<void(Result<RefPtr<WebTransportStreamBase>, nsresult>&&)>&&
        aCallback,
    bool aWaitUntilAvailable)
    : WebTransportStreamBase(aSessionId, std::move(aCallback)),
      Http3StreamBase(new DummyWebTransportStreamTransaction(), aSession),
      mWaitUntilAvailable(aWaitUntilAvailable) {
  LOG(("Http3WebTransportStream outgoing ctor %p waitUntilAvailable=%d", this,
       aWaitUntilAvailable));
  mStreamRole = OUTGOING;
  mStreamType = aType;
}

Http3WebTransportStream::Http3WebTransportStream(Http3SessionBase* aSession,
                                                 uint64_t aSessionId,
                                                 WebTransportStreamType aType,
                                                 uint64_t aStreamId)
    : WebTransportStreamBase(aSessionId, nullptr),
      Http3StreamBase(new DummyWebTransportStreamTransaction(), aSession) {
  LOG(("Http3WebTransportStream incoming ctor %p", this));
  mStreamId = aStreamId;
  mStreamRole = INCOMING;
  mStreamType = aType;
  // WAITING_DATA indicates we are waiting
  // Http3WebTransportStream::OnInputStreamReady to be called.
  mSendState = WAITING_DATA;
}

Http3WebTransportStream::~Http3WebTransportStream() {
  LOG(("Http3WebTransportStream dtor %p", this));
}

StreamId Http3WebTransportStream::WebTransportStreamId() const {
  return StreamId::From(Http3StreamBase::StreamId());
}

uint64_t Http3WebTransportStream::GetStreamId() const {
  return Http3StreamBase::StreamId();
}

nsresult Http3WebTransportStream::TryActivating() {
  MOZ_ASSERT(OnSocketThread(), "not on socket thread");
  return mSession->TryActivatingWebTransportStream(&mStreamId, this);
}

NS_IMETHODIMP Http3WebTransportStream::OnInputStreamReady(
    nsIAsyncInputStream* aStream) {
  LOG(
      ("Http3WebTransportStream::OnInputStreamReady [this=%p stream=%p "
       "streamId=%llu state=%d]",
       this, aStream, (unsigned long long)mStreamId, mSendState));

  // Check if stream is closed
  uint64_t available = 0;
  nsresult rv = aStream->Available(&available);
  LOG(("  streamId=%llu Available check: rv=0x%x available=%llu",
       (unsigned long long)mStreamId, static_cast<uint32_t>(rv),
       static_cast<unsigned long long>(available)));

  if (mSendState == SEND_DONE) {
    // already closed
    LOG(
        ("Http3WebTransportStream::OnInputStreamReady streamId=%llu already "
         "closed",
         (unsigned long long)mStreamId));
    return NS_OK;
  }

  // DataPipe workaround: Available() returns NS_BASE_STREAM_WOULD_BLOCK when
  // sender is closed, but ReadSegments() doesn't return NS_BASE_STREAM_CLOSED.
  // Detect closure here instead.
  if ((rv == NS_BASE_STREAM_WOULD_BLOCK || rv == NS_BASE_STREAM_CLOSED) &&
      available == 0) {
    LOG(
        ("Stream closure detected via Available() - check for incomplete "
         "frames"));

    // Check if there's incomplete framed data
    if (!mPartialFrameBuffer.IsEmpty()) {
      LOG(("Stream closed with %zu bytes of incomplete frame",
           mPartialFrameBuffer.Length()));
      mSendState = SEND_DONE;
      Reset(0x1);
      return NS_OK;
    }

    // Check if there's pending Regular frame data that needs to be sent
    if (!mPendingRegularFrameData.IsEmpty()) {
      LOG(
          ("*** STREAM CLOSE in OnInputStreamReady - DEFERRING CLOSE - %zu "
           "bytes pending",
           mPendingRegularFrameData.Length()));
      mDeferredClose = true;
      // Notify session we have data to write
      mSession->StreamHasDataToWrite(this);
      return NS_OK;
    }

    // Clean close - send FIN
    mSendState = SEND_DONE;
    SendFin();
    return NS_OK;
  }

  mSendState = SENDING;
  mSession->StreamHasDataToWrite(this);
  return NS_OK;
}

NS_IMETHODIMP
Http3WebTransportStream::OnOutputStreamReady(nsIAsyncOutputStream* aOutStream) {
  MOZ_ASSERT(OnSocketThread(), "not on socket thread");
  if (!mSession) {
    return NS_OK;
  }

  mSession->ConnectSlowConsumer(this);
  return NS_OK;
}

already_AddRefed<nsIWebTransportSendStreamStats>
Http3WebTransportStream::GetSendStreamStats() {
  MOZ_ASSERT(OnSocketThread(), "not on socket thread");

  nsCOMPtr<nsIWebTransportSendStreamStats> stats =
      new WebTransportSendStreamStats(mTotalSent, mTotalAcknowledged);
  return stats.forget();
}

already_AddRefed<nsIWebTransportReceiveStreamStats>
Http3WebTransportStream::GetReceiveStreamStats() {
  MOZ_ASSERT(OnSocketThread(), "not on socket thread");

  nsCOMPtr<nsIWebTransportReceiveStreamStats> stats =
      new WebTransportReceiveStreamStats(mTotalReceived);
  return stats.forget();
}

nsresult Http3WebTransportStream::OnReadSegment(const char* buf, uint32_t count,
                                                uint32_t* countRead) {
  MOZ_ASSERT(OnSocketThread(), "not on socket thread");

  LOG(("Http3WebTransportStream::OnReadSegment count=%u state=%d [this=%p]",
       count, mSendState, this));

  nsresult rv = NS_OK;

  switch (mSendState) {
    case WAITING_TO_ACTIVATE: {
      rv = TryActivating();
      if (rv == NS_BASE_STREAM_WOULD_BLOCK) {
        // If waitUntilAvailable is false, treat quota exhaustion as an error
        if (!mWaitUntilAvailable) {
          LOG(
              ("Http3WebTransportStream::OnReadSegment %p cannot activate, "
               "quota exhausted, waitUntilAvailable=false.\n",
               this));
          mSendState = SEND_DONE;
          mStreamReadyCallback(Err(rv));
          mStreamReadyCallback = nullptr;
          break;
        }
        LOG(
            ("Http3WebTransportStream::OnReadSegment %p cannot activate now. "
             "queued.\n",
             this));
        break;
      }
      if (NS_FAILED(rv)) {
        LOG3(
            ("Http3WebTransportStream::OnReadSegment %p cannot activate "
             "error=0x%" PRIx32 ".",
             this, static_cast<uint32_t>(rv)));
        mStreamReadyCallback(Err(rv));
        mStreamReadyCallback = nullptr;
        break;
      }

      rv = InitOutputPipe();
      if (NS_SUCCEEDED(rv)) {
        mSendState = WAITING_DATA;
        if (mStreamType == WebTransportStreamType::BiDi) {
          rv = InitInputPipe();
          if (NS_SUCCEEDED(rv)) {
            mRecvState = READING;
          }
        }
      }
      if (NS_FAILED(rv)) {
        LOG3(
            ("Http3WebTransportStream::OnReadSegment %p failed to create pipe "
             "error=0x%" PRIx32 ".",
             this, static_cast<uint32_t>(rv)));
        mSendState = SEND_DONE;
        mStreamReadyCallback(Err(rv));
        mStreamReadyCallback = nullptr;
        break;
      }

      // Successfully activated.
      RefPtr<WebTransportStreamBase> stream = this;
      mStreamReadyCallback(stream);
      mStreamReadyCallback = nullptr;
    } break;
    case SENDING: {
      rv = mSession->SendRequestBody(mStreamId, buf, count, countRead);
      LOG(
          ("Http3WebTransportStream::OnReadSegment %p sending body returns "
           "error=0x%" PRIx32 ".",
           this, static_cast<uint32_t>(rv)));
      mTotalSent += *countRead;
    } break;
    case WAITING_DATA:
      // Still waiting
      break;
    case SEND_DONE:
      LOG3(("Http3WebTransportStream::OnReadSegment %p called after SEND_DONE ",
            this));
      MOZ_ASSERT(false, "We are done sending this request!");
      MOZ_ASSERT(mStreamReadyCallback);
      rv = NS_ERROR_UNEXPECTED;
      mStreamReadyCallback(Err(rv));
      mStreamReadyCallback = nullptr;
      break;
  }

  mSocketOutCondition = rv;

  return mSocketOutCondition;
}

// Helper struct for ReadSegments callback
struct ReadSegmentContext {
  uint8_t* buffer;
  uint32_t bufferSize;
  uint32_t bytesWritten;
};

// static
nsresult Http3WebTransportStream::ReadRequestSegment(
    nsIInputStream* stream, void* closure, const char* buf, uint32_t offset,
    uint32_t count, uint32_t* countRead) {
  ReadSegmentContext* ctx = (ReadSegmentContext*)closure;

  // Copy as much as fits in the buffer
  uint32_t toCopy = std::min(count, ctx->bufferSize - ctx->bytesWritten);

  LOG(("ReadRequestSegment: offset=%u count=%u ctx->bytesWritten=%u toCopy=%u",
       offset, count, ctx->bytesWritten, toCopy));

  if (toCopy > 0) {
    memcpy(ctx->buffer + ctx->bytesWritten, buf, toCopy);
    ctx->bytesWritten += toCopy;
  }

  *countRead = toCopy;
  return NS_OK;
}

bool Http3WebTransportStream::TrySendAtomicPayload(
    nsTArray<uint8_t>&& aPayload) {
  MOZ_ASSERT(OnSocketThread(), "not on socket thread");
  if (aPayload.IsEmpty()) {
    // Zero-length atomic writes carry no QUIC stream data and consume no
    // flow-control credit; skip calling WebTransportSendStreamAtomic: neqo's
    // send_data_atomic fails when the stream header hasn't been sent yet
    // (state != SendingData), which can happen on a fresh stream with no
    // prior data. There is nothing to send atomically, so we trivially
    // succeed.
    return true;
  }

  // No separate flow-control pre-check: neqo's stream-level avail() already
  // nets out both connection- and stream-level credit already consumed by
  // buffered data, and QUIC STREAM frame header bytes are never charged
  // against flow control (that's a per-packet concern neqo's own packet
  // builder handles, unrelated to this credit). WebTransportSendStreamAtomic
  // is the only source of truth for whether the write fits.
  bool sendSuccess =
      mSession->WebTransportSendStreamAtomic(mStreamId, std::move(aPayload));
  LOG(("Atomic write %s", sendSuccess ? "succeeded" : "failed"));
  return sendSuccess;
}

void Http3WebTransportStream::ResolveAtomicWrite(uint32_t aAtomicWriteId,
                                                 bool aSuccess) {
  MOZ_ASSERT(OnSocketThread(), "not on socket thread");
  Http3Session* http3Session = static_cast<Http3Session*>(mSession.get());
  RefPtr<Http3WebTransportSession> wtSession;
  for (const auto& stream : http3Session->WebTransportSessions()) {
    if (stream->StreamId() == mSessionId) {
      wtSession = stream->GetHttp3WebTransportSession();
      break;
    }
  }
  if (wtSession) {
    wtSession->ResolveAtomicWrite(mStreamId, aAtomicWriteId,
                                  aSuccess ? NS_OK : NS_ERROR_ABORT);
  }
}

void Http3WebTransportStream::NotifyCloseComplete() {
  Http3Session* http3Session = static_cast<Http3Session*>(mSession.get());
  RefPtr<Http3WebTransportSession> wtSession;
  for (const auto& stream : http3Session->WebTransportSessions()) {
    if (stream->StreamId() == mSessionId) {
      wtSession = stream->GetHttp3WebTransportSession();
      break;
    }
  }
  if (wtSession) {
    wtSession->NotifyStreamCloseComplete(mStreamId);
  }
}

void Http3WebTransportStream::TryDrainPendingAtomicWrites() {
  MOZ_ASSERT(OnSocketThread(), "not on socket thread");
  while (!mPendingAtomicWrites.IsEmpty() &&
         mPendingRegularFrameData.IsEmpty()) {
    PendingAtomicWrite item = std::move(mPendingAtomicWrites[0]);
    mPendingAtomicWrites.RemoveElementAt(0);
    LOG(("Retrying deferred atomic write id=%u", item.mAtomicWriteId));
    bool sendSuccess = TrySendAtomicPayload(std::move(item.mPayload));
    ResolveAtomicWrite(item.mAtomicWriteId, sendSuccess);
    if (!sendSuccess) {
      // Spec: "If the atomic write is rejected, everything queued behind
      // it at that moment will be rejected as well."
      FailPendingAtomicWrites();
      break;
    }
  }
}

void Http3WebTransportStream::FailPendingAtomicWrites() {
  MOZ_ASSERT(OnSocketThread(), "not on socket thread");
  nsTArray<PendingAtomicWrite> pending = std::move(mPendingAtomicWrites);
  for (auto& item : pending) {
    LOG(("Failing deferred atomic write id=%u due to stream reset/close",
         item.mAtomicWriteId));
    ResolveAtomicWrite(item.mAtomicWriteId, false);
  }
}

nsresult Http3WebTransportStream::ReadSegments() {
  MOZ_ASSERT(OnSocketThread(), "not on socket thread");
  LOG(("Http3WebTransportStream::ReadSegments streamId=%llu [this=%p state=%d]",
       (unsigned long long)mStreamId, this, mSendState));
  nsresult rv = NS_OK;
  bool again = true;

  // Handle activation - WebTransportStreams start in WAITING_TO_ACTIVATE
  if (mSendState == WAITING_TO_ACTIVATE) {
    LOG(("Http3WebTransportStream %p ReadSegments forcing OnReadSegment call",
         this));
    uint32_t wasted = 0;
    nsresult rv2 = OnReadSegment("", 0, &wasted);
    LOG(("  OnReadSegment returned 0x%08" PRIx32, static_cast<uint32_t>(rv2)));
    if (mSendState != WAITING_DATA && mSendState != SENDING) {
      return NS_OK;
    }
  }

  if (mSendState == SEND_DONE) {
    return NS_OK;
  }

  // Skip processing for incoming unidirectional streams
  if (mStreamRole == INCOMING && mStreamType == WebTransportStreamType::UniDi) {
    return NS_OK;
  }

  if (mSendState == WAITING_DATA) {
    mSendState = SENDING;
  }

  // Always try to send any pending data first, before processing new frames
  if (!mPendingRegularFrameData.IsEmpty()) {
    uint32_t written = 0;
    nsresult pendingRv = OnReadSegment(
        reinterpret_cast<const char*>(mPendingRegularFrameData.Elements()),
        mPendingRegularFrameData.Length(), &written);
    if (written != 0 && written < mPendingRegularFrameData.Length()) {
      LOG(("Retry at start - sent %u of %zu bytes, rv=0x%x", written,
           mPendingRegularFrameData.Length(),
           static_cast<uint32_t>(pendingRv)));
    }
    if (written > 0) {
      mPendingRegularFrameData.RemoveElementsAt(0, written);

      // Same order as the frame handler below: settle parked atomic writes
      // before a deferred close can FIN over them.
      TryDrainPendingAtomicWrites();

      // Check if we can now complete a deferred close
      if (mDeferredClose && mPendingRegularFrameData.IsEmpty()) {
        LOG(("All pending data sent - completing deferred close"));
        mSendState = SEND_DONE;
        if (!mPendingTasks.IsEmpty()) {
          nsTArray<std::function<void()>> tasks = std::move(mPendingTasks);
          for (const auto& task : tasks) {
            task();
          }
        }
        SendFin();
        return NS_OK;
      }
    }
  }
  TryDrainPendingAtomicWrites();

  // gDefaultSegmentSize is a runtime value, so this cannot be an array.
  nsTArray<uint8_t> tempBuf;
  tempBuf.SetLength(nsIOService::gDefaultSegmentSize);

  do {
    // neqo is not taking the data.  Leave the rest in the pipe, so the content
    // process's writes back up instead of growing this buffer, and carry on
    // when DataWritable calls ReadSegments() again.
    if (mPendingRegularFrameData.Length() >= kMaxPendingRegularFrameDataBytes) {
      LOG(("ReadSegments streamId=%llu: %zu bytes pending, not reading",
           (unsigned long long)mStreamId, mPendingRegularFrameData.Length()));
      rv = NS_OK;
      break;
    }

    // Read data from pipe into our frame buffer
    ReadSegmentContext ctx = {tempBuf.Elements(),
                              static_cast<uint32_t>(tempBuf.Length()), 0};

    // Track what ReadSegments returns separately from ctx.bytesWritten
    uint32_t readSegmentsResult = 0;
    rv = mSendStreamPipeIn->ReadSegments(ReadRequestSegment, &ctx,
                                         tempBuf.Length(), &readSegmentsResult);

    bool streamClosed = (rv == NS_BASE_STREAM_CLOSED);

    LOG(("ReadSegments: rv=0x%" PRIx32
         " ctx.bytesWritten=%u readSegmentsResult=%u",
         static_cast<uint32_t>(rv), ctx.bytesWritten, readSegmentsResult));

    // Verify consistency between callback and ReadSegments return
    if (ctx.bytesWritten != readSegmentsResult) {
      LOG(("WARNING: Mismatch! ctx.bytesWritten=%u != readSegmentsResult=%u",
           ctx.bytesWritten, readSegmentsResult));
    }

    if (streamClosed || !mPendingTasks.IsEmpty()) {
      rv = NS_OK;
      readSegmentsResult = 0;
    }

    LOG(("Http3WebTransportStream::ReadSegments rv=0x%" PRIx32
         " read=%u streamClosed=%d [this=%p]",
         static_cast<uint32_t>(rv), readSegmentsResult, streamClosed, this));

    // Append newly read data to our partial frame buffer
    // Use readSegmentsResult (the authoritative value from ReadSegments)
    if (readSegmentsResult > 0) {
      // Log first few bytes being appended for debugging
      nsAutoCString hexDump;
      for (uint32_t i = 0; i < std::min(readSegmentsResult, uint32_t(16));
           i++) {
        hexDump.AppendPrintf("%02x ", tempBuf[i]);
      }
      LOG(("Appending %u bytes to frame buffer: %s%s", readSegmentsResult,
           hexDump.get(), readSegmentsResult > 16 ? "..." : ""));

      mPartialFrameBuffer.AppendElements(tempBuf.Elements(),
                                         readSegmentsResult);
      LOG(("Frame buffer now has %zu bytes", mPartialFrameBuffer.Length()));
    }

    // Process complete frames from the buffer
    while (true) {
      dom::WebTransportFrameType frameType;
      uint32_t atomicWriteId;
      size_t payloadLength;
      nsTArray<uint8_t> payload;  // Fresh payload for each frame

      // XXX This means we need to receive and buffer the entire write
      // before passing any of it down to the lower level.  Better would be
      // to parse the header, then start forwarding data as received until
      // the entire entry has been received, then look for a new framing
      // header.
      auto parseResult =
          ParseWebTransportFrameHeader(mPartialFrameBuffer, frameType,
                                       atomicWriteId, payload, payloadLength);
      if (parseResult == dom::WebTransportFrameParseResult::NeedMoreData) {
        break;  // No more complete frames yet
      }
      if (parseResult == dom::WebTransportFrameParseResult::Malformed) {
        LOG(
            ("Http3WebTransportStream::ReadSegments streamId=%llu [this=%p] "
             "malformed frame from content process (first byte 0x%02x), "
             "resetting",
             (unsigned long long)mStreamId, this, mPartialFrameBuffer[0]));
        // SEND_DONE must be set before Reset(): from SENDING, Reset() only
        // queues the reset into mPendingTasks, which is drained below the
        // SEND_DONE guard at the top of this function and so would never run.
        mSendState = SEND_DONE;
        Reset(0x1);  // QUIC application error code
        return NS_ERROR_ABORT;
      }
      LOG(("Frame header: type=0x%02x len=%zu", frameType, payloadLength));
      uint32_t totalFrameSize = 5 + payloadLength;  // regardless of type

      // Remove frame from buffer BEFORE processing to avoid buffer corruption
      // on early return
      // XXX Could be better for performance - avoid copying data
      mPartialFrameBuffer.RemoveElementsAt(0, totalFrameSize);

      // Now process the frame (safe to return early from here)
      switch (frameType) {
        case dom::WebTransportFrameType::Regular: {
          // Regular write - send to neqo
          LOG(("Processing regular frame: %zu bytes (pending: %zu)",
               payloadLength, mPendingRegularFrameData.Length()));

          // First, try to send any pending data from previous frames
          if (!mPendingRegularFrameData.IsEmpty()) {
            LOG(("Regular frame handler - retrying %zu pending bytes first",
                 mPendingRegularFrameData.Length()));
            uint32_t pendingWritten = 0;
            nsresult pendingRv = OnReadSegment(
                reinterpret_cast<const char*>(
                    mPendingRegularFrameData.Elements()),
                mPendingRegularFrameData.Length(), &pendingWritten);
            if (NS_FAILED(pendingRv)) {
              LOG(("Failed OnReadSegment for regular frame: 0x%x",
                   static_cast<uint32_t>(pendingRv)));
            }
            if (pendingWritten > 0) {
              mPendingRegularFrameData.RemoveElementsAt(0, pendingWritten);
              LOG(("After retry - %zu bytes still pending",
                   mPendingRegularFrameData.Length()));
            }
          }

          // Now try to send the new frame data
          uint32_t written = 0;
          nsresult sendRv =
              OnReadSegment(reinterpret_cast<const char*>(payload.Elements()),
                            payload.Length(), &written);

          // If not all data was sent, buffer the remainder for retry
          if (written < payload.Length()) {
            size_t unsent = payload.Length() - written;
            LOG(("Buffering %zu unsent bytes (total pending will be %zu)",
                 unsent, mPendingRegularFrameData.Length() + unsent));
            mPendingRegularFrameData.AppendElements(
                &payload.Elements()[written], unsent);
            // Notify session we have more data to send
            mSession->StreamHasDataToWrite(this);
          }

          if (NS_FAILED(sendRv)) {
            LOG(("Failed to send regular frame: 0x%x",
                 static_cast<uint32_t>(sendRv)));
          }

          TryDrainPendingAtomicWrites();

          // Check if we can now complete a deferred close
          if (mDeferredClose && mPendingRegularFrameData.IsEmpty()) {
            LOG(
                ("Deferred close check in frame handler - all sent, completing "
                 "close"));
            mSendState = SEND_DONE;
            if (!mPendingTasks.IsEmpty()) {
              LOG(("Executing %zu pending tasks before SendFin",
                   mPendingTasks.Length()));
              nsTArray<std::function<void()>> tasks = std::move(mPendingTasks);
              for (const auto& task : tasks) {
                task();
              }
            }
            SendFin();
            return NS_OK;
          } else if (mDeferredClose && mPendingRegularFrameData.Length() != 0) {
            LOG(("Deferred close check - still have %zu bytes pending",
                 mPendingRegularFrameData.Length()));
          }
        } break;

        case dom::WebTransportFrameType::Atomic: {
          // Atomic write frame format: 0x01 | totalPayloadLength(4) |
          // atomicWriteId(4) | data The payload contains: atomicWriteId(4)
          // + data dataLength = totalPayloadLength - 4 -- already removed above

          LOG(("Processing atomic write: atomicWriteId=%u, payloadLength=%zu",
               atomicWriteId, payloadLength));

          // Ensure any pending regular data that precedes this atomic write
          // in DataPipe order has been delivered to neqo before attempting
          // the atomic send.  Regular and atomic frames are written to the
          // DataPipe in JavaScript call order; bypassing un-delivered regular
          // bytes would reorder data on the QUIC stream.
          if (!mPendingRegularFrameData.IsEmpty()) {
            LOG(("Atomic write id=%u: draining %zu pending regular bytes first",
                 atomicWriteId, mPendingRegularFrameData.Length()));
            uint32_t pendingWritten = 0;
            (void)OnReadSegment(reinterpret_cast<const char*>(
                                    mPendingRegularFrameData.Elements()),
                                mPendingRegularFrameData.Length(),
                                &pendingWritten);
            if (pendingWritten > 0) {
              mPendingRegularFrameData.RemoveElementsAt(0, pendingWritten);
            }
          }

          // If regular data is still blocked (flow-control or send-buffer
          // full is a routine, frequent condition, not a corner case), or an
          // earlier atomic write is already waiting on it, defer this one
          // instead of failing it outright: its bytes and ID are queued and
          // retried by TryDrainPendingAtomicWrites() once
          // mPendingRegularFrameData empties out, preserving both ordering
          // and the data itself instead of discarding it.
          if (!mPendingRegularFrameData.IsEmpty() ||
              !mPendingAtomicWrites.IsEmpty()) {
            LOG(
                ("Atomic write id=%u deferred: %zu bytes of regular data "
                 "still pending, cannot reorder",
                 atomicWriteId, mPendingRegularFrameData.Length()));
            mPendingAtomicWrites.AppendElement(
                PendingAtomicWrite{atomicWriteId, std::move(payload)});
          } else {
            bool sendSuccess = TrySendAtomicPayload(std::move(payload));
            ResolveAtomicWrite(atomicWriteId, sendSuccess);
          }
        } break;
      }
    }

    // Handle errors and stream state
    if (NS_FAILED(rv)) {
      if (rv == NS_BASE_STREAM_WOULD_BLOCK) {
        mSendState = WAITING_DATA;
        rv = mSendStreamPipeIn->AsyncWait(this, 0, 0, gSocketTransportService);
      }
      again = false;

      if (rv >= NS_ERROR_WEBTRANSPORT_CODE_BASE &&
          rv <= NS_ERROR_WEBTRANSPORT_CODE_END) {
        uint8_t errorCode = GetWebTransportErrorFromNSResult(rv);
        mSendState = SEND_DONE;
        Reset(WebTransportErrorToHttp3Error(errorCode));
        rv = NS_OK;
      }
    } else if (streamClosed) {
      LOG(("Stream closure detected! mPartialFrameBuffer.Length=%zu",
           mPartialFrameBuffer.Length()));

      // Stream closed - check for incomplete frame
      if (!mPartialFrameBuffer.IsEmpty()) {
        LOG(("Stream closed with %zu bytes of incomplete frame",
             mPartialFrameBuffer.Length()));
        mSendState = SEND_DONE;
        Reset(0x1);  // QUIC application error code
        return NS_ERROR_ABORT;
      }

      // If we have pending data, defer the close until it's sent. The
      // pending tasks and SendFin() are run by the Regular frame handler
      // once mPendingRegularFrameData has drained.
      if (!mPendingRegularFrameData.IsEmpty()) {
        LOG(("Stream closed, have %zu bytes of pending data to send first",
             mPendingRegularFrameData.Length()));
        mDeferredClose = true;
        // Stay in SENDING state and notify session we have data to write
        mSession->StreamHasDataToWrite(this);
        rv = NS_OK;
        again = false;  // Exit loop, will be called again by HTTP/3 session
      } else {
        // No pending data - clean close
        mSendState = SEND_DONE;
        rv = NS_OK;
        again = false;

        if (!mPendingTasks.IsEmpty()) {
          LOG(("Has pending tasks to do"));
          nsTArray<std::function<void()>> tasks = std::move(mPendingTasks);
          for (const auto& task : tasks) {
            task();
          }
        }

        SendFin();
      }
    } else if (readSegmentsResult == 0) {
      // No data available but pipe not closed - wait
      LOG(
          ("Http3WebTransportStream::ReadSegments streamId=%llu [this=%p] no "
           "data, setting AsyncWait",
           (unsigned long long)mStreamId, this));

      mSendState = WAITING_DATA;
      rv = mSendStreamPipeIn->AsyncWait(this, 0, 0, gSocketTransportService);
      LOG(("  streamId=%llu AsyncWait returned: rv=0x%x",
           (unsigned long long)mStreamId, static_cast<uint32_t>(rv)));
      again = false;
    }

  } while (again && gHttpHandler->Active());

  return rv;
}

nsresult Http3WebTransportStream::OnWriteSegment(char* buf, uint32_t count,
                                                 uint32_t* countWritten) {
  MOZ_ASSERT(OnSocketThread(), "not on socket thread");

  LOG(("Http3WebTransportStream::OnWriteSegment [this=%p, state=%d", this,
       static_cast<uint32_t>(mRecvState)));
  nsresult rv = NS_OK;
  switch (mRecvState) {
    case READING: {
      rv = mSession->ReadResponseData(mStreamId, buf, count, countWritten,
                                      &mFin);
      if (*countWritten == 0) {
        if (mFin) {
          mRecvState = RECV_DONE;
          rv = NS_BASE_STREAM_CLOSED;
        } else {
          rv = NS_BASE_STREAM_WOULD_BLOCK;
        }
      } else {
        mTotalReceived += *countWritten;
        if (mFin) {
          mRecvState = RECEIVED_FIN;
        }
      }
    } break;
    case RECEIVED_FIN:
      rv = NS_BASE_STREAM_CLOSED;
      mRecvState = RECV_DONE;
      break;
    case RECV_DONE:
      rv = NS_ERROR_UNEXPECTED;
      break;
    default:
      rv = NS_ERROR_UNEXPECTED;
      break;
  }

  // Remember the error received from lower layers. A stream pipe may overwrite
  // it.
  // If rv == NS_OK this will reset mSocketInCondition.
  mSocketInCondition = rv;

  return rv;
}

// static
nsresult Http3WebTransportStream::WritePipeSegment(nsIOutputStream* stream,
                                                   void* closure, char* buf,
                                                   uint32_t offset,
                                                   uint32_t count,
                                                   uint32_t* countWritten) {
  Http3WebTransportStream* self = (Http3WebTransportStream*)closure;

  nsresult rv = self->OnWriteSegment(buf, count, countWritten);
  if (NS_FAILED(rv)) {
    return rv;
  }

  LOG(("Http3WebTransportStream::WritePipeSegment %p written=%u", self,
       *countWritten));

  return rv;
}

nsresult Http3WebTransportStream::WriteSegments() {
  MOZ_ASSERT(OnSocketThread(), "not on socket thread");
  if (!mReceiveStreamPipeOut) {
    return NS_OK;
  }

  LOG(("Http3WebTransportStream::WriteSegments [this=%p]", this));

  nsresult rv = NS_OK;
  uint32_t countWrittenSingle = 0;
  bool again = true;

  do {
    mSocketInCondition = NS_OK;
    countWrittenSingle = 0;
    rv = mReceiveStreamPipeOut->WriteSegments(WritePipeSegment, this,
                                              nsIOService::gDefaultSegmentSize,
                                              &countWrittenSingle);
    LOG(("Http3WebTransportStream::WriteSegments rv=0x%" PRIx32
         " countWrittenSingle=%" PRIu32 " socketin=%" PRIx32 " [this=%p]",
         static_cast<uint32_t>(rv), countWrittenSingle,
         static_cast<uint32_t>(mSocketInCondition), this));
    if (NS_FAILED(rv)) {
      if (rv == NS_BASE_STREAM_WOULD_BLOCK) {
        nsCOMPtr<nsIEventTarget> target;
        (void)gHttpHandler->GetSocketThreadTarget(getter_AddRefs(target));
        if (target) {
          mReceiveStreamPipeOut->AsyncWait(this, 0, 0, target);
          rv = NS_OK;
        } else {
          rv = NS_ERROR_UNEXPECTED;
        }
      }
      if (rv == NS_BASE_STREAM_CLOSED) {
        mReceiveStreamPipeOut->Close();
        rv = NS_OK;
      }
      again = false;
    } else if (NS_FAILED(mSocketInCondition)) {
      if (mSocketInCondition != NS_BASE_STREAM_WOULD_BLOCK) {
        rv = mSocketInCondition;
        if (rv == NS_BASE_STREAM_CLOSED) {
          mReceiveStreamPipeOut->Close();
          rv = NS_OK;
        }
      }
      again = false;
    }
    // read more from the socket until error...
  } while (again && gHttpHandler->Active());

  return rv;
}

bool Http3WebTransportStream::Done() const {
  return mSendState == SEND_DONE && mRecvState == RECV_DONE;
}

void Http3WebTransportStream::Close(nsresult aResult) {
  MOZ_ASSERT(OnSocketThread(), "not on socket thread");
  LOG(("Http3WebTransportStream::Close [this=%p]", this));
  mTransaction = nullptr;
  if (mSendStreamPipeIn) {
    mSendStreamPipeIn->AsyncWait(nullptr, 0, 0, nullptr);
    mSendStreamPipeIn->CloseWithStatus(aResult);
  }
  if (mReceiveStreamPipeOut) {
    mReceiveStreamPipeOut->AsyncWait(nullptr, 0, 0, nullptr);
    mReceiveStreamPipeOut->CloseWithStatus(aResult);
  }
  mSendState = SEND_DONE;
  mRecvState = RECV_DONE;
  // TryDrainPendingAtomicWrites() will never run again for this stream, so
  // any writes still deferred here would otherwise leave their DOM-side
  // atomicWrite() promises permanently pending. Must happen before mSession
  // is cleared below: ResolveAtomicWrite() needs it to look up the owning
  // WebTransportSession.
  FailPendingAtomicWrites();
  mSession = nullptr;
}

void Http3WebTransportStream::CloseReceiveSide(nsresult aResult) {
  MOZ_ASSERT(OnSocketThread(), "not on socket thread");
  LOG(("Http3WebTransportStream::CloseReceiveSide [this=%p]", this));
  if (mReceiveStreamPipeOut) {
    mReceiveStreamPipeOut->AsyncWait(nullptr, 0, 0, nullptr);
    mReceiveStreamPipeOut->CloseWithStatus(aResult);
  }
  mRecvState = RECV_DONE;
}

void Http3WebTransportStream::CloseSendSide(nsresult aResult) {
  MOZ_ASSERT(OnSocketThread(), "not on socket thread");
  LOG(("Http3WebTransportStream::CloseSendSide [this=%p]", this));
  if (mSendStreamPipeIn) {
    mSendStreamPipeIn->AsyncWait(nullptr, 0, 0, nullptr);
    mSendStreamPipeIn->CloseWithStatus(aResult);
  }
  // neqo resets the send half itself on STOP_SENDING; this keeps SendFin(),
  // Reset() and Commit() from touching it again.
  mSendFin = true;
  mSendState = SEND_DONE;
  mPendingRegularFrameData.Clear();
  mPendingTasks.Clear();
  FailPendingAtomicWrites();
}

void Http3WebTransportStream::SendFin() {
  MOZ_ASSERT(OnSocketThread(), "not on socket thread");
  LOG(("Http3WebTransportStream::SendFin [this=%p mSendState=%d]", this,
       mSendState));

  if (mSendFin || !mSession || mResetError) {
    // Already closed.
    return;
  }

  mSendFin = true;

  switch (mSendState) {
    case SENDING: {
      mPendingTasks.AppendElement([self = RefPtr{this}]() {
        self->mSession->CloseSendingSide(self->mStreamId);
        self->NotifyCloseComplete();
      });
    } break;
    case WAITING_DATA:
      mSendState = SEND_DONE;
      [[fallthrough]];
    case SEND_DONE:
      mSession->CloseSendingSide(mStreamId);
      // StreamHasDataToWrite needs to be called to trigger ProcessOutput.
      mSession->StreamHasDataToWrite(this);
      NotifyCloseComplete();
      break;
    default:
      MOZ_ASSERT_UNREACHABLE("invalid mSendState!");
      break;
  }
}

void Http3WebTransportStream::Reset(uint64_t aErrorCode) {
  MOZ_ASSERT(OnSocketThread(), "not on socket thread");
  LOG(("Http3WebTransportStream::Reset [this=%p, mSendState=%d]", this,
       mSendState));

  if (mResetError || !mSession || mSendFin) {
    // The stream is already reset.
    return;
  }

  mResetError = Some(aErrorCode);

  // TryDrainPendingAtomicWrites() is only ever reached from ReadSegments()/
  // OnReadSegment()'s SENDING path, both of which short-circuit once this
  // stream is resetting -- so any writes still deferred here would
  // otherwise leave their DOM-side atomicWrite() promises permanently
  // pending. mSession is still valid at this point in every switch branch
  // below, so this must run before any of them (not deferred alongside the
  // SENDING case's mPendingTasks entry).
  FailPendingAtomicWrites();

  switch (mSendState) {
    case SENDING: {
      LOG(("Http3WebTransportStream::Reset [this=%p] reset after sending data",
           this));
      mPendingTasks.AppendElement([self = RefPtr{this}]() {
        // "Reset" needs a special treatment here. If we are sending data and
        // ResetWebTransportStream is called before Http3Session::ProcessOutput,
        // neqo will drop the last piece of data.
        NS_DispatchToCurrentThread(
            NS_NewRunnableFunction("Http3WebTransportStream::Reset", [self]() {
              self->mSession->ResetWebTransportStream(self, *self->mResetError);
              self->mSession->StreamHasDataToWrite(self);
              self->mSession->ConnectSlowConsumer(self);
            }));
      });
    } break;
    case WAITING_DATA:
      mSendState = SEND_DONE;
      [[fallthrough]];
    case SEND_DONE:
      mSession->ResetWebTransportStream(this, *mResetError);
      // StreamHasDataToWrite needs to be called to trigger ProcessOutput.
      mSession->StreamHasDataToWrite(this);
      mSession->ConnectSlowConsumer(this);
      break;
    default:
      MOZ_ASSERT_UNREACHABLE("invalid mSendState!");
      break;
  }
}

void Http3WebTransportStream::SendStopSending(uint64_t aErrorCode) {
  MOZ_ASSERT(OnSocketThread(), "not on socket thread");
  LOG(
      ("Http3WebTransportStream::SendStopSending [this=%p, mSendState=%d, "
       "errorCode=%" PRIu64 "]",
       this, mSendState, aErrorCode));

  if (mSendState == WAITING_TO_ACTIVATE) {
    return;
  }

  if (mStopSendingError || !mSession) {
    return;
  }

  // aErrorCode is the application-level WebTransport code (unlike Reset(),
  // whose callers already pass an HTTP/3-mapped code); map it here per
  // draft-ietf-webtrans-http3-15 section 4.4, matching the outgoing
  // RESET_STREAM path.  WebTransportParent bounds it to 32 bits.
  MOZ_DIAGNOSTIC_ASSERT(aErrorCode <= std::numeric_limits<uint32_t>::max());
  mStopSendingError =
      Some(WebTransportErrorToHttp3Error(static_cast<uint32_t>(aErrorCode)));

  mSession->StreamStopSending(this, *mStopSendingError);
  // StreamHasDataToWrite needs to be called to trigger ProcessOutput.
  mSession->StreamHasDataToWrite(this);
}

void Http3WebTransportStream::SetSendOrder(int64_t aSendOrder) {
  if (!mSession) {
    return;
  }
  mSession->SetSendOrder(this, aSendOrder);
}

void Http3WebTransportStream::SetSendGroup(uint64_t aSendGroupId) {
  if (!mSession) {
    return;
  }
  mSession->SetSendGroup(this, aSendGroupId);
}

}  // namespace mozilla::net
