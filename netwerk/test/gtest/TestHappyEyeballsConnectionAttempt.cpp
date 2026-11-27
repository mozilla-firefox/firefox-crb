/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// gtests for HappyEyeballsConnectionAttempt. Two injected seams exercise the
// dispatch logic without real sockets: a fake ConnectionEstablisherFactory
// (establishers complete on demand) and a recording
// HappyEyeballsConnMgrDelegate (intercepts connection-manager/entry calls). The
// real Rust engine stays live, driven via its FFI inputs; an IP-literal origin
// avoids DNS.

#include "ConnectionEntry.h"
#include "ConnectionEstablisher.h"
#include "HappyEyeballsConnMgrDelegate.h"
#include "HappyEyeballsConnectionAttempt.h"
#include "HappyEyeballsTransaction.h"
#include "HttpConnectionBase.h"
#include "HttpTrafficAnalyzer.h"
#include "InnerConnectionAttempt.h"
#include "NullHttpTransaction.h"
#include "PendingTransactionInfo.h"
#include "ZeroRttHandle.h"
#include "gtest/gtest.h"
#include "mozilla/Preferences.h"
#include "mozilla/net/ClassOfService.h"
#include "mozilla/net/DNS.h"
#include "nsHttpConnection.h"
#include "nsHttpConnectionInfo.h"
#include "nsHttpRequestHead.h"
#include "nsHttpResponseHead.h"
#include "nsHttpTransaction.h"
#include "nsIHttpProtocolHandler.h"
#include "nsIProtocolProxyService.h"
#include "nsISeekableStream.h"
#include "nsISocketTransportService.h"
#include "nsNetAddr.h"
#include "nsProxyInfo.h"
#include "nsServiceManagerUtils.h"
#include "nsSocketTransportService2.h"
#include "nsThreadUtils.h"

namespace mozilla {
namespace net {

static already_AddRefed<nsHttpTransaction> MakeRealTransaction(
    nsHttpConnectionInfo* aCi, nsHttpRequestHead* aReqHead);

namespace {

// Minimal HttpConnectionBase: trivial pure-virtual bodies plus a few knobs
// (UsingSpdy/UsingHttp3, Activate result) the success path reads.
class FakeHttpConnection : public HttpConnectionBase {
 public:
  NS_DECL_THREADSAFE_ISUPPORTS

  explicit FakeHttpConnection(bool aUsingHttp3, bool aUsingSpdy)
      : mUsingHttp3(aUsingHttp3), mUsingSpdy(aUsingSpdy) {}

  bool UsingSpdy() override { return mUsingSpdy; }
  bool UsingHttp3() override { return mUsingHttp3; }

  [[nodiscard]] nsresult Activate(nsAHttpTransaction*, uint32_t,
                                  int32_t) override {
    return NS_OK;
  }
  void Close(nsresult, bool) override {}
  bool CanReuse() override { return mCanReuse; }
  bool CanDirectlyActivate() override { return false; }
  void DontReuse() override {}
  nsAHttpTransaction* Transaction() override { return nullptr; }
  void CloseTransaction(nsAHttpTransaction*, nsresult, bool) override {}
  [[nodiscard]] nsresult OnHeadersAvailable(nsAHttpTransaction*,
                                            nsHttpRequestHead*,
                                            nsHttpResponseHead*,
                                            bool*) override {
    return NS_OK;
  }
  [[nodiscard]] nsresult TakeTransport(nsISocketTransport**,
                                       nsIAsyncInputStream**,
                                       nsIAsyncOutputStream**) override {
    return NS_ERROR_NOT_IMPLEMENTED;
  }
  void PrintDiagnostics(nsCString&) override {}
  bool TestJoinConnection(const nsACString&, int32_t) override { return false; }
  bool JoinConnection(const nsACString&, int32_t) override { return false; }
  void GetTLSSocketControl(nsITLSSocketControl** aResult) override {
    *aResult = nullptr;
  }
  [[nodiscard]] nsresult ResumeSend() override { return NS_OK; }
  [[nodiscard]] nsresult ResumeRecv() override { return NS_OK; }
  [[nodiscard]] nsresult ForceSend() override { return NS_OK; }
  [[nodiscard]] nsresult ForceRecv() override { return NS_OK; }
  HttpVersion Version() override {
    return mUsingHttp3 ? HttpVersion::v3_0
                       : (mUsingSpdy ? HttpVersion::v2_0 : HttpVersion::v1_1);
  }
  bool LastTransactionExpectedNoContent() override { return false; }
  void SetLastTransactionExpectedNoContent(bool) override {}
  int64_t BytesWritten() override { return 0; }
  bool IsPersistent() override { return true; }
  bool IsReused() override { return false; }
  [[nodiscard]] nsresult PushBack(const char*, uint32_t) override {
    return NS_ERROR_NOT_IMPLEMENTED;
  }
  void SetEvent(nsresult) override {}
  nsresult GetSelfAddr(NetAddr* aAddr) override {
    *aAddr = NetAddr();
    return NS_OK;
  }
  nsresult GetPeerAddr(NetAddr* aAddr) override {
    *aAddr = NetAddr();
    return NS_OK;
  }
  bool ResolvedByTRR() override { return false; }
  nsIRequest::TRRMode EffectiveTRRMode() override {
    return nsIRequest::TRR_DEFAULT_MODE;
  }
  TRRSkippedReason TRRSkipReason() override {
    return nsITRRSkipReason::TRR_UNSET;
  }
  bool GetEchConfigUsed() override { return false; }
  PRIntervalTime LastWriteTime() override { return 0; }
  [[nodiscard]] nsresult CreateTunnelStream(nsAHttpTransaction*,
                                            HttpConnectionBase**,
                                            bool) override {
    return NS_ERROR_NOT_IMPLEMENTED;
  }

  bool mCanReuse = false;

 protected:
  virtual ~FakeHttpConnection() = default;

 private:
  bool mUsingHttp3;
  bool mUsingSpdy;
};

NS_IMPL_ISUPPORTS(FakeHttpConnection, nsISupportsWeakReference)

// Establisher that captures the completion callback instead of opening a
// socket. The test fires the result whenever it wants.
class FakeConnectionEstablisher final : public ConnectionEstablisher {
 public:
  NS_INLINE_DECL_REFCOUNTING_INHERITED(FakeConnectionEstablisher,
                                       ConnectionEstablisher)

  FakeConnectionEstablisher(nsHttpConnectionInfo* aConnInfo,
                            const EndpointTarget& aTarget, uint32_t aCaps,
                            bool aIsUDP, bool aAllow1918,
                            bool aForceRefuseLocal)
      : ConnectionEstablisher(aConnInfo, aTarget, aCaps, aAllow1918),
        mIsUDP(aIsUDP),
        mForceRefuseLocal(aForceRefuseLocal) {}

  bool Start(DoneCallback&& aCallback) override {
    mCallback = std::move(aCallback);
    // Mirror the real establishers: refuse a local peer when !mAllow1918.
    // mForceRefuseLocal lets a test simulate a refusal made while speculative
    // even after Claim() flipped allow1918 to true.
    if (mForceRefuseLocal && !IsByName() && Addr().IsIPAddrLocal()) {
      mRefusedForLocalAddress = true;
      return false;
    }
    if (RefuseIfLocalAddress()) {
      return false;
    }
    return true;
  }
  void Close(nsresult) override { ++mCloseCount; }
  void ResetSpeculativeFlags() override {}
  bool IsUDP() const override { return mIsUDP; }

  void FireSuccess(HttpConnectionBase* aConn) {
    mResultConn = aConn;
    mCallback(RefPtr<HttpConnectionBase>(aConn));
  }
  void FireError(nsresult aError) { mCallback(Err(aError)); }

  uint32_t mCloseCount = 0;

 private:
  ~FakeConnectionEstablisher() = default;
  void Finish(nsresult) override {}
  bool mIsUDP;
  bool mForceRefuseLocal;
};

class FakeConnectionEstablisherFactory final
    : public ConnectionEstablisherFactory {
 public:
  already_AddRefed<ConnectionEstablisher> Create(
      ConnectionEstablisherType aType, nsHttpConnectionInfo* aConnInfo,
      const EndpointTarget& aTarget, uint32_t aCaps, bool,
      bool aAllow1918) override {
    bool isUDP = aType == ConnectionEstablisherType::UDP;
    RefPtr<FakeConnectionEstablisher> e = new FakeConnectionEstablisher(
        aConnInfo, aTarget, aCaps, isUDP, aAllow1918, mForceRefuseLocal);
    (isUDP ? mUDP : mTCP).AppendElement(e);
    return e.forget();
  }

  nsTArray<RefPtr<FakeConnectionEstablisher>> mTCP;
  nsTArray<RefPtr<FakeConnectionEstablisher>> mUDP;
  // When set, created establishers refuse a local peer even if allow1918 is
  // true, to simulate a refusal made while the attempt was still speculative.
  bool mForceRefuseLocal = false;
};

class RecordingConnMgrDelegate final : public HappyEyeballsConnMgrDelegate {
 public:
  already_AddRefed<PendingTransactionInfo> FindTransaction(
      bool, ConnectionEntry*, nsAHttpTransaction*) override {
    mCalls.AppendElement("FindTransaction"_ns);
    return do_AddRef(mFindResult);
  }
  nsresult DispatchTransaction(ConnectionEntry*, nsHttpTransaction* aTrans,
                               HttpConnectionBase* aConn) override {
    mCalls.AppendElement("DispatchTransaction"_ns);
    // Like the real ConnMgr, bind the transaction to the connection. Keep the
    // handle so the test can Reset it before teardown (~ConnectionHandle would
    // otherwise reclaim the fake connection and crash).
    if (mSimulateDispatchBindsConnection && aTrans && aConn) {
      RefPtr<ConnectionHandle> handle = new ConnectionHandle(aConn);
      aTrans->SetConnection(handle);
      mDispatchHandles.AppendElement(handle);
    }
    return mDispatchRv;
  }
  void AddTransaction(nsHttpTransaction*, int32_t) override {
    mCalls.AppendElement("AddTransaction"_ns);
  }
  void ReportSpdyConnection(HttpConnectionBase*, bool, bool,
                            ConnectionEntry*) override {
    mCalls.AppendElement("ReportSpdyConnection"_ns);
  }
  void ReportHttp3Connection(HttpConnectionBase*, ConnectionEntry*) override {
    mCalls.AppendElement("ReportHttp3Connection"_ns);
  }
  void ReclaimConnection(HttpConnectionBase*) override {
    mCalls.AppendElement("ReclaimConnection"_ns);
  }
  void ProcessSpdyPendingQ(ConnectionEntry*) override {
    mCalls.AppendElement("ProcessSpdyPendingQ"_ns);
  }
  already_AddRefed<ConnectionEntry> HandOffHttp3OnlyConnection(
      HttpConnectionBase*, ConnectionEntry*) override {
    mCalls.AppendElement("HandOffHttp3OnlyConnection"_ns);
    return nullptr;
  }
  void InsertIntoActiveConns(ConnectionEntry*, HttpConnectionBase*) override {
    mCalls.AppendElement("InsertIntoActiveConns"_ns);
  }
  void RemoveConnectionAttempt(ConnectionEntry*, ConnectionAttempt*,
                               bool) override {
    mCalls.AppendElement("RemoveConnectionAttempt"_ns);
  }
  void RecordIPFamilyPreference(ConnectionEntry*, uint16_t) override {
    mCalls.AppendElement("RecordIPFamilyPreference"_ns);
  }
  void ResetIPFamilyPreference(ConnectionEntry*) override {
    mCalls.AppendElement("ResetIPFamilyPreference"_ns);
  }
  bool MaybeProcessCoalescingKeys(ConnectionEntry*, const nsTArray<NetAddr>&,
                                  bool) override {
    mCalls.AppendElement("MaybeProcessCoalescingKeys"_ns);
    return false;
  }
  bool RemoveTransFromPendingQ(ConnectionEntry*, nsHttpTransaction*) override {
    mCalls.AppendElement("RemoveTransFromPendingQ"_ns);
    return false;
  }
  nsresult StartRetry(ConnectionEntry*, nsHttpTransaction*, uint32_t, bool,
                      bool, bool, bool aRetryWithoutTRR) override {
    mCalls.AppendElement(aRetryWithoutTRR ? "StartRetryWithoutTRR"_ns
                                          : "StartRetryForLocalAddress"_ns);
    return mStartRetryRv;
  }

