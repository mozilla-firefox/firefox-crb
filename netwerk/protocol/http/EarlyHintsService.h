/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef mozilla_net_EarlyHintsService_h
#define mozilla_net_EarlyHintsService_h

#include "mozilla/Maybe.h"
#include "mozilla/RefPtr.h"
#include "mozilla/TimeStamp.h"
#include "mozilla/dom/ipc/IdType.h"
#include "nsStringFwd.h"
#include "nsTArray.h"

class nsIChannel;
class nsIURI;
class nsIInterfaceRequestor;
namespace mozilla::dom {
class CanonicalBrowsingContext;
}

namespace mozilla::net {

struct LinkHeader;
class EarlyHintConnectArgs;
class OngoingEarlyHints;

class EarlyHintsService {
 public:
  EarlyHintsService();
  ~EarlyHintsService();
  void EarlyHint(const nsACString& aLinkHeader, nsIURI* aBaseURI,
                 nsIChannel* aChannel, const nsACString& aReferrerPolicy,
                 const nsACString& aCSPHeader,
                 const nsACString& aConnectionAllowlistHeader,
                 dom::CanonicalBrowsingContext* aLoadingBrowsingContext);
  // Preloads for resources found in the document itself (see
  // ScanDocumentHead), with the final response's policy headers.  Unlike
  // EarlyHint, this may be called after an Early Hint response.
  void DocumentHints(const nsTArray<LinkHeader>& aLinks, nsIURI* aBaseURI,
                     nsIChannel* aChannel, const nsACString& aReferrerPolicy,
                     const nsACString& aCSPHeader,
                     const nsACString& aConnectionAllowlistHeader,
                     dom::CanonicalBrowsingContext* aLoadingBrowsingContext);

  // Finds stylesheets, classic scripts and preloads in the head of the start
  // of an HTML document.  Stops at anything that could change how later links
  // are resolved or allowed (<base>, a CSP <meta>), and at the end of the head.
  // Returns false if more of the document could still add links.
  static bool ScanDocumentHead(const nsACString& aData,
                               nsTArray<LinkHeader>& aLinks);

  void Reset();
  void Cancel(const nsACString& aReason);

  void RegisterLinksAndGetConnectArgs(
      dom::ContentParentId aCpId, nsTArray<EarlyHintConnectArgs>& aOutLinks);

  uint32_t LinkType() const { return mLinkType; }

 private:
  void ProcessLinks(const nsTArray<LinkHeader>& aLinks, nsIURI* aBaseURI,
                    nsIChannel* aChannel, const nsACString& aReferrerPolicy,
                    const nsACString& aCSPHeader,
                    const nsACString& aConnectionAllowlistHeader,
                    dom::CanonicalBrowsingContext* aLoadingBrowsingContext);

  Maybe<TimeStamp> mFirstEarlyHint;
  uint32_t mEarlyHintsCount{0};

  RefPtr<OngoingEarlyHints> mOngoingEarlyHints;
  uint32_t mLinkType = 0;
};

}  // namespace mozilla::net

#endif  // mozilla_net_EarlyHintsService_h
