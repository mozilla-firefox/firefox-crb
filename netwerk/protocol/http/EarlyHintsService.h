/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef mozilla_net_EarlyHintsService_h
#define mozilla_net_EarlyHintsService_h

#include "mozilla/Maybe.h"
#include "mozilla/RefPtr.h"
#include "mozilla/TimeStamp.h"
#include "mozilla/dom/ipc/IdType.h"
#include "nsNetUtil.h"
#include "nsStringFwd.h"
#include "nsTArray.h"

class nsIChannel;
class nsIURI;
class nsIInterfaceRequestor;
namespace mozilla::dom {
class CanonicalBrowsingContext;
}

namespace mozilla::net {

class EarlyHintConnectArgs;
class OngoingEarlyHints;

struct PreloadHint {
  LinkHeader mLink;
  // From a render-blocking stylesheet in the document, so it is prioritized
  // the way the document would load it.  Scripts aren't, as a Leader holds
  // back other loads from the same connection, such as the page's images.
  bool mBlocking = false;
  // The Resource Timing initiator type of the element, if from the document.
  nsString mInitiatorType;
};

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
  void DocumentHints(const nsTArray<PreloadHint>& aHints, nsIURI* aBaseURI,
                     nsIChannel* aChannel, const nsACString& aReferrerPolicy,
                     const nsACString& aCSPHeader,
                     const nsACString& aConnectionAllowlistHeader,
                     dom::CanonicalBrowsingContext* aLoadingBrowsingContext);

  // Finds stylesheets, classic blocking scripts and preloads in the head of
  // the start of an HTML document.  Stops at anything that could change how
  // later links are resolved or allowed (<base>, a CSP <meta>), and at the end
  // of the head. Returns false if more of the document could still add links.
  static bool ScanDocumentHead(const nsACString& aData,
                               nsTArray<PreloadHint>& aHints);

  void Reset();
  void Cancel(const nsACString& aReason);

  void RegisterLinksAndGetConnectArgs(
      dom::ContentParentId aCpId, nsTArray<EarlyHintConnectArgs>& aOutLinks);

  uint32_t LinkType() const { return mLinkType; }

 private:
  void ProcessLinks(const nsTArray<PreloadHint>& aHints, nsIURI* aBaseURI,
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