  int32_t Count(const char* aName) const {
    int32_t n = 0;
    for (const auto& s : mCalls) {
      if (s.EqualsASCII(aName)) {
        n++;
      }
    }
    return n;
  }

  // Clear the connection handles created by DispatchTransaction so their
  // destructors don't reclaim the fake connections.
  void ResetHandles() {
    for (auto& handle : mDispatchHandles) {
      handle->Reset();
    }
  }

  nsTArray<nsCString> mCalls;
  RefPtr<PendingTransactionInfo> mFindResult;
  nsresult mDispatchRv = NS_OK;
  nsresult mStartRetryRv = NS_OK;
  bool mSimulateDispatchBindsConnection = false;
  nsTArray<RefPtr<ConnectionHandle>> mDispatchHandles;
};

struct TestHarness {
  RefPtr<nsHttpConnectionInfo> mConnInfo;
  RefPtr<nsAHttpTransaction> mTrans;
  nsTHashSet<ConnectionEntry*> mPendingQSet;
  RefPtr<ConnectionEntry> mEntry;
  RefPtr<FakeConnectionEstablisherFactory> mFactory;
  RefPtr<RecordingConnMgrDelegate> mDelegate;
  RefPtr<HappyEyeballsConnectionAttempt> mHE;

  // aRealTransaction: use a real nsHttpTransaction (QueryHttpTransaction()
  // non-null) for paths that touch the real request; else a
  // NullHttpTransaction.
  explicit TestHarness(uint32_t aCaps = 0, bool aRealTransaction = false,
                       const nsACString& aOrigin = "127.0.0.1"_ns,
                       bool aSpeculative = false, bool aAllow1918 = true) {
    mConnInfo = new nsHttpConnectionInfo(aOrigin, 443, ""_ns, ""_ns, nullptr,
                                         OriginAttributes(),
                                         /*endToEndSSL*/ true);
    if (aRealTransaction) {
      mTrans = new nsHttpTransaction();
    } else {
      mTrans = new NullHttpTransaction(mConnInfo, nullptr, aCaps);
    }
    mEntry = new ConnectionEntry(mConnInfo, mPendingQSet);
    mFactory = new FakeConnectionEstablisherFactory();
    mDelegate = new RecordingConnMgrDelegate();
    mHE = new HappyEyeballsConnectionAttempt(mConnInfo, mTrans, aCaps,
                                             aSpeculative,
                                             /*urgentStart*/ false);
    mHE->SetAllow1918(aAllow1918);
    mHE->SetConnectionEstablisherFactoryForTesting(mFactory);
    mHE->SetConnMgrDelegateForTesting(mDelegate);
  }

  void Init() { mHE->Init(mEntry); }
};

// Ensure gHttpHandler is initialized (the HCA ctor notifies HTTP activity
// through it). Must run on the main thread.
// Runs a CONNECT exchange with no socket underneath: hands the transaction
// canned response bytes and keeps what it writes, so the real
// TunnelSetupTransaction does the parsing.
class TunnelIO final : public nsAHttpSegmentReader,
                       public nsAHttpSegmentWriter {
 public:
  NS_INLINE_DECL_REFCOUNTING(TunnelIO, override)

  // What the transaction wrote (the CONNECT request).
  nsresult OnReadSegment(const char* aSegment, uint32_t aCount,
                         uint32_t* aCountRead) override {
    mRequest.Append(aSegment, aCount);
    *aCountRead = aCount;
    return NS_OK;
  }
  nsresult CommitToSegmentSize(uint32_t, bool) override { return NS_OK; }

  // What the proxy "sent".
  nsresult OnWriteSegment(char* aSegment, uint32_t aCount,
                          uint32_t* aCountWritten) override {
    const uint32_t toCopy =
        std::min<uint32_t>(aCount, mResponse.Length() - mOffset);
    if (!toCopy) {
      *aCountWritten = 0;
      return mWouldBlockWhenDrained ? NS_BASE_STREAM_WOULD_BLOCK : NS_OK;
    }
    memcpy(aSegment, mResponse.BeginReading() + mOffset, toCopy);
    mOffset += toCopy;
    *aCountWritten = toCopy;
    return NS_OK;
  }

  void SetResponse(const nsACString& aResponse) {
    mResponse = aResponse;
    mOffset = 0;
  }
  bool ResponseDrained() const { return mOffset == mResponse.Length(); }

  nsCString mRequest;
  // Like a socket with nothing more to read, once the response is drained.
  bool mWouldBlockWhenDrained = false;

 private:
  ~TunnelIO() = default;

  nsCString mResponse;
  uint32_t mOffset = 0;
};

// The inner connection a mock outer connection hands back. Activate() keeps
// the driver instead of writing to a socket, and the test decides what the
// proxy answers and whether the inner handshake completes.
class MockInnerConnection final : public FakeHttpConnection {
 public:
  NS_INLINE_DECL_REFCOUNTING_INHERITED(MockInnerConnection, FakeHttpConnection)

  MockInnerConnection(nsHttpConnectionInfo* aConnInfo, bool aUsingHttp3)
      : FakeHttpConnection(aUsingHttp3, /*usingSpdy*/ !aUsingHttp3),
        mIO(new TunnelIO()) {
    // The base's, so that a ~ConnectionHandle reclaim has a conn info to look
    // an entry up with instead of dereferencing null.
    mConnInfo = aConnInfo;
  }

  [[nodiscard]] nsresult Activate(nsAHttpTransaction* aTrans, uint32_t,
                                  int32_t) override {
    mDriver = aTrans;
    // What nsHttpConnection does on activation for a tunnel; kept so a test can
    // check the authority the proxy routes on.
    (void)nsHttpConnection::MakeConnectString(
        aTrans, &mConnectHead, mConnectRequest,
        /*aShouldResistFingerprinting*/ false);
    return NS_OK;
  }

  // What nsHttpConnection::HandleTunnelResponse does with a CONNECT reply; a
  // non-200 is what marks the CONNECT failed.
  [[nodiscard]] nsresult OnHeadersAvailable(nsAHttpTransaction* aTrans,
                                            nsHttpRequestHead*,
                                            nsHttpResponseHead* aResponseHead,
                                            bool* aReset) override {
    *aReset = false;
    mConnectStatus = Some(aResponseHead->Status());
    if (aResponseHead->Status() != 200) {
      aTrans->SetProxyConnectFailed();
    }
    aTrans->OnProxyConnectComplete(
        new ProxyConnectResponseHead(*aResponseHead));
    return NS_OK;
  }

  void Close(nsresult aReason, bool) override {
    ++mCloseCount;
    mCloseReason = Some(aReason);
    if (RefPtr<nsAHttpTransaction> driver = mDriver.forget()) {
      driver->Close(aReason);
    }
  }

  // Deliver a CONNECT response, after letting the driver write its request.
  void AnswerConnect(const nsACString& aResponse) {
    MOZ_RELEASE_ASSERT(mDriver, "Activate() should have run");
    uint32_t count = 0;
    (void)mDriver->ReadSegments(mIO, 4096, &count);
    mIO->SetResponse(aResponse);
    nsresult rv = mDriver->WriteSegments(mIO, aResponse.Length(), &count);
    if (NS_FAILED(rv)) {
      // What nsHttpConnection::OnSocketReadable does when the transaction
      // rejects what it read.
      if (RefPtr<nsAHttpTransaction> driver = mDriver.forget()) {
        driver->Close(rv);
      }
    }
  }

  // Closing the driver is the establisher's connected signal, which is what
  // nsHttpConnection does once the inner handshake completes.
  void CompleteHandshake() {
    if (RefPtr<nsAHttpTransaction> driver = mDriver.forget()) {
      driver->Close(NS_OK);
    }
  }

  bool IsHttp3Endpoint() const { return mConnInfo->IsHttp3(); }
  nsHttpConnectionInfo* ConnInfo() const { return mConnInfo; }

  Maybe<nsresult> mCloseReason;
  uint32_t mCloseCount = 0;
  Maybe<uint16_t> mConnectStatus;
  nsCString mConnectRequest;
  RefPtr<TunnelIO> mIO;

 private:
  ~MockInnerConnection() = default;

  nsHttpRequestHead mConnectHead;
  RefPtr<nsAHttpTransaction> mDriver;
};

// Outer connection to the proxy: one MockInnerConnection per leg the machine
// starts, so the real InnerConnectionEstablisher runs.
class MockOuterConnection final : public FakeHttpConnection {
 public:
  NS_INLINE_DECL_REFCOUNTING_INHERITED(MockOuterConnection, FakeHttpConnection)

  explicit MockOuterConnection(bool aUsingHttp3 = false)
      : FakeHttpConnection(aUsingHttp3, /*usingSpdy*/ !aUsingHttp3) {}

  [[nodiscard]] nsresult CreateInnerConnection(
      TunnelSetupTransaction* aDriver,
      HttpConnectionBase** aInnerConnection) override {
    if (NS_FAILED(mCreateResult)) {
      return mCreateResult;
    }
    RefPtr<MockInnerConnection> inner = new MockInnerConnection(
        aDriver->ConnectionInfo(), aDriver->ConnectionInfo()->IsHttp3());
    mInner.AppendElement(inner);
    inner.forget(aInnerConnection);
    return NS_OK;
  }

  nsresult mCreateResult = NS_OK;
  nsTArray<RefPtr<MockInnerConnection>> mInner;

 private:
  ~MockOuterConnection() = default;
};

// Captures the completion callback instead of putting a CONNECT on a tunnel;
// the test fires the outcome it wants.
class FakeInnerConnectionEstablisher final : public InnerConnectionEstablisher {
 public:
  FakeInnerConnectionEstablisher(HttpConnectionBase* aOuterConn,
                                 nsHttpConnectionInfo* aConnInfo,
                                 uint32_t aCaps)
      : InnerConnectionEstablisher(
            aOuterConn, aConnInfo, aCaps,
            TunnelSetupTransaction::RequestHeaderSnapshot{}, nullptr) {}

  void Start(DoneCallback&& aCallback) override {
    mCallback = std::move(aCallback);
  }
  void Close(nsresult aReason) override { mCloseReason = Some(aReason); }
  HttpConnectionBase* ResultConn() const override { return mConn; }
  TunnelSetupTransaction* Transaction() const override { return mDriver; }

  void FireSuccess(HttpConnectionBase* aConn) {
    mConn = aConn;
    DoneCallback callback = std::move(mCallback);
    callback(RefPtr<HttpConnectionBase>{aConn});
  }
  void FireFailure(nsresult aReason) {
    DoneCallback callback = std::move(mCallback);
    callback(Err(aReason));
  }
  // A non-200 CONNECT: the driver keeps the response, which is what the
  // attempt hands to the real transaction.
  // The proxy reset the CONNECT stream with HTTP_1_1_REQUIRED: Http2Session
  // closes the stream with NS_ERROR_NET_RESET after disabling h2 for the proxy
  // on its transaction.
  void FireHttp11Required(nsHttpConnectionInfo* aConnInfo) {
    mDriver = new TunnelSetupTransaction(
        aConnInfo, nullptr, 0, TunnelSetupTransaction::RequestHeaderSnapshot{});
    mDriver->DisableHttp2ForProxy();
    FireFailure(NS_ERROR_NET_RESET);
  }

  void FireRefusal(uint16_t aStatus, nsHttpConnectionInfo* aConnInfo) {
    mDriver = new TunnelSetupTransaction(
        aConnInfo, nullptr, 0, TunnelSetupTransaction::RequestHeaderSnapshot{});
    nsHttpResponseHead head;
    nsAutoCString statusLine;
    statusLine.AppendPrintf("HTTP/1.1 %u Refused", aStatus);
    head.ParseStatusLine(statusLine);
    mDriver->SetProxyConnectFailed();
    mDriver->OnProxyConnectComplete(new ProxyConnectResponseHead(head));
    FireFailure(NS_ERROR_PROXY_CONNECTION_REFUSED);
  }

  Maybe<nsresult> mCloseReason;

 private:
  ~FakeInnerConnectionEstablisher() = default;

