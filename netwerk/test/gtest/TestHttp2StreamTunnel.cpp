/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "ASpdySession.h"
#include "Http2Session.h"
#include "Http2StreamTunnel.h"
#include "gtest/gtest.h"
#include "mozilla/net/DNS.h"
#include "nsHttpConnectionInfo.h"
#include "nsIHttpProtocolHandler.h"
#include "nsNetCID.h"
#include "nsServiceManagerUtils.h"
#include "nsSocketTransportService2.h"
#include "nsThreadUtils.h"

namespace mozilla::net {
namespace {

// A tunnel stream that models the session's pull window: the base only moves
// bytes while the session holds its segment reader/writer, so OnReadSegment and
// OnWriteSegment only do anything while the test says the window is open.
class WindowedTunnel final : public Http2StreamTunnel {
 public:
  WindowedTunnel(Http2Session* aSession, nsHttpConnectionInfo* aCi)
      : Http2StreamTunnel(aSession, 0, 0, aCi) {}

  nsresult OnReadSegment(const char* aBuf, uint32_t aCount,
                         uint32_t* aCountRead) override {
    *aCountRead = 0;
    if (!mWindowOpen) {
      return NS_BASE_STREAM_WOULD_BLOCK;
    }
    if (mFailWrites) {
      return NS_ERROR_FAILURE;
    }
    if (mMaxPerSegment) {
      aCount = std::min(aCount, mMaxPerSegment);
    }
    mSent.Append(aBuf, aCount);
    *aCountRead = aCount;
    return NS_OK;
  }

  nsresult OnWriteSegment(char* aBuf, uint32_t aCount,
                          uint32_t* aCountWritten) override {
    *aCountWritten = 0;
    if (!mWindowOpen || mToDeliver.IsEmpty()) {
      return NS_BASE_STREAM_WOULD_BLOCK;
    }
    uint32_t n = std::min<uint32_t>(aCount, mToDeliver.Length());
    memcpy(aBuf, mToDeliver.BeginReading(), n);
    mToDeliver.Cut(0, n);
    *aCountWritten = n;
    return NS_OK;
  }

  bool mWindowOpen = false;
  // Caps how much one OnReadSegment accepts (0: unlimited), modelling a
  // flow-control or frame-size limit.
  uint32_t mMaxPerSegment = 0;
  bool mFailWrites = false;
  nsCString mSent;       // what the consumer managed to write out
  nsCString mToDeliver;  // what the network has for the consumer

