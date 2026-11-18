/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// HttpLog.h should generally be included first
#include "Http2WebTransportStream.h"

#include <algorithm>

#include "Capsule.h"
#include "CapsuleEncoder.h"
#include "Http2WebTransportSession.h"
#include "HttpLog.h"
#include "mozilla/dom/WebTransportFraming.h"
#include "nsHttp.h"
#include "nsIOService.h"

namespace mozilla::net {

NS_IMPL_ISUPPORTS(Http2WebTransportStream, nsIOutputStreamCallback,
                  nsIInputStreamCallback)

Http2WebTransportStream::Http2WebTransportStream(
    Http2WebTransportSessionImpl* aWebTransportSession, StreamId aStreamId,
    uint64_t aInitialMaxStreamData, uint64_t aInitialLocalMaxStreamData,
    std::function<void(Result<RefPtr<WebTransportStreamBase>, nsresult>&&)>&&
        aCallback)
    : WebTransportStreamBase(aWebTransportSession->GetStreamId(),
                             std::move(aCallback)),
      mWebTransportSession(aWebTransportSession),
      mStreamId(aStreamId),
      mOwnerThread(GetCurrentSerialEventTarget()),
      mFc(aStreamId, aInitialMaxStreamData),
      mReceiverFc(aStreamId, aInitialLocalMaxStreamData) {
  LOG(("Http2WebTransportStream outgoing ctor:%p", this));
  mStreamRole = OUTGOING;
  mStreamType = mStreamId.StreamType();
}

Http2WebTransportStream::Http2WebTransportStream(
    Http2WebTransportSessionImpl* aWebTransportSession,
    uint64_t aInitialMaxStreamData, uint64_t aInitialLocalMaxStreamData,
    StreamId aStreamId)
    : WebTransportStreamBase(aWebTransportSession->GetStreamId(), nullptr),
      mWebTransportSession(aWebTransportSession),
      mStreamId(aStreamId),
      mOwnerThread(GetCurrentSerialEventTarget()),
      mFc(aStreamId, aInitialMaxStreamData),
      mReceiverFc(aStreamId, aInitialLocalMaxStreamData) {
  LOG(("Http2WebTransportStream incoming ctor:%p", this));
  mStreamRole = INCOMING;
  mStreamType = mStreamId.StreamType();
}

Http2WebTransportStream::~Http2WebTransportStream() {
  LOG(("Http2WebTransportStream dtor:%p", this));
}

nsresult Http2WebTransportStream::Init() {
  nsresult rv = NS_OK;
  auto resultCallback = MakeScopeExit([&] {
    if (NS_FAILED(rv)) {
      mSendState = SEND_DONE;
      mRecvState = RECV_DONE;
      if (mStreamReadyCallback) {
        mStreamReadyCallback(Err(rv));
      }

    } else {
      mSocketInCondition = NS_OK;
      mSocketOutCondition = NS_OK;
      RefPtr<WebTransportStreamBase> stream = this;
      if (mStreamReadyCallback) {
        mStreamReadyCallback(stream);
      }
    }
    mStreamReadyCallback = nullptr;
  });

  if (mStreamRole == INCOMING) {
    rv = InitInputPipe();
    if (NS_FAILED(rv)) {
      return rv;
    }

    if (mStreamType == WebTransportStreamType::BiDi) {
      rv = InitOutputPipe();
    }

    return rv;
  }

  MOZ_ASSERT(mStreamRole == OUTGOING);
  rv = InitOutputPipe();
  if (NS_FAILED(rv)) {
    return rv;
  }

  if (mStreamType == WebTransportStreamType::BiDi) {
    rv = InitInputPipe();
  }

  if (mSendStreamPipeIn) {
    rv = mSendStreamPipeIn->AsyncWait(this, 0, 0, mOwnerThread);
  }

  return rv;
}

class StreamId Http2WebTransportStream::WebTransportStreamId() const {
  return mStreamId;
}

uint64_t Http2WebTransportStream::GetStreamId() const { return mStreamId; }

void Http2WebTransportStream::SendStopSending(uint64_t aErrorCode) {
  if (mSentStopSending || !mWebTransportSession) {
    // https://www.ietf.org/archive/id/draft-ietf-webtrans-http2-11.html#section-6.3
    // A WT_STOP_SENDING capsule MUST NOT be sent multiple times for the same
    // stream.
    return;
  }

  mSentStopSending = true;
  mStopSendingCapsule.emplace(
      Capsule::WebTransportStopSending(aErrorCode, mStreamId));
  mWebTransportSession->StreamHasCapsuleToSend();
  mRecvState = RECV_DONE;
}

void Http2WebTransportStream::SendFin() {
  // The HTTP/2 backend does not yet send a FIN: the sender always passes
  // aFin=false in its WT_STREAM capsules.  The close is reported complete as
  // soon as it is requested so the DOM can settle the close promise.
  if (mWebTransportSession) {
    mWebTransportSession->NotifyStreamCloseComplete(mStreamId);
  }
}

void Http2WebTransportStream::Reset(uint64_t aErrorCode) {
  if (mSentReset || !mWebTransportSession || mSendState == SEND_DONE) {
    // https://www.ietf.org/archive/id/draft-ietf-webtrans-http2-11.html#section-6.2
    // A WT_RESET_STREAM capsule MUST NOT be sent after a stream is closed or
    // reset.
    return;
  }

  mSentReset = true;
  mStreamResetCapsule.emplace(Capsule::WebTransportResetStream(
      aErrorCode, mTotalSent.value(), mStreamId));
  mWebTransportSession->StreamHasCapsuleToSend();
  mRecvState = RECV_DONE;
  mSendState = SEND_DONE;
}

void Http2WebTransportStream::AbortSending(uint32_t aErrorCode) {
  mPartialFrameBuffer.Clear();
  DropQueuedData();
  Reset(aErrorCode);
}

already_AddRefed<nsIWebTransportSendStreamStats>
Http2WebTransportStream::GetSendStreamStats() {
  return nullptr;
}

already_AddRefed<nsIWebTransportReceiveStreamStats>
Http2WebTransportStream::GetReceiveStreamStats() {
  return nullptr;
}

bool Http2WebTransportStream::RecvDone() const { return false; }

void Http2WebTransportStream::SetSendOrder(int64_t aSendOrder) {}

NS_IMETHODIMP
Http2WebTransportStream::OnInputStreamReady(nsIAsyncInputStream* aIn) {
  LOG1(
      ("Http2WebTransportStream::OnInputStreamReady [this=%p stream=%p "
       "state=%d]",
       this, aIn, mSendState));
  if (mSendState == SEND_DONE) {
    // already closed
    return NS_OK;
  }

  if (mFramesBlocked) {
    ProcessFrames();
    if (mFramesBlocked) {
      return NS_OK;
    }
  }

  uint32_t sendBytes = 0;
  nsresult rv = mSendStreamPipeIn->ReadSegments(
      ReadRequestSegment, this, nsIOService::gDefaultSegmentSize, &sendBytes);
  ProcessFrames();

  return rv;
}

NS_IMETHODIMP
Http2WebTransportStream::OnOutputStreamReady(nsIAsyncOutputStream* aOut) {
  if (!mCurrentOut) {
    if (mOutgoingQueue.IsEmpty()) {
      return NS_OK;
    }
    mCurrentOut = mOutgoingQueue.Pop();
  }

  while (mCurrentOut && mReceiveStreamPipeOut && (mRecvState != RECV_DONE)) {
    uint32_t available = mCurrentOut->GetData().Length() - mWriteOffset;
    char* writeBuffer = reinterpret_cast<char*>(const_cast<uint8_t*>(
                            mCurrentOut->GetData().Elements())) +
                        mWriteOffset;
    uint32_t toWrite = available;
    if (mReliableSize) {
      if (*mReliableSize <= mTotalReceived) {
        mRecvState = RECV_DONE;
        break;
      }
      uint64_t remaining = *mReliableSize - mTotalReceived;
      if (remaining < toWrite) {
        toWrite = static_cast<uint32_t>(remaining);
      }
    }

    uint32_t wrote = 0;
    nsresult rv = mReceiveStreamPipeOut->Write(writeBuffer, toWrite, &wrote);
    LOG(("Http2WebTransportStream::Write rv=0x%" PRIx32 " wrote=%" PRIu32
         " socketin=%" PRIx32 " [this=%p]",
         static_cast<uint32_t>(rv), wrote,
         static_cast<uint32_t>(mSocketInCondition), this));
    if (rv == NS_BASE_STREAM_WOULD_BLOCK) {
      mSocketInCondition =
          mReceiveStreamPipeOut->AsyncWait(this, 0, 0, nullptr);
      return mSocketInCondition;
    }

    if (NS_FAILED(rv)) {
      LOG(("Http2WebTransportStream::OnOutputStreamReady %p failed %u\n", this,
           static_cast<uint32_t>(rv)));
      // TODO: close this stream
      mSocketInCondition = rv;
      mCurrentOut = nullptr;
      mRecvState = RECV_DONE;
      return NS_OK;
    }

    // Retire when sending data to the consumer.
    mReceiverFc.AddRetired(wrote);
    mWebTransportSession->ReceiverFc().AddRetired(wrote);

    mWriteOffset += wrote;
    mTotalReceived += wrote;
    // https://www.ietf.org/archive/id/draft-ietf-webtrans-http2-11.html#section-6.2
    // A receiver of a WT_RESET_STREAM capsule can discard any data in excess of
    // the Reliable Size indicated, even if that data was already received.
    if (mReliableSize && mTotalReceived == *mReliableSize) {
      mSocketInCondition = NS_OK;
      mWriteOffset = 0;
      mCurrentOut = nullptr;
      mOutgoingQueue.Clear();
      mRecvState = RECV_DONE;
      break;
    }

    if (toWrite == wrote) {
      mWriteOffset = 0;
      mCurrentOut = mOutgoingQueue.IsEmpty() ? nullptr : mOutgoingQueue.Pop();
    }
  }
  return NS_OK;
}

// static
nsresult Http2WebTransportStream::ReadRequestSegment(
    nsIInputStream* stream, void* closure, const char* buf, uint32_t offset,
    uint32_t count, uint32_t* countRead) {
  Http2WebTransportStream* wtStream = (Http2WebTransportStream*)closure;
  LOG(("Http2WebTransportStream::ReadRequestSegment %p count=%u", wtStream,
       count));
  *countRead = 0;
  if (!wtStream->mWebTransportSession) {
    return NS_ERROR_UNEXPECTED;
  }

  wtStream->mPartialFrameBuffer.AppendElements(buf, count);
  *countRead = count;
  return NS_OK;
}

void Http2WebTransportStream::QueueStreamData(nsTArray<uint8_t>&& aData) {
  mQueuedUnsentBytes += aData.Length();
  mWebTransportSession->AddQueuedUnsentBytes(aData.Length());
  Capsule capsule =
      Capsule::WebTransportStreamData(mStreamId, false, std::move(aData));
  auto encoder = std::make_unique<CapsuleEncoder>();
  encoder->EncodeCapsule(capsule);
  mCapsuleQueue.Push(std::move(encoder));
}

void Http2WebTransportStream::ReleaseQueuedCredit() {
  if (mWebTransportSession) {
    mWebTransportSession->SubQueuedUnsentBytes(mQueuedUnsentBytes);
  }
  mQueuedUnsentBytes = 0;
}

void Http2WebTransportStream::DropQueuedData() {
  mCapsuleQueue.Clear();
  ReleaseQueuedCredit();
}

void Http2WebTransportStream::ProcessFrames() {
  mFramesBlocked = false;
  while (mWebTransportSession && mSendState != SEND_DONE) {
    // Credit already promised to queued capsules is not yet consumed from the
    // flow controllers.  Session credit is shared, so every stream's queued
    // data counts against it, not just this one's.
    auto unspent = [](uint64_t aAvailable, uint64_t aQueued) {
      return aAvailable > aQueued ? aAvailable - aQueued : 0;
    };
    uint64_t sessionAvailable =
        unspent(mWebTransportSession->SessionDataFc().Available(),
                mWebTransportSession->QueuedUnsentBytes());
    uint64_t streamAvailable = unspent(mFc.Available(), mQueuedUnsentBytes);

    // A Regular frame is forwarded as it arrives, as far as flow control
    // allows, so a write larger than the peer's window cannot deadlock and
    // only a window's worth of it is ever buffered.
    if (mRegularPayloadRemaining == 0 && !mPartialFrameBuffer.IsEmpty() &&
        mPartialFrameBuffer[0] ==
            static_cast<uint8_t>(dom::WebTransportFrameType::Regular) &&
        mPartialFrameBuffer.Length() >= WEBTRANSPORT_FRAME_PREFIX_SIZE) {
      uint64_t length = (static_cast<uint32_t>(mPartialFrameBuffer[1]) << 24) |
                        (static_cast<uint32_t>(mPartialFrameBuffer[2]) << 16) |
                        (static_cast<uint32_t>(mPartialFrameBuffer[3]) << 8) |
                        static_cast<uint32_t>(mPartialFrameBuffer[4]);
      if (length > WEBTRANSPORT_FRAME_MAX_PAYLOAD) {
        LOG(("Http2WebTransportStream %p oversized frame, resetting", this));
        mPartialFrameBuffer.Clear();
        DropQueuedData();
        Reset(0x1);
        return;
      }
      mPartialFrameBuffer.RemoveElementsAt(0, WEBTRANSPORT_FRAME_PREFIX_SIZE);
      mRegularPayloadRemaining = length;
    }
    if (mRegularPayloadRemaining > 0) {
      if (mPartialFrameBuffer.IsEmpty()) {
        return;
      }
      uint64_t wanted = std::min<uint64_t>(mRegularPayloadRemaining,
                                           mPartialFrameBuffer.Length());
      size_t count = static_cast<size_t>(
          std::min({wanted, sessionAvailable, streamAvailable}));
      if (sessionAvailable < wanted) {
        LOG(("blocked by session level flow control"));
        mWebTransportSession->SessionDataFc().Blocked();
      }
      if (streamAvailable < wanted) {
        LOG(("blocked by stream level flow control"));
        mFc.Blocked();
      }
      if (count == 0) {
        mFramesBlocked = true;
        return;
      }
      nsTArray<uint8_t> data;
      data.AppendElements(mPartialFrameBuffer.Elements(), count);
      mPartialFrameBuffer.RemoveElementsAt(0, count);
      mRegularPayloadRemaining -= count;
      QueueStreamData(std::move(data));
      continue;
    }

    dom::WebTransportFrameType type;
    uint32_t atomicWriteId = 0;
    size_t frameLength = 0;
    nsTArray<uint8_t> payload;
    // The buffer holds data from the content process.
    auto result = dom::ParseWebTransportFrameHeader(
        mPartialFrameBuffer, type, atomicWriteId, payload, frameLength);
    if (result == dom::WebTransportFrameParseResult::NeedMoreData) {
      return;
    }
    if (result == dom::WebTransportFrameParseResult::Malformed) {
      LOG(("Http2WebTransportStream %p malformed frame, resetting", this));
      mPartialFrameBuffer.Clear();
      // Data queued from earlier frames is behind the reset, which only
      // covers what was already written.
      DropQueuedData();
      Reset(0x1);
      return;
    }

    if (type == dom::WebTransportFrameType::Abort) {
      // abort(): atomicWriteId carries the stream error code.
      mPartialFrameBuffer.Clear();
      Reset(atomicWriteId);
      return;
    }

    mPartialFrameBuffer.RemoveElementsAt(
        0, WEBTRANSPORT_FRAME_PREFIX_SIZE + frameLength);
    if (type != dom::WebTransportFrameType::Atomic) {
      continue;
    }

    // All or nothing: an atomic write that does not fit now is rejected
    // rather than waited for.
    bool fits = std::min(sessionAvailable, streamAvailable) >= payload.Length();
    if (fits && !payload.IsEmpty()) {
      QueueStreamData(std::move(payload));
    }
    mWebTransportSession->ResolveAtomicWrite(GetStreamId(), atomicWriteId,
                                             fits ? NS_OK : NS_ERROR_ABORT);
  }
}

void Http2WebTransportStream::TakeOutputCapsule(
    mozilla::Queue<UniquePtr<CapsuleEncoder>>& aOutput) {
  LOG(("Http2WebTransportStream::TakeOutputCapsule %p", this));
  if (mFramesBlocked) {
    ProcessFrames();
  }
  if (mCapsuleQueue.IsEmpty()) {
    mSendStreamPipeIn->AsyncWait(this, 0, 0, mOwnerThread);
    return;
  }
  while (!mCapsuleQueue.IsEmpty()) {
    UniquePtr<CapsuleEncoder> entry = mCapsuleQueue.Pop();
    aOutput.Push(std::move(entry));
  }
  mSendStreamPipeIn->AsyncWait(this, 0, 0, mOwnerThread);
}

void Http2WebTransportStream::WriteMaintenanceCapsules(
    mozilla::Queue<UniquePtr<CapsuleEncoder>>& aOutput) {
  if (mStopSendingCapsule) {
    auto encoder = std::make_unique<CapsuleEncoder>();
    encoder->EncodeCapsule(*mStopSendingCapsule);
    mStopSendingCapsule = Nothing();
    aOutput.Push(std::move(encoder));
  }

  if (mStreamResetCapsule) {
    auto encoder = std::make_unique<CapsuleEncoder>();
    encoder->EncodeCapsule(*mStreamResetCapsule);
    mStreamResetCapsule = Nothing();
    aOutput.Push(std::move(encoder));
  }

  auto dataBlocked = mFc.CreateStreamDataBlockedCapsule();
  if (dataBlocked) {
    aOutput.Push(std::make_unique<CapsuleEncoder>(dataBlocked.ref()));
  }

  auto maxStreamData = mReceiverFc.CreateMaxStreamDataCapsule();
  if (maxStreamData) {
    aOutput.Push(std::make_unique<CapsuleEncoder>(maxStreamData.ref()));
  }

  // Keep reading data from the consumer.
  mSendStreamPipeIn->AsyncWait(this, 0, 0, mOwnerThread);
}

nsresult Http2WebTransportStream::OnCapsule(Capsule&& aCapsule) {
  switch (aCapsule.Type()) {
    case CapsuleType::WT_STREAM: {
      LOG(("Handling WT_STREAM\n"));
      WebTransportStreamDataCapsule& streamData =
          aCapsule.GetWebTransportStreamDataCapsule();
      return HandleStreamData(false, std::move(streamData.mData));
    }
    case CapsuleType::WT_STREAM_FIN:
      LOG(("Handling WT_STREAM_FIN\n"));
      break;
    case CapsuleType::WT_MAX_STREAM_DATA: {
      LOG(("Handling WT_MAX_STREAM_DATA\n"));
      WebTransportMaxStreamDataCapsule& maxStreamData =
          aCapsule.GetWebTransportMaxStreamDataCapsule();
      return HandleMaxStreamData(maxStreamData.mLimit);
    }
    case CapsuleType::WT_STREAM_DATA_BLOCKED:
      LOG(("Handling WT_STREAM_DATA_BLOCKED\n"));
      break;
    default:
      LOG(("Unhandled capsule type\n"));
      break;
  }
  return NS_OK;
}

nsresult Http2WebTransportStream::HandleMaxStreamData(uint64_t aLimit) {
  mFc.Update(aLimit);
  return NS_OK;
}

void Http2WebTransportStream::OnStopSending() { mSendState = SEND_DONE; }

nsresult Http2WebTransportStream::OnReset(uint64_t aSize) {
  if (mReliableSize) {
    return NS_OK;
  }

  LOG(("Http2WebTransportStream::OnReset %p aSize=%" PRIu64
       " mTotalReceived=%" PRIu64,
       this, aSize, mTotalReceived));

  if (aSize < mTotalReceived) {
    // A receiver MUST treat the receipt of a WT_RESET_STREAM with a Reliable
    // Size smaller than the number of bytes it has received on the stream as a
    // session error.
    RefPtr<Http2WebTransportSessionImpl> session = mWebTransportSession;
    Close(NS_ERROR_ILLEGAL_VALUE);
    session->Close(NS_ERROR_ILLEGAL_VALUE);
    return NS_ERROR_ILLEGAL_VALUE;
  }

  mReliableSize.emplace(aSize);

  if (mTotalReceived == aSize) {
    mRecvState = RECV_DONE;
  }

  return NS_OK;
}

void Http2WebTransportStream::OnStreamDataSent(size_t aCount) {
  LOG(("Http2WebTransportStream::OnStreamDataSent %p aCount=%" PRIu64
       " mTotalSent=%" PRIu64,
       this, static_cast<uint64_t>(aCount), mTotalSent.value()));
  mTotalSent += aCount;
  if (!mTotalSent.isValid()) {
    // TODO: find a better error code.
    mWebTransportSession->OnError(0);
    return;
  }

  mQueuedUnsentBytes -= std::min<uint64_t>(aCount, mQueuedUnsentBytes);
  mWebTransportSession->SubQueuedUnsentBytes(aCount);
  mFc.Consume(aCount);
  mWebTransportSession->SessionDataFc().Consume(aCount);
}

void Http2WebTransportStream::Close(nsresult aResult) {
  ReleaseQueuedCredit();
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
  mWebTransportSession = nullptr;
}

nsresult Http2WebTransportStream::HandleStreamData(bool aFin,
                                                   nsTArray<uint8_t>&& aData) {
  LOG(("Http2WebTransportStream::HandleStreamData [this=%p, state=%d aFin=%d",
       this, static_cast<uint32_t>(mRecvState), aFin));

  if (NS_FAILED(mSocketInCondition)) {
    mRecvState = RECV_DONE;
  }

  uint32_t countWrittenSingle = 0;
  switch (mRecvState) {
    case READING: {
      size_t length = aData.Length();
      if (length) {
        auto newConsumed =
            mReceiverFc.SetConsumed(mReceiverFc.Consumed() + length);
        if (newConsumed.isErr()) {
          mSocketInCondition = newConsumed.unwrapErr();
        } else {
          if (!mWebTransportSession->ReceiverFc().Consume(
                  newConsumed.unwrap())) {
            LOG(("Exceed session flow control limit"));
            mSocketInCondition = NS_ERROR_NOT_AVAILABLE;
          } else {
            mOutgoingQueue.Push(std::make_unique<StreamData>(std::move(aData)));
            mSocketInCondition = OnOutputStreamReady(mReceiveStreamPipeOut);
          }
        }
      } else {
        // https://www.ietf.org/archive/id/draft-ietf-webtrans-http2-10.html#section-6.4
        // Empty WT_STREAM capsules MUST NOT be used unless they open or close a
        // stream
        // TODO: Handle empty stream capsule
      }

      LOG((
          "Http2WebTransportStream::HandleStreamData "
          "countWrittenSingle=%" PRIu32 " socketin=%" PRIx32 " [this=%p]",
          countWrittenSingle, static_cast<uint32_t>(mSocketInCondition), this));

      if (NS_FAILED(mSocketInCondition)) {
        mReceiveStreamPipeOut->Close();
        mRecvState = RECV_DONE;
      } else {
        if (aFin) {
          mRecvState = RECEIVED_FIN;
        }
      }
    } break;
    case RECEIVED_FIN:
      mRecvState = RECV_DONE;
      break;
    case RECV_DONE:
      mSocketInCondition = NS_ERROR_UNEXPECTED;
      break;
    default:
      mSocketInCondition = NS_ERROR_UNEXPECTED;
      break;
  }

  return mSocketInCondition;
}

}  // namespace mozilla::net