  DoneCallback mCallback;
  RefPtr<HttpConnectionBase> mConn;
  RefPtr<TunnelSetupTransaction> mDriver;
};

class FakeInnerConnectionEstablisherFactory final
    : public InnerConnectionEstablisherFactory {
 public:
  already_AddRefed<InnerConnectionEstablisher> Create(
      HttpConnectionBase* aOuterConn, nsHttpConnectionInfo* aInnerConnInfo,
      uint32_t aCaps, TunnelSetupTransaction::RequestHeaderSnapshot&&,
      nsIInterfaceRequestor*) override {
    RefPtr<FakeInnerConnectionEstablisher> establisher =
        new FakeInnerConnectionEstablisher(aOuterConn, aInnerConnInfo, aCaps);
    mEstablishers.AppendElement(establisher);
    mConnInfos.AppendElement(aInnerConnInfo);
    return establisher.forget();
  }

  nsTArray<RefPtr<FakeInnerConnectionEstablisher>> mEstablishers;
  // What each establisher was asked to connect to, in the same order.
  nsTArray<RefPtr<nsHttpConnectionInfo>> mConnInfos;
};

// A real entry and transaction, a fake outer connection, both seams injected.
struct InnerTestHarness {
  // aRealEstablisher runs the production establisher against a
  // MockOuterConnection, so the CONNECT exchange and its parsing are real;
  // otherwise establishers are faked outright.
  explicit InnerTestHarness(nsProxyInfo* aProxyInfo, bool aHttp3Origin = false,
                            bool aRealEstablisher = false,
                            const nsACString& aHost = "example.com"_ns) {
    nsHttpConnectionInfo* raw = new nsHttpConnectionInfo(
        aHost, 443, ""_ns, ""_ns, aProxyInfo, OriginAttributes(),
        /*endToEndSSL*/ true, aHttp3Origin, /*aWebTransport*/ false);
    mCi = raw;
    MOZ_RELEASE_ASSERT(mCi->UsingConnect());
    mEntry = new ConnectionEntry(mCi, mPendingQSet);
    mTrans = MakeRealTransaction(mCi, &mReqHead);
    mPending = new PendingTransactionInfo(mTrans);
    mDelegate = new RecordingConnMgrDelegate();
    if (aRealEstablisher) {
      // An h3 inner connection needs an h3 outer one: pairing an h3 inner conn
      // info with an h2 proxy connection is what CreateHappyEyeballs refuses.
      mOuter = new MockOuterConnection(/*usingHttp3*/ aHttp3Origin);
      mOuterConn = mOuter;
    } else {
      mOuterConn = new FakeHttpConnection(/*usingHttp3*/ false,
                                          /*usingSpdy*/ true);
      mFactory = new FakeInnerConnectionEstablisherFactory();
    }
    // An outer connection the manager just handed out is a live one.
    mOuterConn->mCanReuse = true;
    mAttempt = new InnerConnectionAttempt(mCi, mTrans, /*caps*/ 0, mOuterConn);
    mAttempt->SetConnMgrDelegateForTesting(mDelegate);
    if (mFactory) {
      mAttempt->SetEstablisherFactoryForTesting(mFactory);
    }
  }

  // The inner connections the outer connection was asked to create, one per
  // endpoint the machine started.
  nsTArray<RefPtr<MockInnerConnection>>& InnerConns() {
    MOZ_RELEASE_ASSERT(mOuter);
    return mOuter->mInner;
  }

  nsresult Init() { return mAttempt->Init(mEntry); }

  // The establisher reports its result through a dispatched runnable, so let
  // that run before asserting.
  void Drain() { NS_ProcessPendingEvents(NS_GetCurrentThread()); }