 private:
  ~WindowedTunnel() = default;
};

// Reads or writes when told to, never inside the callback -- the shape of a
// consumer driven by NS_AsyncCopy.
class DeferredConsumer final : public nsIOutputStreamCallback,
                               public nsIInputStreamCallback {
 public:
  NS_DECL_ISUPPORTS

  NS_IMETHOD OnOutputStreamReady(nsIAsyncOutputStream*) override {
    ++mOutputReady;
    return NS_OK;
  }
  NS_IMETHOD OnInputStreamReady(nsIAsyncInputStream*) override {
    ++mInputReady;
    return NS_OK;
  }

  uint32_t mOutputReady = 0;
  uint32_t mInputReady = 0;

 private:
  ~DeferredConsumer() = default;
};

NS_IMPL_ISUPPORTS(DeferredConsumer, nsIOutputStreamCallback,
                  nsIInputStreamCallback)

void EnsureHttpHandler() {
  nsCOMPtr<nsIHttpProtocolHandler> http =
      do_GetService("@mozilla.org/network/protocol;1?name=http");
  ASSERT_TRUE(http);
}

void RunOnSocketThread(std::function<void()>&& aFn) {
  nsCOMPtr<nsIEventTarget> sts = gSocketTransportService;
  ASSERT_TRUE(sts);
  NS_DispatchAndSpinEventLoopUntilComplete(
      "TestHttp2StreamTunnel"_ns, sts,
      NS_NewRunnableFunction("TestHttp2StreamTunnel", std::move(aFn)));
}

already_AddRefed<nsHttpConnectionInfo> MakeCi() {
  OriginAttributes attrs;
  RefPtr<nsHttpConnectionInfo> ci = new nsHttpConnectionInfo(
      "example.com"_ns, 443, ""_ns, ""_ns, nullptr, attrs, true);
  return ci.forget();
}

}  // namespace

// A consumer that writes after the callback has returned still makes progress:
// the bytes are accepted out of window and reach the stream on the next one.
TEST(Http2StreamTunnel, WriteOutsideTheWindowIsSentOnTheNextWindow)
{
  EnsureHttpHandler();
  RunOnSocketThread([]() {
    RefPtr<Http2Session> session = static_cast<Http2Session*>(
        ASpdySession::NewSpdySession(SpdyVersion::HTTP_2, nullptr, false));
    ASSERT_TRUE(session);
    RefPtr<nsHttpConnectionInfo> ci = MakeCi();
    RefPtr<WindowedTunnel> tunnel = new WindowedTunnel(session, ci);
    RefPtr<OutputStreamTunnel> out = new OutputStreamTunnel(tunnel);
    RefPtr<DeferredConsumer> consumer = new DeferredConsumer();

    // The session pulls; the consumer is told it may write but does not yet.
    out->AsyncWait(consumer, 0, 0, nullptr);
    tunnel->mWindowOpen = true;
    out->OnSocketReady(NS_OK);
    tunnel->mWindowOpen = false;
    EXPECT_EQ(consumer->mOutputReady, 1u) << "consumer should be notified";
    EXPECT_TRUE(tunnel->mSent.IsEmpty());

    // Now it writes, one dispatch too late.
    uint32_t written = 0;
    nsresult rv = out->Write("hello", 5, &written);
    EXPECT_TRUE(NS_SUCCEEDED(rv))
        << "an out-of-window write must be accepted, not WOULD_BLOCK";
    EXPECT_EQ(written, 5u);

    // The next window puts it on the wire.
    tunnel->mWindowOpen = true;
    out->OnSocketReady(NS_OK);
    tunnel->mWindowOpen = false;
    EXPECT_STREQ(tunnel->mSent.get(), "hello");
  });
}

// The mirror: a consumer that reads after the callback returns is served from
// the chunk taken off the network during the window.
TEST(Http2StreamTunnel, ReadOutsideTheWindowIsServedFromTheHeldChunk)
{
  EnsureHttpHandler();
  RunOnSocketThread([]() {
    RefPtr<Http2Session> session = static_cast<Http2Session*>(
        ASpdySession::NewSpdySession(SpdyVersion::HTTP_2, nullptr, false));
    ASSERT_TRUE(session);
    RefPtr<nsHttpConnectionInfo> ci = MakeCi();
    RefPtr<WindowedTunnel> tunnel = new WindowedTunnel(session, ci);
    RefPtr<InputStreamTunnel> in = new InputStreamTunnel(tunnel);
    RefPtr<DeferredConsumer> consumer = new DeferredConsumer();

    tunnel->mToDeliver.AssignLiteral("world");
    in->AsyncWait(consumer, 0, 0, nullptr);
    tunnel->mWindowOpen = true;
    in->OnSocketReady(NS_OK);
    tunnel->mWindowOpen = false;
    EXPECT_EQ(consumer->mInputReady, 1u) << "consumer should be notified";

    // Reading now, outside the window, must still yield the bytes.
    char buf[16] = {0};
    uint32_t read = 0;
    nsresult rv = in->Read(buf, sizeof(buf), &read);
    EXPECT_TRUE(NS_SUCCEEDED(rv))
        << "an out-of-window read must be served, not WOULD_BLOCK";
    EXPECT_EQ(read, 5u);
    EXPECT_STREQ(buf, "world");
  });
}

// A window too small for everything held over sends what fits and keeps the
// consumer waiting; the next window takes the rest and only then notifies it.
TEST(Http2StreamTunnel, PartialFlushKeepsTheConsumerWaiting)
{
  EnsureHttpHandler();
  RunOnSocketThread([]() {
    RefPtr<Http2Session> session = static_cast<Http2Session*>(
        ASpdySession::NewSpdySession(SpdyVersion::HTTP_2, nullptr, false));
    ASSERT_TRUE(session);
    RefPtr<nsHttpConnectionInfo> ci = MakeCi();
    RefPtr<WindowedTunnel> tunnel = new WindowedTunnel(session, ci);
    RefPtr<OutputStreamTunnel> out = new OutputStreamTunnel(tunnel);
    RefPtr<DeferredConsumer> consumer = new DeferredConsumer();

    uint32_t written = 0;
    EXPECT_TRUE(NS_SUCCEEDED(out->Write("hello", 5, &written)));
    EXPECT_EQ(written, 5u);
    out->AsyncWait(consumer, 0, 0, nullptr);

    // The stream only takes two bytes this window.
    tunnel->mMaxPerSegment = 2;
    tunnel->mWindowOpen = true;
    out->OnSocketReady(NS_OK);
    tunnel->mWindowOpen = false;
    EXPECT_STREQ(tunnel->mSent.get(), "he");
    EXPECT_EQ(consumer->mOutputReady, 0u)
        << "the consumer must not be told to write while bytes are held";
    EXPECT_EQ(out->Write("x", 1, &written), NS_BASE_STREAM_WOULD_BLOCK)
        << "the held chunk is still occupied";

    // The next window drains the rest and the wait finally fires.
    tunnel->mMaxPerSegment = 0;
    tunnel->mWindowOpen = true;
    out->OnSocketReady(NS_OK);
    tunnel->mWindowOpen = false;
    EXPECT_STREQ(tunnel->mSent.get(), "hello");
    EXPECT_EQ(consumer->mOutputReady, 1u);
  });
}

// Held-over bytes the stream refuses fail the stream: the consumer is woken
// and its next write reports the error instead of blocking forever.
TEST(Http2StreamTunnel, FailedFlushFailsTheStream)
{
  EnsureHttpHandler();
  RunOnSocketThread([]() {
    RefPtr<Http2Session> session = static_cast<Http2Session*>(
        ASpdySession::NewSpdySession(SpdyVersion::HTTP_2, nullptr, false));
    ASSERT_TRUE(session);
    RefPtr<nsHttpConnectionInfo> ci = MakeCi();
    RefPtr<WindowedTunnel> tunnel = new WindowedTunnel(session, ci);
    RefPtr<OutputStreamTunnel> out = new OutputStreamTunnel(tunnel);
    RefPtr<DeferredConsumer> consumer = new DeferredConsumer();

    uint32_t written = 0;
    EXPECT_TRUE(NS_SUCCEEDED(out->Write("hello", 5, &written)));
    out->AsyncWait(consumer, 0, 0, nullptr);

    tunnel->mFailWrites = true;
    tunnel->mWindowOpen = true;
    out->OnSocketReady(NS_OK);
    tunnel->mWindowOpen = false;
    EXPECT_EQ(consumer->mOutputReady, 1u) << "the consumer must be woken";
    EXPECT_EQ(out->StreamStatus(), NS_ERROR_FAILURE);
    EXPECT_EQ(out->Write("x", 1, &written), NS_ERROR_FAILURE);
    EXPECT_EQ(written, 0u);
  });
}

// The stream failing while bytes are held over: nothing can be sent, so the
// bytes are dropped and the consumer is woken to see the failure.
TEST(Http2StreamTunnel, FailedConditionWithHeldBytesWakesTheConsumer)
{
  EnsureHttpHandler();
  RunOnSocketThread([]() {
    RefPtr<Http2Session> session = static_cast<Http2Session*>(
        ASpdySession::NewSpdySession(SpdyVersion::HTTP_2, nullptr, false));
    ASSERT_TRUE(session);
    RefPtr<nsHttpConnectionInfo> ci = MakeCi();
    RefPtr<WindowedTunnel> tunnel = new WindowedTunnel(session, ci);
    RefPtr<OutputStreamTunnel> out = new OutputStreamTunnel(tunnel);
    RefPtr<DeferredConsumer> consumer = new DeferredConsumer();

    uint32_t written = 0;
    EXPECT_TRUE(NS_SUCCEEDED(out->Write("hello", 5, &written)));
    out->AsyncWait(consumer, 0, 0, nullptr);

    // The proxy reset the stream before the next window came.
    out->OnSocketReady(NS_ERROR_NET_RESET);
    EXPECT_EQ(consumer->mOutputReady, 1u) << "the consumer must be woken";
    EXPECT_EQ(out->Write("x", 1, &written), NS_ERROR_NET_RESET);
    EXPECT_TRUE(tunnel->mSent.IsEmpty());
  });
}

// The session going away while bytes are held over must not try to ask it for
// another window (bug: MOZ_ASSERT in GetSession).
TEST(Http2StreamTunnel, SessionGoneWithHeldBytesWakesTheConsumer)
{
  EnsureHttpHandler();
  RunOnSocketThread([]() {
    RefPtr<Http2Session> session = static_cast<Http2Session*>(
        ASpdySession::NewSpdySession(SpdyVersion::HTTP_2, nullptr, false));
    ASSERT_TRUE(session);
    RefPtr<nsHttpConnectionInfo> ci = MakeCi();
    RefPtr<WindowedTunnel> tunnel = new WindowedTunnel(session, ci);
    RefPtr<OutputStreamTunnel> out = new OutputStreamTunnel(tunnel);
    RefPtr<DeferredConsumer> consumer = new DeferredConsumer();

    uint32_t written = 0;
    EXPECT_TRUE(NS_SUCCEEDED(out->Write("hello", 5, &written)));
    out->AsyncWait(consumer, 0, 0, nullptr);

    // The stream only holds a weak reference to its session.
    session = nullptr;
    out->OnSocketReady(NS_OK);
    EXPECT_EQ(consumer->mOutputReady, 1u) << "the consumer must be woken";
    EXPECT_TRUE(tunnel->mSent.IsEmpty());
  });
}

}  // namespace mozilla::net
