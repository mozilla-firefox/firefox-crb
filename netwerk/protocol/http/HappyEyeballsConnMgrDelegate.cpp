/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "HappyEyeballsConnMgrDelegate.h"

#include "ConnectionEntry.h"
#include "HttpConnectionBase.h"
#include "PendingTransactionInfo.h"
#include "nsHttpConnection.h"
#include "nsHttpConnectionMgr.h"
#include "nsHttpHandler.h"
#include "nsHttpTransaction.h"
#include "nsQueryObject.h"

namespace mozilla::net {

already_AddRefed<PendingTransactionInfo>
DefaultHappyEyeballsConnMgrDelegate::FindTransaction(
    bool aRemoveWhenFound, ConnectionEntry* aEntry, nsAHttpTransaction* aTrans) {
  return gHttpHandler->ConnMgr()->FindTransactionHelper(aRemoveWhenFound, aEntry,
                                                        aTrans);
}

nsresult DefaultHappyEyeballsConnMgrDelegate::DispatchTransaction(
    ConnectionEntry* aEntry, nsHttpTransaction* aTrans,
    HttpConnectionBase* aConn) {
  return gHttpHandler->ConnMgr()->DispatchTransaction(aEntry, aTrans, aConn);
}

void DefaultHappyEyeballsConnMgrDelegate::AddTransaction(
    nsHttpTransaction* aTrans, int32_t aPriority) {
  gHttpHandler->ConnMgr()->AddTransaction(aTrans, aPriority);
}

void DefaultHappyEyeballsConnMgrDelegate::ReportSpdyConnection(
    HttpConnectionBase* aConn, bool aUsingSpdy, bool aDisallowHttp3,
    ConnectionEntry* aEntry) {
  if (RefPtr<nsHttpConnection> h1 = do_QueryObject(aConn)) {
    gHttpHandler->ConnMgr()->ReportSpdyConnection(h1, aUsingSpdy,
                                                  aDisallowHttp3, aEntry);
  }
}

void DefaultHappyEyeballsConnMgrDelegate::ReportHttp3Connection(
    HttpConnectionBase* aConn, ConnectionEntry* aEntry) {
  gHttpHandler->ConnMgr()->ReportHttp3Connection(aConn, aEntry);
}

void DefaultHappyEyeballsConnMgrDelegate::ReclaimConnection(
    HttpConnectionBase* aConn) {
  gHttpHandler->ConnMgr()->OnMsgReclaimConnection(aConn);
}

void DefaultHappyEyeballsConnMgrDelegate::ProcessSpdyPendingQ(
    ConnectionEntry* aEntry) {
  gHttpHandler->ConnMgr()->ProcessSpdyPendingQ(aEntry);
}

already_AddRefed<ConnectionEntry>
DefaultHappyEyeballsConnMgrDelegate::HandOffHttp3OnlyConnection(
    HttpConnectionBase* aConn, ConnectionEntry* aFromEnt) {
  return gHttpHandler->ConnMgr()->HandOffHttp3OnlyConnection(aConn, aFromEnt);
}

void DefaultHappyEyeballsConnMgrDelegate::InsertIntoActiveConns(
    ConnectionEntry* aEntry, HttpConnectionBase* aConn) {
  aEntry->InsertIntoActiveConns(aConn);
}

void DefaultHappyEyeballsConnMgrDelegate::RemoveConnectionAttempt(
    ConnectionEntry* aEntry, ConnectionAttempt* aAttempt, bool aAbandon) {
  aEntry->RemoveConnectionAttempt(aAttempt, aAbandon);
}

void DefaultHappyEyeballsConnMgrDelegate::RecordIPFamilyPreference(
    ConnectionEntry* aEntry, uint16_t aFamily) {
  aEntry->RecordIPFamilyPreference(aFamily);
}

void DefaultHappyEyeballsConnMgrDelegate::ResetIPFamilyPreference(
    ConnectionEntry* aEntry) {
  aEntry->ResetIPFamilyPreference();
}

bool DefaultHappyEyeballsConnMgrDelegate::MaybeProcessCoalescingKeys(
    ConnectionEntry* aEntry, const nsTArray<NetAddr>& aAddresses,
    bool aIsHttp3) {
  return aEntry->MaybeProcessCoalescingKeys(aAddresses, aIsHttp3);
}

bool DefaultHappyEyeballsConnMgrDelegate::RemoveTransFromPendingQ(
    ConnectionEntry* aEntry, nsHttpTransaction* aTrans) {
  return aEntry->RemoveTransFromPendingQ(aTrans);
}

nsresult DefaultHappyEyeballsConnMgrDelegate::StartRetry(
    ConnectionEntry* aEntry, nsHttpTransaction* aTrans, uint32_t aCaps,
    bool aSpeculative, bool aUrgentStart, bool aAllow1918,
    bool aRetryWithoutTRR) {
  RefPtr<PendingTransactionInfo> pendingTransInfo =
      new PendingTransactionInfo(aTrans);
  return aEntry->CreateDnsAndConnectSocket(aTrans, aCaps, aSpeculative,
                                           aUrgentStart, aAllow1918,
                                           pendingTransInfo, aRetryWithoutTRR);
}

}  // namespace mozilla::net