  nsTHashSet<ConnectionEntry*> mPendingQSet;
  RefPtr<nsHttpConnectionInfo> mCi;
  RefPtr<ConnectionEntry> mEntry;
  nsHttpRequestHead mReqHead;
  RefPtr<nsHttpTransaction> mTrans;
  RefPtr<PendingTransactionInfo> mPending;
  RefPtr<FakeHttpConnection> mOuterConn;
  RefPtr<MockOuterConnection> mOuter;
  RefPtr<RecordingConnMgrDelegate> mDelegate;
  RefPtr<FakeInnerConnectionEstablisherFactory> mFactory;
  RefPtr<InnerConnectionAttempt> mAttempt;
};

// An inner connection is an origin reached through a CONNECT proxy, so the
// conn info needs one: UsingConnect() gates the paths InnerConnectionAttempt
// drives. Must run on the main thread, the proxy service reading prefs.
static already_AddRefed<nsProxyInfo> MakeConnectProxyInfo() {
  nsCOMPtr<nsIProtocolProxyService> pps =
      do_GetService(NS_PROTOCOLPROXYSERVICE_CONTRACTID);
  if (!pps) {
    return nullptr;
  }
  nsCOMPtr<nsIProxyInfo> pi;
  if (NS_FAILED(pps->NewProxyInfo("https"_ns, "proxy.example.com"_ns, 3128,
                                  ""_ns, ""_ns, 0, UINT32_MAX, nullptr,
                                  getter_AddRefs(pi)))) {
    return nullptr;
  }
  nsCOMPtr<nsProxyInfo> proxyInfo = do_QueryInterface(pi);
  return proxyInfo.forget();
}

static void EnsureHttpHandler() {
  nsCOMPtr<nsIHttpProtocolHandler> http =
      do_GetService("@mozilla.org/network/protocol;1?name=http");
  ASSERT_TRUE(http);
}

// Run `aFn` on the socket thread and block until it completes.
static void RunOnSocketThread(std::function<void()>&& aFn) {
  nsCOMPtr<nsIEventTarget> sts = gSocketTransportService;
  ASSERT_TRUE(sts);
  NS_DispatchAndSpinEventLoopUntilComplete(
      "TestHappyEyeballs"_ns, sts,
      NS_NewRunnableFunction("TestHappyEyeballs", std::move(aFn)));
}

}  // namespace

// Init() with an IP-literal origin should drive the engine to attempt a
// connection through the injected factory rather than opening a real socket.
TEST(HappyEyeballsConnectionAttempt, FactorySeamUsed)
{
  EnsureHttpHandler();
  RunOnSocketThread([]() {
    TestHarness h;
    h.Init();
    EXPECT_GE(h.mFactory->mTCP.Length(), 1u)
        << "engine should have requested a TCP establisher via the factory";
    EXPECT_EQ(h.mFactory->mUDP.Length(), 0u);
    h.mHE->Abandon();
  });
}

// Firing a successful TCP connection runs Succeeded -> EnterSucceeded ->
// ProcessTCPConn, which dispatches the pending real transaction onto the
// winning connection through the delegate.
TEST(HappyEyeballsConnectionAttempt, TcpSuccessRunsDispatchViaDelegate)
{
  EnsureHttpHandler();
  RunOnSocketThread([]() {
    TestHarness h(/*caps*/ 0, /*realTransaction*/ true);
    nsHttpTransaction* realTrans = h.mTrans->QueryHttpTransaction();
    ASSERT_TRUE(realTrans);
    // The pending-queue lookup returns the real transaction so ProcessTCPConn
    // dispatches it rather than reclaiming the connection.
    h.mDelegate->mFindResult = new PendingTransactionInfo(realTrans);
    h.Init();
    ASSERT_GE(h.mFactory->mTCP.Length(), 1u);

    RefPtr<FakeHttpConnection> conn =
        new FakeHttpConnection(/*usingHttp3*/ false, /*usingSpdy*/ false);
    h.mFactory->mTCP[0]->FireSuccess(conn);

    EXPECT_TRUE(h.mHE->IsTerminal());
    EXPECT_EQ(h.mDelegate->Count("RecordIPFamilyPreference"), 1);
    EXPECT_EQ(h.mDelegate->Count("InsertIntoActiveConns"), 1);
    EXPECT_EQ(h.mDelegate->Count("FindTransaction"), 1);
    EXPECT_EQ(h.mDelegate->Count("DispatchTransaction"), 1)
        << "the pending transaction should be dispatched onto the connection";
    EXPECT_TRUE(h.mHE->WasTransactionAdoptedForTesting());
    EXPECT_EQ(h.mDelegate->Count("ReportSpdyConnection"), 1);
  });
}

// A failing connection result (the only address) drives the engine to Failed
// and EnterFailed, which removes the attempt and never dispatches.
TEST(HappyEyeballsConnectionAttempt, TcpFailureDoesNotDispatch)
{
  EnsureHttpHandler();
  RunOnSocketThread([]() {
    TestHarness h;
    h.Init();
    ASSERT_GE(h.mFactory->mTCP.Length(), 1u);

    h.mFactory->mTCP[0]->FireError(NS_ERROR_CONNECTION_REFUSED);

    EXPECT_TRUE(h.mHE->IsTerminal());
    EXPECT_EQ(h.mDelegate->Count("DispatchTransaction"), 0);
    EXPECT_EQ(h.mDelegate->Count("InsertIntoActiveConns"), 0);
    EXPECT_GE(h.mDelegate->Count("RemoveConnectionAttempt"), 1);
  });
}

// A speculative attempt to a local peer refuses it synchronously instead of
// opening a socket, and -- being unclaimed -- fails without retrying.
TEST(HappyEyeballsConnectionAttempt, SpeculativeRefusesLocalAddress)
{
  EnsureHttpHandler();
  RunOnSocketThread([]() {
    TestHarness h(/*caps*/ 0, /*realTransaction*/ false, "10.0.0.2"_ns,
                  /*speculative*/ true, /*allow1918*/ false);
    h.Init();

    // The engine still asks the factory for a TCP establisher for the local
    // address, but Start() refuses it instead of connecting.
    ASSERT_GE(h.mFactory->mTCP.Length(), 1u);
    EXPECT_TRUE(h.mFactory->mTCP[0]->RefusedForLocalAddress())
        << "a speculative establisher must refuse a local peer";

    EXPECT_TRUE(h.mHE->IsTerminal());
    EXPECT_EQ(h.mDelegate->Count("DispatchTransaction"), 0);
    // Unclaimed speculative attempt: no real transaction, so no retry.
    EXPECT_EQ(h.mDelegate->Count("StartRetryForLocalAddress"), 0);
    EXPECT_GE(h.mDelegate->Count("RemoveConnectionAttempt"), 1);
  });
}

// Once a speculative attempt that refused a local peer is claimed by a real
// transaction, the terminal failure starts a fresh attempt via the delegate.
TEST(HappyEyeballsConnectionAttempt, ClaimedLocalAttemptRetries)
{
  EnsureHttpHandler();
  RunOnSocketThread([]() {
    // A speculative attempt (null transaction, allow1918=false) to a local
    // origin.
    TestHarness h(/*caps*/ 0, /*realTransaction*/ false, "10.0.0.2"_ns,
                  /*speculative*/ true, /*allow1918*/ false);
    // Simulate the local refusal the speculative attempt made even though the
    // claim below flips allow1918 to true.
    h.mFactory->mForceRefuseLocal = true;

    // A real transaction claims the speculative attempt.
    RefPtr<nsHttpTransaction> realTrans = new nsHttpTransaction();
    EXPECT_TRUE(h.mHE->Claim(realTrans));

    h.Init();

    ASSERT_GE(h.mFactory->mTCP.Length(), 1u);
    EXPECT_TRUE(h.mFactory->mTCP[0]->RefusedForLocalAddress());
    EXPECT_TRUE(h.mHE->IsTerminal());
    EXPECT_EQ(h.mDelegate->Count("StartRetryForLocalAddress"), 1)
        << "a claimed attempt whose only failures were local refusals must "
           "retry via the delegate";
  });
}

// 0-RTT started but no winner, then a non-0-RTT conn wins. EnterSucceeded's
// fallback (AnyStarted && !HadWinner) must re-queue the real transaction once
// and not mark it adopted. Uses the ZeroRttHandle seam to set AnyStarted.
TEST(HappyEyeballsConnectionAttempt, ZeroRttNoWinnerFallback)
{
  EnsureHttpHandler();
  RunOnSocketThread([]() {
    TestHarness h(/*caps*/ 0, /*realTransaction*/ true);
    h.Init();
    ASSERT_GE(h.mFactory->mTCP.Length(), 1u);

    // A racer entered 0-RTT but never became the winner.
    h.mHE->ZeroRttHandleForTesting()->SetAnyStartedForTesting();

    RefPtr<FakeHttpConnection> conn =
        new FakeHttpConnection(/*usingHttp3*/ false, /*usingSpdy*/ false);
    h.mFactory->mTCP[0]->FireSuccess(conn);

    EXPECT_TRUE(h.mHE->IsTerminal());
    EXPECT_EQ(h.mDelegate->Count("AddTransaction"), 1)
        << "fallback should re-queue the real transaction once";
    EXPECT_EQ(h.mDelegate->Count("DispatchTransaction"), 0);
    EXPECT_FALSE(h.mHE->WasTransactionAdoptedForTesting());
  });
}

// ReleaseRealTransaction guard (bug 2048392), real-world race: two HCAs race
// one transaction. The winner dispatches it onto its connection; the loser's
// attempt then fails and runs ReleaseRealTransaction. Since the transaction is
// already on the winner's connection, the loser must not close it or remove it
// from the pending queue.
TEST(HappyEyeballsConnectionAttempt,
     ReleaseRealTransactionSkipsCloseWhenConnected)
{
  EnsureHttpHandler();
  RunOnSocketThread([]() {
    RefPtr<nsHttpConnectionInfo> ci =
        new nsHttpConnectionInfo("127.0.0.1"_ns, 443, ""_ns, ""_ns, nullptr,
                                 OriginAttributes(), /*endToEndSSL*/ true);
    RefPtr<nsHttpTransaction> realTrans = new nsHttpTransaction();
    nsTHashSet<ConnectionEntry*> pendingQSet;

    // --- HCA #1: wins and dispatches the shared transaction. ---
    RefPtr<ConnectionEntry> entry1 = new ConnectionEntry(ci, pendingQSet);
    RefPtr<FakeConnectionEstablisherFactory> factory1 =
        new FakeConnectionEstablisherFactory();
    RefPtr<RecordingConnMgrDelegate> delegate1 = new RecordingConnMgrDelegate();
    // Winner's dispatch binds the transaction to its connection.
    delegate1->mSimulateDispatchBindsConnection = true;
    delegate1->mFindResult = new PendingTransactionInfo(realTrans);
    RefPtr<HappyEyeballsConnectionAttempt> hca1 =
        new HappyEyeballsConnectionAttempt(ci, realTrans, /*caps*/ 0,
                                           /*speculative*/ false,
                                           /*urgentStart*/ false);
    hca1->SetConnectionEstablisherFactoryForTesting(factory1);
    hca1->SetConnMgrDelegateForTesting(delegate1);
    hca1->Init(entry1);
    ASSERT_GE(factory1->mTCP.Length(), 1u);

    RefPtr<FakeHttpConnection> conn1 =
        new FakeHttpConnection(/*usingHttp3*/ false, /*usingSpdy*/ false);
    factory1->mTCP[0]->FireSuccess(conn1);
    ASSERT_TRUE(hca1->WasTransactionAdoptedForTesting());
    ASSERT_NE(realTrans->Connection(), nullptr)
        << "the winning attempt should have bound the transaction to its conn";

    // --- HCA #2: races the same transaction and fails. ---
    RefPtr<ConnectionEntry> entry2 = new ConnectionEntry(ci, pendingQSet);
    RefPtr<FakeConnectionEstablisherFactory> factory2 =
        new FakeConnectionEstablisherFactory();
    RefPtr<RecordingConnMgrDelegate> delegate2 = new RecordingConnMgrDelegate();
    RefPtr<HappyEyeballsConnectionAttempt> hca2 =
        new HappyEyeballsConnectionAttempt(ci, realTrans, /*caps*/ 0,
                                           /*speculative*/ false,
                                           /*urgentStart*/ false);
    hca2->SetConnectionEstablisherFactoryForTesting(factory2);
    hca2->SetConnMgrDelegateForTesting(delegate2);
    hca2->Init(entry2);
    ASSERT_GE(factory2->mTCP.Length(), 1u);

    factory2->mTCP[0]->FireError(NS_ERROR_CONNECTION_REFUSED);

    EXPECT_TRUE(hca2->IsTerminal());
    EXPECT_FALSE(realTrans->Closed())
        << "the loser must not close a transaction already on the winner conn";
    EXPECT_EQ(delegate2->Count("RemoveTransFromPendingQ"), 0)
        << "guard returns before touching the pending queue";
    EXPECT_EQ(hca2->RealHttpTransaction(), nullptr)
        << "the loser drops its reference to the real transaction";

    // Teardown: detach the connection and reset the handle the winner's
    // dispatch created so ~ConnectionHandle doesn't reclaim the fake conn.
    realTrans->SetConnection(nullptr);
    delegate1->ResetHandles();
  });
}

// ProcessTCPConn guard (bug 2048294), real-world race: a WebSocket/WebTransport
// upgrade is raced by two HCAs. The first wins and dispatches it (Connection()
// set). The second wins an H2 connection, whose ProcessTCPConn would normally
// re-queue the upgrade for the extended CONNECT tunnel; but since it's already
// on a connection it must NOT re-queue (re-dispatch would hit a transport-less
// connection and crash in Activate).
TEST(HappyEyeballsConnectionAttempt, ProcessTCPConnSkipsRequeueWhenConnected)
{
  EnsureHttpHandler();
  RunOnSocketThread([]() {
    RefPtr<nsHttpConnectionInfo> ci =
        new nsHttpConnectionInfo("127.0.0.1"_ns, 443, ""_ns, ""_ns, nullptr,
                                 OriginAttributes(), /*endToEndSSL*/ true);
    RefPtr<nsHttpTransaction> realTrans = new nsHttpTransaction();
    // Makes deferExtendedConnect fire on an H2 connection.
    realTrans->SetIsForWebTransport(true);
    nsTHashSet<ConnectionEntry*> pendingQSet;

    // --- HCA #1: wins on H1 and dispatches the shared transaction. ---
    RefPtr<ConnectionEntry> entry1 = new ConnectionEntry(ci, pendingQSet);
    RefPtr<FakeConnectionEstablisherFactory> factory1 =
        new FakeConnectionEstablisherFactory();
    RefPtr<RecordingConnMgrDelegate> delegate1 = new RecordingConnMgrDelegate();
    delegate1->mSimulateDispatchBindsConnection = true;
    delegate1->mFindResult = new PendingTransactionInfo(realTrans);
    RefPtr<HappyEyeballsConnectionAttempt> hca1 =
        new HappyEyeballsConnectionAttempt(ci, realTrans, /*caps*/ 0,
                                           /*speculative*/ false,
                                           /*urgentStart*/ false);
    hca1->SetConnectionEstablisherFactoryForTesting(factory1);
    hca1->SetConnMgrDelegateForTesting(delegate1);
    hca1->Init(entry1);
    ASSERT_GE(factory1->mTCP.Length(), 1u);
    RefPtr<FakeHttpConnection> conn1 =
        new FakeHttpConnection(/*usingHttp3*/ false, /*usingSpdy*/ false);
    factory1->mTCP[0]->FireSuccess(conn1);
    ASSERT_NE(realTrans->Connection(), nullptr);

    // --- HCA #2: wins on H2; deferExtendedConnect must skip the re-queue. ---
    RefPtr<ConnectionEntry> entry2 = new ConnectionEntry(ci, pendingQSet);
    RefPtr<FakeConnectionEstablisherFactory> factory2 =
        new FakeConnectionEstablisherFactory();
    RefPtr<RecordingConnMgrDelegate> delegate2 = new RecordingConnMgrDelegate();
    RefPtr<HappyEyeballsConnectionAttempt> hca2 =
        new HappyEyeballsConnectionAttempt(ci, realTrans, /*caps*/ 0,
                                           /*speculative*/ false,
                                           /*urgentStart*/ false);
    hca2->SetConnectionEstablisherFactoryForTesting(factory2);
    hca2->SetConnMgrDelegateForTesting(delegate2);
    hca2->Init(entry2);
    ASSERT_GE(factory2->mTCP.Length(), 1u);
    RefPtr<FakeHttpConnection> conn2 =
        new FakeHttpConnection(/*usingHttp3*/ false, /*usingSpdy*/ true);
    factory2->mTCP[0]->FireSuccess(conn2);

    EXPECT_TRUE(hca2->IsTerminal());
    EXPECT_EQ(delegate2->Count("AddTransaction"), 0)
        << "must not re-queue a transaction already on a connection";
    EXPECT_EQ(delegate2->Count("FindTransaction"), 0)
        << "guard returns before touching the pending queue";
    EXPECT_FALSE(realTrans->Closed());
    EXPECT_EQ(hca2->RealHttpTransaction(), nullptr)
        << "deferExtendedConnect clears the loser's transaction reference";

    realTrans->SetConnection(nullptr);
    delegate1->ResetHandles();
  });
}

// Bug 2051415: on H2->H1 fallback the connection manager abandons the stale
// in-flight attempt. Verifies the property the fix relies on: Abandon() closes
// the establisher, so a late success can't fire and re-queue the transaction.
TEST(HappyEyeballsConnectionAttempt, AbandonClosesInFlightEstablisher)
{
  EnsureHttpHandler();
  RunOnSocketThread([]() {
    RefPtr<nsHttpConnectionInfo> ci =
        new nsHttpConnectionInfo("127.0.0.1"_ns, 443, ""_ns, ""_ns, nullptr,
                                 OriginAttributes(), /*endToEndSSL*/ true);
    RefPtr<nsHttpTransaction> realTrans = new nsHttpTransaction();
    // Stand-in for the WebSocket upgrade.
    realTrans->SetIsForWebTransport(true);
    nsTHashSet<ConnectionEntry*> pendingQSet;

    RefPtr<ConnectionEntry> entry = new ConnectionEntry(ci, pendingQSet);
    RefPtr<FakeConnectionEstablisherFactory> factory =
        new FakeConnectionEstablisherFactory();
    RefPtr<RecordingConnMgrDelegate> delegate = new RecordingConnMgrDelegate();
    RefPtr<HappyEyeballsConnectionAttempt> hca =
        new HappyEyeballsConnectionAttempt(ci, realTrans, /*caps*/ 0,
                                           /*speculative*/ false,
                                           /*urgentStart*/ false);
    hca->SetConnectionEstablisherFactoryForTesting(factory);
    hca->SetConnMgrDelegateForTesting(delegate);
    hca->Init(entry);
    ASSERT_GE(factory->mTCP.Length(), 1u);
    EXPECT_FALSE(hca->IsTerminal());
    EXPECT_EQ(factory->mTCP[0]->mCloseCount, 0u)
        << "the establisher is still in flight before abandonment";

    // The connection manager abandons the stale attempt on H2->H1 fallback.
    hca->Abandon();

    EXPECT_TRUE(hca->IsTerminal())
        << "an abandoned attempt is terminal and cannot reach ProcessTCPConn";
    EXPECT_EQ(factory->mTCP[0]->mCloseCount, 1u)
        << "abandoning closes the in-flight establisher, so a late success "
           "can't fire and re-queue the restarted transaction (bug 2051415)";
    EXPECT_FALSE(realTrans->Closed())
        << "abandoning the attempt must not close the restarted transaction";
  });
}

// Bug 2051415, 0-RTT corner. The manager detaches the transaction
// (ForgetRealTransaction) before abandoning, so EnterDone's "0-RTT started, no
// winner" path can't re-queue it (cf. ZeroRttNoWinnerFallback, which does).
TEST(HappyEyeballsConnectionAttempt,
     ForgetRealTransactionPreventsAbandonRequeue)
{
  EnsureHttpHandler();
  RunOnSocketThread([]() {
    TestHarness h(/*caps*/ 0, /*realTransaction*/ true);
    h.Init();
    ASSERT_GE(h.mFactory->mTCP.Length(), 1u);

    // A racer entered 0-RTT but never won -- the case EnterDone re-queues.
    h.mHE->ZeroRttHandleForTesting()->SetAnyStartedForTesting();

    // Manager takes over the transaction, detaching it before abandoning.
    h.mHE->ForgetRealTransaction();
    h.mHE->Abandon();

    EXPECT_TRUE(h.mHE->IsTerminal());
    EXPECT_EQ(h.mDelegate->Count("AddTransaction"), 0)
        << "a detached, abandoned attempt must not re-queue the transaction "
           "the connection manager is restarting (bug 2051415)";
    EXPECT_EQ(h.mFactory->mTCP[0]->mCloseCount, 1u)
        << "abandoning still closes the in-flight establisher";
  });
}

// 0-RTT winner-offset handling: several racers each advance the real
// transaction's request stream to a different Request0RttStreamOffset (the
// bytes that racer sent as early data). When one wins via Finish0RTT(accept),
// ZeroRttHandle must seek the real request stream to the *winner's* offset (so
// the real transaction resumes exactly where the winner left off) — not the
// loser's.
TEST(HappyEyeballsConnectionAttempt, ZeroRttWinnerUsesItsOwnStreamOffset)
{
  EnsureHttpHandler();
  RunOnSocketThread([]() {
    RefPtr<nsHttpConnectionInfo> ci =
        new nsHttpConnectionInfo("127.0.0.1"_ns, 443, ""_ns, ""_ns, nullptr,
                                 OriginAttributes(), /*endToEndSSL*/ true);

    // The request head is held by weak reference inside the transaction, so it
    // must outlive realTrans (declared first).
    nsHttpRequestHead reqHead;
    reqHead.SetMethod("GET"_ns);
    reqHead.SetVersion(HttpVersion::v1_1);
    reqHead.SetRequestURI("/"_ns);

    RefPtr<nsHttpTransaction> realTrans = new nsHttpTransaction();
    nsresult rv = realTrans->Init(
        NS_HTTP_USE_HAPPY_EYEBALLS, ci, &reqHead, /*reqBody*/ nullptr,
        /*reqContentLength*/ 0,
        /*target*/ gSocketTransportService, /*callbacks*/ nullptr,
        /*eventsink*/ nullptr, /*browserId*/ 0, HttpTrafficCategory::eInvalid,
        /*requestContext*/ nullptr, ClassOfService(), /*initialRwin*/ 0,
        /*responseTimeoutEnabled*/ false, /*channelId*/ 0,
        nsILoadInfo::IPAddressSpace::Unknown, LNAPerms{});
    ASSERT_TRUE(NS_SUCCEEDED(rv));

    // The serialized GET request is the (seekable) request stream; pick two
    // distinct in-range offsets for the winning and losing racers.
    nsCOMPtr<nsISeekableStream> seekable =
        do_QueryInterface(realTrans->RequestStream());
    ASSERT_TRUE(seekable);
    ASSERT_TRUE(
        NS_SUCCEEDED(seekable->Seek(nsISeekableStream::NS_SEEK_SET, 0)));
    uint64_t streamLen = 0;
    ASSERT_TRUE(
        NS_SUCCEEDED(realTrans->RequestStream()->Available(&streamLen)));
    ASSERT_GE(streamLen, 4u);
    uint64_t winnerOffset = streamLen / 4;
    uint64_t loserOffset = streamLen / 2;
    ASSERT_NE(winnerOffset, loserOffset);

    RefPtr<HappyEyeballsConnectionAttempt> hca =
        new HappyEyeballsConnectionAttempt(ci, realTrans, /*caps*/ 0,
                                           /*speculative*/ false,
                                           /*urgentStart*/ false);
    ZeroRttHandle* zrh = hca->ZeroRttHandleForTesting();
    ASSERT_TRUE(zrh);

    auto noStatus = [](nsITransport*, nsresult, int64_t) {};
    auto noAuth = []() {};
    RefPtr<HappyEyeballsTransaction> hetLoser =
        new HappyEyeballsTransaction(ci, nullptr, /*caps*/ 0, /*browserId*/ 0,
                                     noStatus, noAuth, noAuth, zrh);
    RefPtr<HappyEyeballsTransaction> hetWinner =
        new HappyEyeballsTransaction(ci, nullptr, /*caps*/ 0, /*browserId*/ 0,
                                     noStatus, noAuth, noAuth, zrh);

    // Each racer sent a different amount of early data.
    hetLoser->Request0RttStreamOffset() = Some(loserOffset);
    hetWinner->Request0RttStreamOffset() = Some(winnerOffset);

    // Finish0RTT -> AdoptWinner -> Adopt requires the winner to be on a
    // connection; an H2 fake makes Adopt reuse our ConnectionHandle (the
    // SwapTransaction is skipped because the fake isn't a real Http2Session).
    RefPtr<FakeHttpConnection> winnerConn =
        new FakeHttpConnection(/*usingHttp3*/ false, /*usingSpdy*/ true);
    RefPtr<ConnectionHandle> winnerHandle = new ConnectionHandle(winnerConn);
    hetWinner->SetConnection(winnerHandle);
    hetWinner->SetConnectedCallback([](nsresult) {});

    // Winner accepts 0-RTT (restart=false).
    hetWinner->Finish0RTT(/*aRestart*/ false, /*aAlpnChanged*/ false);

    int64_t pos = -1;
    ASSERT_TRUE(NS_SUCCEEDED(seekable->Tell(&pos)));
    EXPECT_EQ(static_cast<uint64_t>(pos), winnerOffset)
        << "request stream must be seeked to the winner's 0-RTT offset, not "
           "the "
           "loser's";

    // Teardown: detach + reset the handle so ~ConnectionHandle doesn't reclaim
    // the fake connection.
    realTrans->SetConnection(nullptr);
    winnerHandle->Reset();
  });
}

// Helper: a real, 0-RTT-capable transaction for the ZeroRttHandle tests.
static already_AddRefed<nsHttpTransaction> MakeRealTransaction(
    nsHttpConnectionInfo* aCi, nsHttpRequestHead* aReqHead) {
  aReqHead->SetMethod("GET"_ns);
  aReqHead->SetVersion(HttpVersion::v1_1);
  aReqHead->SetRequestURI("/"_ns);
  RefPtr<nsHttpTransaction> trans = new nsHttpTransaction();
  nsresult rv = trans->Init(
      NS_HTTP_USE_HAPPY_EYEBALLS, aCi, aReqHead, /*reqBody*/ nullptr,
      /*reqContentLength*/ 0, /*target*/ gSocketTransportService,
      /*callbacks*/ nullptr,
      /*eventsink*/ nullptr, /*browserId*/ 0, HttpTrafficCategory::eInvalid,
      /*requestContext*/ nullptr, ClassOfService(), /*initialRwin*/ 0,
      /*responseTimeoutEnabled*/ false, /*channelId*/ 0,
      nsILoadInfo::IPAddressSpace::Unknown, LNAPerms{});
  MOZ_RELEASE_ASSERT(NS_SUCCEEDED(rv));
  return trans.forget();
}

// Regression for bug 2051776 (winner-then-loser). Once a winner is declared,
// ZeroRttHandle::Cleanup() nulls mWinner and leaves mState == CleanedUp, so a
// late Finish0RTT from a losing racer must be a no-op -- not trip the
// MOZ_ASSERT(mState == State::Open) in ZeroRttHandle::Finish0RTT.
TEST(HappyEyeballsConnectionAttempt, ZeroRttLateLoserFinish0RTTAfterWinner)
{
  EnsureHttpHandler();
  RunOnSocketThread([]() {
    RefPtr<nsHttpConnectionInfo> ci =
        new nsHttpConnectionInfo("127.0.0.1"_ns, 443, ""_ns, ""_ns, nullptr,
                                 OriginAttributes(), /*endToEndSSL*/ true);
    // The request head is held by weak reference; it must outlive realTrans.
    nsHttpRequestHead reqHead;
    RefPtr<nsHttpTransaction> realTrans = MakeRealTransaction(ci, &reqHead);

    RefPtr<HappyEyeballsConnectionAttempt> hca =
        new HappyEyeballsConnectionAttempt(ci, realTrans, /*caps*/ 0,
                                           /*speculative*/ false,
                                           /*urgentStart*/ false);
    ZeroRttHandle* zrh = hca->ZeroRttHandleForTesting();
    ASSERT_TRUE(zrh);

    auto noStatus = [](nsITransport*, nsresult, int64_t) {};
    auto noAuth = []() {};
    RefPtr<HappyEyeballsTransaction> hetWinner =
        new HappyEyeballsTransaction(ci, nullptr, /*caps*/ 0, /*browserId*/ 0,
                                     noStatus, noAuth, noAuth, zrh);
    RefPtr<HappyEyeballsTransaction> hetLoser =
        new HappyEyeballsTransaction(ci, nullptr, /*caps*/ 0, /*browserId*/ 0,
                                     noStatus, noAuth, noAuth, zrh);
    hetWinner->Request0RttStreamOffset() = Some<uint64_t>(0);
    hetLoser->Request0RttStreamOffset() = Some<uint64_t>(0);

    RefPtr<FakeHttpConnection> winnerConn =
        new FakeHttpConnection(/*usingHttp3*/ false, /*usingSpdy*/ true);
    RefPtr<ConnectionHandle> winnerHandle = new ConnectionHandle(winnerConn);
    hetWinner->SetConnection(winnerHandle);
    hetWinner->SetConnectedCallback([](nsresult) {});

    // Declare the winner -> Cleanup() nulls mWinner, mState = CleanedUp.
    hetWinner->Finish0RTT(/*aRestart*/ false, /*aAlpnChanged*/ false);

    // Late loser Finish0RTT after cleanup: must be a no-op (asserts before
    // fix).
    hetLoser->Finish0RTT(/*aRestart*/ false, /*aAlpnChanged*/ false);

    EXPECT_FALSE(realTrans->Closed());

    realTrans->SetConnection(nullptr);
    winnerHandle->Reset();
  });
}

// Regression for bug 2051776 (real-txn-gone path). The first Finish0RTT takes
// the !realTxn branch and calls Cleanup() without ever declaring a winner
// (mHadWinner stays false), so a second Finish0RTT must still be a no-op. Only
// a state-based guard covers this path.
TEST(HappyEyeballsConnectionAttempt, ZeroRttLateLoserFinish0RTTAfterRealTxnGone)
{
  EnsureHttpHandler();
  Preferences::SetBool("network.http.0rtt_force_txn_gone_for_testing", true);
  RunOnSocketThread([]() {
    RefPtr<nsHttpConnectionInfo> ci =
        new nsHttpConnectionInfo("127.0.0.1"_ns, 443, ""_ns, ""_ns, nullptr,
                                 OriginAttributes(), /*endToEndSSL*/ true);
    nsHttpRequestHead reqHead;
    RefPtr<nsHttpTransaction> realTrans = MakeRealTransaction(ci, &reqHead);

    RefPtr<HappyEyeballsConnectionAttempt> hca =
        new HappyEyeballsConnectionAttempt(ci, realTrans, /*caps*/ 0,
                                           /*speculative*/ false,
                                           /*urgentStart*/ false);
    ZeroRttHandle* zrh = hca->ZeroRttHandleForTesting();
    ASSERT_TRUE(zrh);

    auto noStatus = [](nsITransport*, nsresult, int64_t) {};
    auto noAuth = []() {};
    RefPtr<HappyEyeballsTransaction> het1 =
        new HappyEyeballsTransaction(ci, nullptr, /*caps*/ 0, /*browserId*/ 0,
                                     noStatus, noAuth, noAuth, zrh);
    RefPtr<HappyEyeballsTransaction> het2 =
        new HappyEyeballsTransaction(ci, nullptr, /*caps*/ 0, /*browserId*/ 0,
                                     noStatus, noAuth, noAuth, zrh);
    het1->Request0RttStreamOffset() = Some<uint64_t>(0);
    het2->Request0RttStreamOffset() = Some<uint64_t>(0);

    // First Finish0RTT: the force pref makes the real txn "gone", taking the
    // !realTxn branch -> Cleanup() without declaring a winner.
    het1->Finish0RTT(/*aRestart*/ false, /*aAlpnChanged*/ false);

    // Second Finish0RTT after that cleanup: must be a no-op (asserts before
    // fix).
    het2->Finish0RTT(/*aRestart*/ false, /*aAlpnChanged*/ false);

    realTrans->SetConnection(nullptr);
  });
  Preferences::ClearUser("network.http.0rtt_force_txn_gone_for_testing");
}

// Init() should turn the first by-name endpoint into an establisher through
// the injected factory.
TEST(InnerConnectionAttempt, FactorySeamUsed)
{
  EnsureHttpHandler();
  RefPtr<nsProxyInfo> proxyInfo = MakeConnectProxyInfo();
  ASSERT_TRUE(proxyInfo);
  RunOnSocketThread([&]() {
    InnerTestHarness h(proxyInfo);
    EXPECT_TRUE(NS_SUCCEEDED(h.Init()));
    EXPECT_EQ(h.mFactory->mEstablishers.Length(), 1u)
        << "one endpoint should be in flight after Init";
    h.mAttempt->Abandon();
  });
}

// A usable connection is published and the transaction dispatched onto it,
// both through the delegate.
TEST(InnerConnectionAttempt, SuccessPublishesAndDispatches)
{
  EnsureHttpHandler();
  RefPtr<nsProxyInfo> proxyInfo = MakeConnectProxyInfo();
  ASSERT_TRUE(proxyInfo);
  RunOnSocketThread([&]() {
    InnerTestHarness h(proxyInfo);
    h.mDelegate->mFindResult = new PendingTransactionInfo(h.mTrans);
    ASSERT_TRUE(NS_SUCCEEDED(h.Init()));
    ASSERT_EQ(h.mFactory->mEstablishers.Length(), 1u);

    RefPtr<FakeHttpConnection> inner =
        new FakeHttpConnection(/*usingHttp3*/ false, /*usingSpdy*/ true);
    h.mFactory->mEstablishers[0]->FireSuccess(inner);

    EXPECT_EQ(h.mDelegate->Count("InsertIntoActiveConns"), 1);
    EXPECT_EQ(h.mDelegate->Count("FindTransaction"), 1);
    EXPECT_EQ(h.mDelegate->Count("DispatchTransaction"), 1);
    EXPECT_EQ(h.mDelegate->Count("RemoveConnectionAttempt"), 1);
  });
}

// A refused CONNECT is the proxy's answer, not a connection error: the attempt
// stops there and the response reaches the real transaction.
TEST(InnerConnectionAttempt, RefusedConnectStopsTheAttempt)
{
  EnsureHttpHandler();
  RefPtr<nsProxyInfo> proxyInfo = MakeConnectProxyInfo();
  ASSERT_TRUE(proxyInfo);
  RunOnSocketThread([&]() {
    InnerTestHarness h(proxyInfo);
    h.mDelegate->mFindResult = new PendingTransactionInfo(h.mTrans);
    ASSERT_TRUE(NS_SUCCEEDED(h.Init()));
    ASSERT_EQ(h.mFactory->mEstablishers.Length(), 1u);

    h.mFactory->mEstablishers[0]->FireRefusal(407, h.mCi);

    EXPECT_EQ(h.mFactory->mEstablishers.Length(), 1u)
        << "no further endpoint should be started after a refused CONNECT";
    EXPECT_EQ(h.mDelegate->Count("DispatchTransaction"), 0);
    EXPECT_EQ(h.mDelegate->Count("RemoveConnectionAttempt"), 1);
    ASSERT_TRUE(h.mTrans->ResponseHead())
    << "the refusal should be delivered as the transaction's response";
    EXPECT_EQ(h.mTrans->ResponseHead()->Status(), 407u);
  });
}

// A leg failing with no CONNECT response is a plain connection failure.
TEST(InnerConnectionAttempt, FailureWithoutResponseDoesNotDispatch)
{
  EnsureHttpHandler();
  RefPtr<nsProxyInfo> proxyInfo = MakeConnectProxyInfo();
  ASSERT_TRUE(proxyInfo);
  RunOnSocketThread([&]() {
    InnerTestHarness h(proxyInfo);
    h.mDelegate->mFindResult = new PendingTransactionInfo(h.mTrans);
    ASSERT_TRUE(NS_SUCCEEDED(h.Init()));
    ASSERT_EQ(h.mFactory->mEstablishers.Length(), 1u);

    h.mFactory->mEstablishers[0]->FireFailure(NS_ERROR_CONNECTION_REFUSED);

    EXPECT_EQ(h.mDelegate->Count("InsertIntoActiveConns"), 0);
    EXPECT_EQ(h.mDelegate->Count("DispatchTransaction"), 0);
    EXPECT_FALSE(h.mTrans->ResponseHead());
  });
}

// While the attempt is in flight the real transaction sits in the pending
// queue, where another connection on the entry (say an HTTP/2 one a sibling
// attempt just published) can pick it up: ProcessSpdyPendingQ dispatches it,
// destroying its PendingTransactionInfo, which Unclaim()s this attempt. From
// then on the transaction is live elsewhere and no longer this attempt's to
// complete, so a later failure here must leave it alone, and the attempt must
// stay bound to it rather than become claimable by a third transaction.
TEST(InnerConnectionAttempt, FailureLeavesATransactionDispatchedElsewhereAlone)
{
  EnsureHttpHandler();
  RefPtr<nsProxyInfo> proxyInfo = MakeConnectProxyInfo();
  ASSERT_TRUE(proxyInfo);
  RunOnSocketThread([&]() {
    InnerTestHarness h(proxyInfo);
    ASSERT_TRUE(NS_SUCCEEDED(h.Init()));
    ASSERT_EQ(h.mFactory->mEstablishers.Length(), 1u);
    // What ConnectionAttemptPool::AdoptConnectionAttempt does for a pending
    // transaction.
    ASSERT_TRUE(h.mAttempt->Claim());
    h.mPending->RememberConnectionAttempt(h.mAttempt);

    // Another connection takes the pending transaction.
    RefPtr<FakeHttpConnection> other =
        new FakeHttpConnection(/*usingHttp3*/ false, /*usingSpdy*/ true);
    RefPtr<ConnectionHandle> handle = new ConnectionHandle(other);
    h.mTrans->SetConnection(handle);
    h.mPending = nullptr;                // ~PendingTransactionInfo: Unclaim()
    h.mDelegate->mFindResult = nullptr;  // not pending any more

    h.mFactory->mEstablishers[0]->FireFailure(NS_ERROR_CONNECTION_REFUSED);

    EXPECT_FALSE(h.mTrans->Closed())
        << "a transaction running on another connection was closed";
    EXPECT_EQ(h.mTrans->Status(), NS_OK);
    EXPECT_EQ(h.mTrans->Connection(), handle.get());
    EXPECT_FALSE(h.mAttempt->Claim())
        << "the attempt became claimable by a transaction it will never serve";

    handle->Reset();
  });
}

// Once the entry is gone the transaction is not this attempt's to touch, and
// a connection the endpoint just produced has nobody left to publish it to.
TEST(InnerConnectionAttempt, EntryGoneLeavesTransactionAloneAndClosesEndpoint)
{
  EnsureHttpHandler();
  RefPtr<nsProxyInfo> proxyInfo = MakeConnectProxyInfo();
  ASSERT_TRUE(proxyInfo);
  RunOnSocketThread([&]() {
    InnerTestHarness h(proxyInfo);
    h.mDelegate->mFindResult = new PendingTransactionInfo(h.mTrans);
    ASSERT_TRUE(NS_SUCCEEDED(h.Init()));
    ASSERT_EQ(h.mFactory->mEstablishers.Length(), 1u);
    RefPtr<FakeInnerConnectionEstablisher> establisher =
        h.mFactory->mEstablishers[0];

    // The attempt only holds a weak reference to its entry.
    h.mEntry = nullptr;

    RefPtr<FakeHttpConnection> inner =
        new FakeHttpConnection(/*usingHttp3*/ false, /*usingSpdy*/ false);
    establisher->FireSuccess(inner);

    EXPECT_EQ(h.mDelegate->Count("InsertIntoActiveConns"), 0);
    EXPECT_EQ(h.mDelegate->Count("DispatchTransaction"), 0);
    EXPECT_FALSE(h.mTrans->Closed())
        << "the transaction is not the attempt's to close any more";
    ASSERT_TRUE(establisher->mCloseReason.isSome())
    << "the connection the endpoint produced must be closed";
    EXPECT_EQ(*establisher->mCloseReason, NS_ERROR_ABORT);
  });
}

// With nobody waiting for it, a published HTTP/1 connection has no transaction
// to finish and hand it back, so it must be reclaimed into the idle pool rather
// than parked in the active list for good.
TEST(InnerConnectionAttempt, SuccessWithoutPendingTransactionReclaimsH1Conn)
{
  EnsureHttpHandler();
  RefPtr<nsProxyInfo> proxyInfo = MakeConnectProxyInfo();
  ASSERT_TRUE(proxyInfo);
  RunOnSocketThread([&]() {
    InnerTestHarness h(proxyInfo);
    h.mDelegate->mFindResult = nullptr;
    ASSERT_TRUE(NS_SUCCEEDED(h.Init()));
    ASSERT_EQ(h.mFactory->mEstablishers.Length(), 1u);

    RefPtr<FakeHttpConnection> inner =
        new FakeHttpConnection(/*usingHttp3*/ false, /*usingSpdy*/ false);
    h.mFactory->mEstablishers[0]->FireSuccess(inner);

    EXPECT_EQ(h.mDelegate->Count("InsertIntoActiveConns"), 1);
    EXPECT_EQ(h.mDelegate->Count("DispatchTransaction"), 0);
    EXPECT_EQ(h.mDelegate->Count("ReclaimConnection"), 1)
        << "an idle h1 connection must go back to the pool";
  });
}

// A multiplexed connection serves later transactions from the active list, so
// it stays there.
TEST(InnerConnectionAttempt, SuccessWithoutPendingTransactionKeepsH2Conn)
{
  EnsureHttpHandler();
  RefPtr<nsProxyInfo> proxyInfo = MakeConnectProxyInfo();
  ASSERT_TRUE(proxyInfo);
  RunOnSocketThread([&]() {
    InnerTestHarness h(proxyInfo);
    h.mDelegate->mFindResult = nullptr;
    ASSERT_TRUE(NS_SUCCEEDED(h.Init()));
    ASSERT_EQ(h.mFactory->mEstablishers.Length(), 1u);

    RefPtr<FakeHttpConnection> inner =
        new FakeHttpConnection(/*usingHttp3*/ false, /*usingSpdy*/ true);
    h.mFactory->mEstablishers[0]->FireSuccess(inner);

    EXPECT_EQ(h.mDelegate->Count("InsertIntoActiveConns"), 1);
    EXPECT_EQ(h.mDelegate->Count("ReclaimConnection"), 0);
  });
}

// HTTP_1_1_REQUIRED on the CONNECT stream is the proxy demanding a different
// outer connection, which every endpoint over this one would hear again: the
// attempt stops at once, and the transaction is closed with a reset carrying
// the demand, so its restart goes to a fresh outer connection.
TEST(InnerConnectionAttempt, Http11RequiredStopsAndRestartsWithReset)
{
  EnsureHttpHandler();
  RefPtr<nsProxyInfo> proxyInfo = MakeConnectProxyInfo();
  ASSERT_TRUE(proxyInfo);
  RunOnSocketThread([&]() {
    InnerTestHarness h(proxyInfo);
    h.mDelegate->mFindResult = new PendingTransactionInfo(h.mTrans);
    ASSERT_TRUE(NS_SUCCEEDED(h.Init()));
    ASSERT_EQ(h.mFactory->mEstablishers.Length(), 1u);
    // A sticky transaction records its close reason instead of restarting
    // through the real connection manager.
    h.mTrans->MakeSticky();

    h.mFactory->mEstablishers[0]->FireHttp11Required(h.mCi);

    EXPECT_EQ(h.mFactory->mEstablishers.Length(), 1u)
        << "no further endpoint may be started over the same outer connection";
    EXPECT_EQ(h.mDelegate->Count("DispatchTransaction"), 0);
    EXPECT_EQ(h.mDelegate->Count("RemoveConnectionAttempt"), 1);
    EXPECT_TRUE(h.mTrans->Caps() & NS_HTTP_DISALLOW_HTTP2_PROXY)
        << "the demand for HTTP/1.1 must travel with the transaction";
    EXPECT_TRUE(h.mTrans->Closed());
    EXPECT_EQ(h.mTrans->Status(), NS_ERROR_NET_RESET)
        << "only a reset makes the transaction restart";
    EXPECT_FALSE(h.mTrans->ResponseHead());
  });
}

// The attempt keeps the outer connection it was created with. If that
// connection dies before a leg uses it, the leg fails with a code that does
// not restart the transaction. The attempt must close with a reset instead,
// so the restart reaches a fresh outer connection.
TEST(InnerConnectionAttempt, OuterConnectionGoneRestartsWithReset)
{
  EnsureHttpHandler();
  RefPtr<nsProxyInfo> proxyInfo = MakeConnectProxyInfo();
  ASSERT_TRUE(proxyInfo);
  RunOnSocketThread([&]() {
    InnerTestHarness h(proxyInfo);
    h.mDelegate->mFindResult = new PendingTransactionInfo(h.mTrans);
    ASSERT_TRUE(NS_SUCCEEDED(h.Init()));
    ASSERT_EQ(h.mFactory->mEstablishers.Length(), 1u);
    h.mTrans->MakeSticky();

    h.mOuterConn->mCanReuse = false;
    h.mFactory->mEstablishers[0]->FireFailure(NS_ERROR_NET_INTERRUPT);

    EXPECT_EQ(h.mDelegate->Count("DispatchTransaction"), 0);
    EXPECT_EQ(h.mDelegate->Count("RemoveConnectionAttempt"), 1);
    EXPECT_TRUE(h.mTrans->Closed());
    EXPECT_EQ(h.mTrans->Status(), NS_ERROR_NET_RESET)
        << "only a reset makes the transaction restart";
  });
}

// An outer session that failed takes its tunnels down with its own error, as
// it does every transaction on it. That error is the answer: a restart would
// only build a fresh outer connection to meet the same failure.
TEST(InnerConnectionAttempt, OuterConnectionGoneKeepsASessionError)
{
  EnsureHttpHandler();
  RefPtr<nsProxyInfo> proxyInfo = MakeConnectProxyInfo();
  ASSERT_TRUE(proxyInfo);
  RunOnSocketThread([&]() {
    InnerTestHarness h(proxyInfo);
    h.mDelegate->mFindResult = new PendingTransactionInfo(h.mTrans);
    ASSERT_TRUE(NS_SUCCEEDED(h.Init()));
    ASSERT_EQ(h.mFactory->mEstablishers.Length(), 1u);
    h.mTrans->MakeSticky();

    h.mOuterConn->mCanReuse = false;
    h.mFactory->mEstablishers[0]->FireFailure(NS_ERROR_NET_HTTP2_SENT_GOAWAY);

    EXPECT_TRUE(h.mTrans->Closed());
    EXPECT_EQ(h.mTrans->Status(), NS_ERROR_NET_HTTP2_SENT_GOAWAY);
  });
}

// With the outer connection still usable, the leg's own error is the answer.
TEST(InnerConnectionAttempt, OuterConnectionAliveKeepsTheError)
{
  EnsureHttpHandler();
  RefPtr<nsProxyInfo> proxyInfo = MakeConnectProxyInfo();
  ASSERT_TRUE(proxyInfo);
  RunOnSocketThread([&]() {
    InnerTestHarness h(proxyInfo);
    h.mDelegate->mFindResult = new PendingTransactionInfo(h.mTrans);
    ASSERT_TRUE(NS_SUCCEEDED(h.Init()));
    ASSERT_EQ(h.mFactory->mEstablishers.Length(), 1u);
    h.mTrans->MakeSticky();

    h.mFactory->mEstablishers[0]->FireFailure(NS_ERROR_NET_INTERRUPT);

    EXPECT_TRUE(h.mTrans->Closed());
    EXPECT_EQ(h.mTrans->Status(), NS_ERROR_NET_INTERRUPT);
  });
}

// With an h3 inner conn info the machine offers CONNECT-UDP first and, after
// the attempt delay, the H2/H1 endpoint alongside it -- the fallback that
// rescues a tunnel the proxy accepts and never forwards.
TEST(InnerConnectionAttempt, Http3LegRacesHttp2FallbackAfterDelay)
{
  EnsureHttpHandler();
  RefPtr<nsProxyInfo> proxyInfo = MakeConnectProxyInfo();
  ASSERT_TRUE(proxyInfo);
  // The machine compares real Instants, so shorten the delay instead of
  // waiting half a second.
  Preferences::SetUint(
      "network.http.happy_eyeballs_inner_connection_attempt_delay", 1);

  RunOnSocketThread([&]() {
    InnerTestHarness h(proxyInfo, /*http3Origin*/ true,
                       /*realEstablisher*/ true);
    ASSERT_TRUE(NS_SUCCEEDED(h.Init()));
    ASSERT_EQ(h.InnerConns().Length(), 1u)
        << "the h3 endpoint should be the first leg";
    EXPECT_TRUE(h.InnerConns()[0]->IsHttp3Endpoint());

    // Let the delay pass, then drain as the timer callback would.
    PR_Sleep(PR_MillisecondsToInterval(20));
    (void)h.mAttempt->Notify(nullptr);

    ASSERT_EQ(h.InnerConns().Length(), 2u)
        << "the H2/H1 fallback should be racing after the delay";
    EXPECT_FALSE(h.InnerConns()[1]->IsHttp3Endpoint())
        << "the fallback leg is the H2/H1 one";
    // The fallback gets its own conn info for its ALPN, but it hashes to the
    // origin's key so both legs land in the same connection entry.
    EXPECT_EQ(h.InnerConns()[1]->ConnInfo()->HashKey(),
              h.InnerConns()[0]->ConnInfo()->HashKey());

    h.mAttempt->Abandon();
  });

  Preferences::ClearUser(
      "network.http.happy_eyeballs_inner_connection_attempt_delay");
}

// CONNECT 200 plus a completed handshake on the h3 leg publishes it and closes
// the fallback.
TEST(InnerConnectionAttempt, Http3LegWinsAndClosesTheFallback)
{
  EnsureHttpHandler();
  RefPtr<nsProxyInfo> proxyInfo = MakeConnectProxyInfo();
  ASSERT_TRUE(proxyInfo);
  Preferences::SetUint(
      "network.http.happy_eyeballs_inner_connection_attempt_delay", 1);

  RunOnSocketThread([&]() {
    InnerTestHarness h(proxyInfo, /*http3Origin*/ true,
                       /*realEstablisher*/ true);
    h.mDelegate->mFindResult = new PendingTransactionInfo(h.mTrans);
    ASSERT_TRUE(NS_SUCCEEDED(h.Init()));
    PR_Sleep(PR_MillisecondsToInterval(20));
    (void)h.mAttempt->Notify(nullptr);
    ASSERT_EQ(h.InnerConns().Length(), 2u);

    h.InnerConns()[0]->AnswerConnect(
        "HTTP/1.1 200 Connection established\r\n\r\n"_ns);
    h.InnerConns()[0]->CompleteHandshake();
    h.Drain();

    EXPECT_EQ(h.mDelegate->Count("InsertIntoActiveConns"), 1);
    EXPECT_EQ(h.mDelegate->Count("DispatchTransaction"), 1)
        << "the winning leg should carry the real transaction";
    EXPECT_TRUE(h.InnerConns()[1]->mCloseReason.isSome())
        << "the losing fallback leg should be closed";
  });

  Preferences::ClearUser(
      "network.http.happy_eyeballs_inner_connection_attempt_delay");
}

// The h3 leg stalling is what the fallback exists for.
TEST(InnerConnectionAttempt, FallbackLegWinsWhenHttp3Stalls)
{
  EnsureHttpHandler();
  RefPtr<nsProxyInfo> proxyInfo = MakeConnectProxyInfo();
  ASSERT_TRUE(proxyInfo);
  Preferences::SetUint(
      "network.http.happy_eyeballs_inner_connection_attempt_delay", 1);

  RunOnSocketThread([&]() {
    InnerTestHarness h(proxyInfo, /*http3Origin*/ true,
                       /*realEstablisher*/ true);
    h.mDelegate->mFindResult = new PendingTransactionInfo(h.mTrans);
    ASSERT_TRUE(NS_SUCCEEDED(h.Init()));
    PR_Sleep(PR_MillisecondsToInterval(20));
    (void)h.mAttempt->Notify(nullptr);
    ASSERT_EQ(h.InnerConns().Length(), 2u);

    // The h3 leg never answers; the fallback does.
    h.InnerConns()[1]->AnswerConnect(
        "HTTP/1.1 200 Connection established\r\n\r\n"_ns);
    h.InnerConns()[1]->CompleteHandshake();
    h.Drain();

    EXPECT_EQ(h.mDelegate->Count("DispatchTransaction"), 1);
    EXPECT_TRUE(h.InnerConns()[0]->mCloseReason.isSome())
        << "the stalled h3 leg should be closed once the fallback wins";
  });

  Preferences::ClearUser(
      "network.http.happy_eyeballs_inner_connection_attempt_delay");
}

// A real 407 parsed by TunnelSetupTransaction: the proxy has answered, so the
// attempt stops and the response reaches the real transaction for auth.
TEST(InnerConnectionAttempt, MockConnectRefusalStopsTheAttempt)
{
  EnsureHttpHandler();
  RefPtr<nsProxyInfo> proxyInfo = MakeConnectProxyInfo();
  ASSERT_TRUE(proxyInfo);

  RunOnSocketThread([&]() {
    InnerTestHarness h(proxyInfo, /*http3Origin*/ false,
                       /*realEstablisher*/ true);
    h.mDelegate->mFindResult = new PendingTransactionInfo(h.mTrans);
    ASSERT_TRUE(NS_SUCCEEDED(h.Init()));
    ASSERT_EQ(h.InnerConns().Length(), 1u);

    h.InnerConns()[0]->AnswerConnect(
        "HTTP/1.1 407 Proxy Authentication Required\r\n"
        "Proxy-Authenticate: Basic realm=\"test\"\r\n"
        "Content-Length: 5\r\n"
        "\r\n"
        "nope!"_ns);
    h.Drain();

    EXPECT_EQ(h.InnerConns().Length(), 1u)
        << "no further endpoint should be started after a refused CONNECT";
    EXPECT_EQ(h.mDelegate->Count("DispatchTransaction"), 0);
    ASSERT_TRUE(h.mTrans->ResponseHead());
    EXPECT_EQ(h.mTrans->ResponseHead()->Status(), 407u);
    nsAutoCString authenticate;
    EXPECT_TRUE(NS_SUCCEEDED(h.mTrans->ResponseHead()->GetHeader(
        nsHttp::Proxy_Authenticate, authenticate)));
    EXPECT_STREQ(authenticate.get(), "Basic realm=\"test\"")
        << "the proxy's challenge has to survive for auth to work";
  });
}

// Nothing tunnelled here has the peer speak first, so bytes behind an accepted
// CONNECT are a protocol error. The driver cannot hand them to the tunnel's
// next reader, so it must fail the attempt rather than open a tunnel that has
// silently lost them.
TEST(InnerConnectionAttempt, BytesBehindConnect200FailTheAttempt)
{
  EnsureHttpHandler();
  RefPtr<nsProxyInfo> proxyInfo = MakeConnectProxyInfo();
  ASSERT_TRUE(proxyInfo);

  RunOnSocketThread([&]() {
    InnerTestHarness h(proxyInfo, /*http3Origin*/ false,
                       /*realEstablisher*/ true);
    h.mDelegate->mFindResult = new PendingTransactionInfo(h.mTrans);
    ASSERT_TRUE(NS_SUCCEEDED(h.Init()));
    ASSERT_EQ(h.InnerConns().Length(), 1u);

    h.InnerConns()[0]->AnswerConnect(
        "HTTP/1.1 200 Connection established\r\n\r\nhello from origin"_ns);
    h.Drain();

    EXPECT_EQ(h.mDelegate->Count("InsertIntoActiveConns"), 0)
        << "a tunnel that lost bytes must not be published";
    EXPECT_EQ(h.mDelegate->Count("DispatchTransaction"), 0);
    EXPECT_TRUE(h.mTrans->Closed()) << "the attempt should have failed";
    EXPECT_TRUE(NS_FAILED(h.mTrans->Status()));
    EXPECT_FALSE(h.mTrans->ResponseHead());
  });
}

// A CONNECT response whose status line does not parse is a failure, not an
// open tunnel: a fresh response head reports 200 until told otherwise.
TEST(InnerConnectionAttempt, MalformedConnectStatusLineFailsTheAttempt)
{
  EnsureHttpHandler();
  RefPtr<nsProxyInfo> proxyInfo = MakeConnectProxyInfo();
  ASSERT_TRUE(proxyInfo);

  RunOnSocketThread([&]() {
    InnerTestHarness h(proxyInfo, /*http3Origin*/ false,
                       /*realEstablisher*/ true);
    h.mDelegate->mFindResult = new PendingTransactionInfo(h.mTrans);
    ASSERT_TRUE(NS_SUCCEEDED(h.Init()));
    ASSERT_EQ(h.InnerConns().Length(), 1u);

    h.InnerConns()[0]->AnswerConnect("HTTP/1.1 abc Not A Status\r\n\r\n"_ns);
    h.Drain();

    EXPECT_EQ(h.mDelegate->Count("InsertIntoActiveConns"), 0)
        << "nothing may be published on an unparsable CONNECT response";
    EXPECT_EQ(h.mDelegate->Count("DispatchTransaction"), 0);
    EXPECT_TRUE(h.mTrans->Closed()) << "the attempt should have failed";
    EXPECT_TRUE(NS_FAILED(h.mTrans->Status()));
    EXPECT_FALSE(h.mTrans->ResponseHead())
        << "no proxy response to deliver when the status line is garbage";
  });
}

// A CONNECT response head can arrive over several reads. When the socket has
// nothing more to give, the driver must report that as "nothing written", not
// pass the would-block through: nsHttpConnection::OnSocketReadable only
// re-arms the socket for the former, so the rest of the head would never be
// read.
TEST(InnerConnectionAttempt, ConnectHeadSplitAcrossReadsKeepsTheSocketArmed)
{
  EnsureHttpHandler();
  RefPtr<nsProxyInfo> proxyInfo = MakeConnectProxyInfo();
  ASSERT_TRUE(proxyInfo);

  RunOnSocketThread([&]() {
    InnerTestHarness h(proxyInfo);
    RefPtr<TunnelSetupTransaction> driver = new TunnelSetupTransaction(
        h.mCi, nullptr, 0, TunnelSetupTransaction::RequestHeaderSnapshot{});
    RefPtr<TunnelIO> io = new TunnelIO();
    io->mWouldBlockWhenDrained = true;

    uint32_t written = 0;
    io->SetResponse("HTTP/1.1 407 Proxy Authentication Required\r\n"_ns);
    EXPECT_EQ(driver->WriteSegments(io, 4096, &written), NS_OK);
    EXPECT_GT(written, 0u);

    EXPECT_EQ(driver->WriteSegments(io, 4096, &written), NS_OK)
        << "a drained socket is not an error, and not a would-block either";
    EXPECT_EQ(written, 0u);

    io->SetResponse("\r\n"_ns);
    EXPECT_EQ(driver->WriteSegments(io, 4096, &written), NS_OK);
    EXPECT_GT(written, 0u);
  });
}

// An IP-literal origin needs no resolution, so the machine offers its address
// instead of a name. The attempt must still start an endpoint for it, naming
// the literal like the origin does, rather than failing as it has no by-name
// endpoint.
TEST(InnerConnectionAttempt, IpLiteralOriginStartsAnEndpointForTheLiteral)
{
  EnsureHttpHandler();
  RefPtr<nsProxyInfo> proxyInfo = MakeConnectProxyInfo();
  ASSERT_TRUE(proxyInfo);

  for (const nsCString& host : {"192.0.2.7"_ns, "2001:db8::7"_ns}) {
    RunOnSocketThread([&]() {
      InnerTestHarness h(proxyInfo, /*http3Origin*/ false,
                         /*realEstablisher*/ false, host);
      ASSERT_TRUE(NS_SUCCEEDED(h.Init()))
      << host.get();
      ASSERT_GE(h.mFactory->mConnInfos.Length(), 1u) << host.get();
      EXPECT_STREQ(h.mFactory->mConnInfos[0]->Origin(), host.get());
      EXPECT_EQ(h.mFactory->mConnInfos[0]->OriginPort(), 443);
      EXPECT_FALSE(h.mTrans->Closed());
      h.mAttempt->Abandon();
    });
  }
}

// A result Finish() has already queued must not reach the caller once the
// establisher is closed: the connection it carries is closed by then, and the
// caller no longer expects an answer.
TEST(InnerConnectionEstablisher, CloseDropsAResultThatIsAlreadyQueued)
{
  EnsureHttpHandler();
  RefPtr<nsProxyInfo> proxyInfo = MakeConnectProxyInfo();
  ASSERT_TRUE(proxyInfo);

  RunOnSocketThread([&]() {
    InnerTestHarness h(proxyInfo, /*http3Origin*/ false,
                       /*realEstablisher*/ true);
    RefPtr<InnerConnectionEstablisher> establisher =
        new InnerConnectionEstablisher(
            h.mOuterConn, h.mCi, /*caps*/ 0,
            TunnelSetupTransaction::RequestHeaderSnapshot{}, nullptr);
    bool called = false;
    establisher->Start(
        [&called](Result<RefPtr<HttpConnectionBase>, nsresult>&&) {
          called = true;
        });
    ASSERT_EQ(h.InnerConns().Length(), 1u);

    h.InnerConns()[0]->AnswerConnect(
        "HTTP/1.1 200 Connection established\r\n\r\n"_ns);
    h.InnerConns()[0]->CompleteHandshake();
    establisher->Close(NS_ERROR_ABORT);
    h.Drain();

    EXPECT_FALSE(called);
  });
}

// Closing an endpoint that has not finished closes its connection once. The
// connection must not be handed back to the connection manager afterwards,
// which would close it a second time.
TEST(InnerConnectionEstablisher, CloseDoesNotReclaimTheConnectionItClosed)
{
  EnsureHttpHandler();
  RefPtr<nsProxyInfo> proxyInfo = MakeConnectProxyInfo();
  ASSERT_TRUE(proxyInfo);

  RunOnSocketThread([&]() {
    InnerTestHarness h(proxyInfo, /*http3Origin*/ false,
                       /*realEstablisher*/ true);
    RefPtr<InnerConnectionEstablisher> establisher =
        new InnerConnectionEstablisher(
            h.mOuterConn, h.mCi, /*caps*/ 0,
            TunnelSetupTransaction::RequestHeaderSnapshot{}, nullptr);
    establisher->Start([](Result<RefPtr<HttpConnectionBase>, nsresult>&&) {});
    ASSERT_EQ(h.InnerConns().Length(), 1u);

    establisher->Close(NS_ERROR_ABORT);
    establisher = nullptr;
    h.Drain();

    EXPECT_EQ(h.InnerConns()[0]->mCloseCount, 1u)
        << "reclaiming the closed connection closes it again";
  });
}

// Once the caller has published the connection, closing the establisher must
// leave it alone: the real transaction is running on it.
TEST(InnerConnectionEstablisher, CloseLeavesAHandedOverConnectionAlone)
{
  EnsureHttpHandler();
  RefPtr<nsProxyInfo> proxyInfo = MakeConnectProxyInfo();
  ASSERT_TRUE(proxyInfo);

  RunOnSocketThread([&]() {
    InnerTestHarness h(proxyInfo, /*http3Origin*/ false,
                       /*realEstablisher*/ true);
    RefPtr<InnerConnectionEstablisher> establisher =
        new InnerConnectionEstablisher(
            h.mOuterConn, h.mCi, /*caps*/ 0,
            TunnelSetupTransaction::RequestHeaderSnapshot{}, nullptr);
    bool succeeded = false;
    establisher->Start(
        [&succeeded](Result<RefPtr<HttpConnectionBase>, nsresult>&& aResult) {
          succeeded = aResult.isOk();
        });
    ASSERT_EQ(h.InnerConns().Length(), 1u);
    h.InnerConns()[0]->AnswerConnect(
        "HTTP/1.1 200 Connection established\r\n\r\n"_ns);
    h.InnerConns()[0]->CompleteHandshake();
    h.Drain();
    ASSERT_TRUE(succeeded);

    // Reclaiming the connection, which nothing registered in an entry, closed
    // it already; only what Close() adds is of interest.
    h.InnerConns()[0]->mCloseReason.reset();
    establisher->HandedOver();
    establisher->Close(NS_ERROR_ABORT);

    EXPECT_TRUE(h.InnerConns()[0]->mCloseReason.isNothing())
        << "the published connection must not be closed";
  });
}

// The CONNECT should name the origin authority, which is what a proxy routes
// on.
TEST(InnerConnectionAttempt, ConnectRequestNamesTheOrigin)
{
  EnsureHttpHandler();
  RefPtr<nsProxyInfo> proxyInfo = MakeConnectProxyInfo();
  ASSERT_TRUE(proxyInfo);

  RunOnSocketThread([&]() {
    InnerTestHarness h(proxyInfo, /*http3Origin*/ false,
                       /*realEstablisher*/ true);
    ASSERT_TRUE(NS_SUCCEEDED(h.Init()));
    ASSERT_EQ(h.InnerConns().Length(), 1u);

    EXPECT_NE(
        h.InnerConns()[0]->mConnectRequest.Find("CONNECT example.com:443"),
        kNotFound)
        << "request was: " << h.InnerConns()[0]->mConnectRequest.get();

    h.mAttempt->Abandon();
  });
}

// CONNECT-UDP needs an h3 outer connection, so an h3 inner conn info over an
// h2 proxy connection must yield only the H2/H1 endpoint -- not an h3 leg the
// tunnel cannot carry.
TEST(InnerConnectionAttempt, NoHttp3LegThroughHttp2OuterConnection)
{
  EnsureHttpHandler();
  RefPtr<nsProxyInfo> proxyInfo = MakeConnectProxyInfo();
  ASSERT_TRUE(proxyInfo);
  Preferences::SetUint(
      "network.http.happy_eyeballs_inner_connection_attempt_delay", 1);

  RunOnSocketThread([&]() {
    InnerTestHarness h(proxyInfo, /*http3Origin*/ true,
                       /*realEstablisher*/ true);
    // Override the harness pairing: h3 inner conn info, h2 outer.
    h.mOuter = new MockOuterConnection(/*usingHttp3*/ false);
    h.mAttempt =
        new InnerConnectionAttempt(h.mCi, h.mTrans, /*caps*/ 0, h.mOuter);
    h.mAttempt->SetConnMgrDelegateForTesting(h.mDelegate);

    ASSERT_TRUE(NS_SUCCEEDED(h.Init()));
    ASSERT_EQ(h.InnerConns().Length(), 1u);
    EXPECT_FALSE(h.InnerConns()[0]->IsHttp3Endpoint())
        << "an h2 outer connection cannot carry CONNECT-UDP";

    PR_Sleep(PR_MillisecondsToInterval(20));
    (void)h.mAttempt->Notify(nullptr);
    EXPECT_EQ(h.InnerConns().Length(), 1u)
        << "and there is no second protocol to fall back to";

    h.mAttempt->Abandon();
  });

  Preferences::ClearUser(
      "network.http.happy_eyeballs_inner_connection_attempt_delay");
}

// With h1/h2 disabled by the conn info and no h3 outer connection to carry
// CONNECT-UDP, there is no protocol left. Init must fail with something other
// than NS_ERROR_NOT_AVAILABLE: the connection manager reads that as "queue the
// transaction and wait", and nothing would ever retry it.
TEST(InnerConnectionAttempt, Http3OnlyThroughHttp2OuterFailsHard)
{
  EnsureHttpHandler();
  RefPtr<nsProxyInfo> proxyInfo = MakeConnectProxyInfo();
  ASSERT_TRUE(proxyInfo);

  RunOnSocketThread([&]() {
    InnerTestHarness h(proxyInfo, /*http3Origin*/ true,
                       /*realEstablisher*/ true);
    h.mCi = h.mCi->Mutate().SetHttp3Policy(Http3Policy::Only).Finalize();
    h.mOuter = new MockOuterConnection(/*usingHttp3*/ false);
    h.mAttempt =
        new InnerConnectionAttempt(h.mCi, h.mTrans, /*caps*/ 0, h.mOuter);
    h.mAttempt->SetConnMgrDelegateForTesting(h.mDelegate);

    nsresult rv = h.Init();
    EXPECT_TRUE(NS_FAILED(rv));
    EXPECT_NE(rv, NS_ERROR_NOT_AVAILABLE)
        << "NS_ERROR_NOT_AVAILABLE would park the transaction for good";
    EXPECT_EQ(h.InnerConns().Length(), 0u) << "no endpoint can be started";

    // What ConnectionAttemptPool::AdoptConnectionAttempt does on failure.
    h.mAttempt->Abandon();
  });
}

}  // namespace net
}  // namespace mozilla
