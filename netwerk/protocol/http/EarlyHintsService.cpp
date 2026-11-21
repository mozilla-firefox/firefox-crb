/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "EarlyHintsService.h"

#include <string_view>
#include <utility>

#include "EarlyHintPreconnect.h"
#include "EarlyHintPreloader.h"
#include "mozilla/PreloadHashKey.h"
#include "mozilla/StoragePrincipalHelper.h"
#include "mozilla/TextUtils.h"
#include "mozilla/dom/LinkStyle.h"
#include "nsContentUtils.h"
#include "nsIChannel.h"
#include "nsICookieJarSettings.h"
#include "nsILoadInfo.h"
#include "nsIPrincipal.h"
#include "nsNetUtil.h"
#include "nsString.h"

namespace mozilla::net {

namespace {

constexpr size_t kMaxDocumentScanBytes = 64 * 1024;
constexpr size_t kMaxDocumentHints = 16;

bool IsHtmlSpace(char aChar) {
  return aChar == ' ' || aChar == '\t' || aChar == '\n' || aChar == '\r' ||
         aChar == '\f';
}

bool EqualsIgnoreCase(std::string_view aStr, std::string_view aLower) {
  if (aStr.size() != aLower.size()) {
    return false;
  }
  for (size_t i = 0; i < aStr.size(); i++) {
    char c = aStr[i];
    if (IsAsciiUppercaseAlpha(c)) {
      c = char(c - 'A' + 'a');
    }
    if (c != aLower[i]) {
      return false;
    }
  }
  return true;
}

struct ScannedTag {
  std::string_view mName;
  bool mEnd = false;
  nsTArray<std::pair<std::string_view, std::string_view>> mAttrs;

  bool Is(std::string_view aLower) const {
    return EqualsIgnoreCase(mName, aLower);
  }

  const std::string_view* Attr(std::string_view aLower) const {
    for (const auto& attr : mAttrs) {
      if (EqualsIgnoreCase(attr.first, aLower)) {
        return &attr.second;
      }
    }
    return nullptr;
  }
};

// Parses the tag whose name starts at aPos (just after '<').  Returns the
// offset just past the tag, or npos if the tag isn't complete in aData.  A
// '<' that doesn't start a tag yields an empty name.
size_t ParseTag(std::string_view aData, size_t aPos, ScannedTag& aTag) {
  size_t len = aData.size();
  if (aPos < len && aData[aPos] == '/') {
    aTag.mEnd = true;
    aPos++;
  }
  size_t start = aPos;
  while (aPos < len &&
         (IsAsciiAlphanumeric(aData[aPos]) || aData[aPos] == '-')) {
    aPos++;
  }
  aTag.mName = aData.substr(start, aPos - start);
  if (aTag.mName.empty()) {
    return start;
  }
  while (true) {
    while (aPos < len && (IsHtmlSpace(aData[aPos]) || aData[aPos] == '/')) {
      aPos++;
    }
    if (aPos >= len) {
      return std::string_view::npos;
    }
    if (aData[aPos] == '>') {
      return aPos + 1;
    }
    size_t nameStart = aPos;
    while (aPos < len && !IsHtmlSpace(aData[aPos]) && aData[aPos] != '=' &&
           aData[aPos] != '>' && aData[aPos] != '/') {
      aPos++;
    }
    std::string_view name = aData.substr(nameStart, aPos - nameStart);
    while (aPos < len && IsHtmlSpace(aData[aPos])) {
      aPos++;
    }
    std::string_view value;
    if (aPos < len && aData[aPos] == '=') {
      aPos++;
      while (aPos < len && IsHtmlSpace(aData[aPos])) {
        aPos++;
      }
      if (aPos >= len) {
        return std::string_view::npos;
      }
      char quote = aData[aPos];
      if (quote == '"' || quote == '\'') {
        size_t end = aData.find(quote, aPos + 1);
        if (end == std::string_view::npos) {
          return end;
        }
        value = aData.substr(aPos + 1, end - aPos - 1);
        aPos = end + 1;
      } else {
        size_t valueStart = aPos;
        while (aPos < len && !IsHtmlSpace(aData[aPos]) && aData[aPos] != '>') {
          aPos++;
        }
        value = aData.substr(valueStart, aPos - valueStart);
      }
    }
    if (!name.empty() && !aTag.Attr(name)) {
      aTag.mAttrs.AppendElement(std::make_pair(name, value));
    }
  }
}

nsString AttrValue(std::string_view aValue) {
  nsAutoCString value(aValue.data(), aValue.size());
  value.ReplaceSubstring("&amp;"_ns, "&"_ns);
  value.Trim(" \t\n\r\f");
  return NS_ConvertUTF8toUTF16(value);
}

void CopyFetchAttrs(const ScannedTag& aTag, LinkHeader& aLink) {
  if (const auto* v = aTag.Attr("crossorigin")) {
    aLink.mCrossOrigin = AttrValue(*v);
  }
  if (const auto* v = aTag.Attr("referrerpolicy")) {
    aLink.mReferrerPolicy = AttrValue(*v);
  }
  if (const auto* v = aTag.Attr("integrity")) {
    aLink.mIntegrity = AttrValue(*v);
  }
  if (const auto* v = aTag.Attr("fetchpriority")) {
    aLink.mFetchPriority = AttrValue(*v);
  }
}

void MaybeAddLink(const ScannedTag& aTag, nsTArray<PreloadHint>& aHints) {
  const auto* rel = aTag.Attr("rel");
  const auto* href = aTag.Attr("href");
  if (!rel || !href || href->empty()) {
    return;
  }
  bool stylesheet = false, preload = false, alternate = false;
  nsString relValue = AttrValue(*rel);
  for (const auto& token : relValue.Split(' ')) {
    if (token.LowerCaseEqualsLiteral("stylesheet")) {
      stylesheet = true;
    } else if (token.LowerCaseEqualsLiteral("preload")) {
      preload = true;
    } else if (token.LowerCaseEqualsLiteral("alternate")) {
      alternate = true;
    }
  }
  if (const auto* media = aTag.Attr("media")) {
    nsString value = AttrValue(*media);
    if (!value.IsEmpty() && !value.LowerCaseEqualsLiteral("all") &&
        !value.LowerCaseEqualsLiteral("screen")) {
      return;
    }
  }

  PreloadHint hint;
  LinkHeader& link = hint.mLink;
  link.mHref = AttrValue(*href);
  link.mRel.AssignLiteral(u"preload");
  if (preload) {
    const auto* as = aTag.Attr("as");
    if (!as) {
      return;
    }
    link.mAs = AttrValue(*as);
    if (const auto* srcset = aTag.Attr("imagesrcset")) {
      link.mSrcset = AttrValue(*srcset);
    }
  } else if (stylesheet && !alternate && !aTag.Attr("disabled")) {
    link.mAs.AssignLiteral(u"style");
    hint.mBlocking = true;
  } else {
    return;
  }
  CopyFetchAttrs(aTag, link);
  aHints.AppendElement(std::move(hint));
}

void MaybeAddScript(const ScannedTag& aTag, nsTArray<PreloadHint>& aHints) {
  const auto* src = aTag.Attr("src");
  // Async and deferred scripts don't block rendering; loading them early only
  // competes with what does, and can pull in more work before the load event.
  if (!src || src->empty() || aTag.Attr("nomodule") || aTag.Attr("async") ||
      aTag.Attr("defer")) {
    return;
  }
  // Module scripts are left to the document; their fetch mode differs.
  if (const auto* type = aTag.Attr("type")) {
    nsString value = AttrValue(*type);
    if (!value.IsEmpty() && !value.LowerCaseEqualsLiteral("text/javascript") &&
        !value.LowerCaseEqualsLiteral("application/javascript")) {
      return;
    }
  }
  PreloadHint hint;
  hint.mLink.mHref = AttrValue(*src);
  hint.mLink.mRel.AssignLiteral(u"preload");
  hint.mLink.mAs.AssignLiteral(u"script");
  CopyFetchAttrs(aTag, hint.mLink);
  aHints.AppendElement(std::move(hint));
}

bool IsSkippedContentElement(const ScannedTag& aTag) {
  return aTag.Is("script") || aTag.Is("style") || aTag.Is("noscript") ||
         aTag.Is("template") || aTag.Is("title") || aTag.Is("textarea");
}

// Returns the offset just past the end tag matching aName, or npos.
size_t SkipToEndTag(std::string_view aData, size_t aPos,
                    std::string_view aName) {
  while (true) {
    size_t lt = aData.find("</", aPos);
    if (lt == std::string_view::npos) {
      return lt;
    }
    ScannedTag tag;
    size_t next = ParseTag(aData, lt + 1, tag);
    if (next == std::string_view::npos) {
      return next;
    }
    if (tag.mEnd && EqualsIgnoreCase(tag.mName, aName)) {
      return next;
    }
    aPos = lt + 2;
  }
}

}  // namespace

/* static */
bool EarlyHintsService::ScanDocumentHead(const nsACString& aData,
                                         nsTArray<PreloadHint>& aHints) {
  std::string_view data(
      aData.BeginReading(),
      std::min<size_t>(aData.Length(), kMaxDocumentScanBytes));
  if (data.size() >= 2 && ((data[0] == '\xFE' && data[1] == '\xFF') ||
                           (data[0] == '\xFF' && data[1] == '\xFE'))) {
    return true;
  }
  bool atLimit = aData.Length() >= kMaxDocumentScanBytes;
  size_t pos = 0;
  while (true) {
    if (aHints.Length() >= kMaxDocumentHints) {
      return true;
    }
    size_t lt = data.find('<', pos);
    if (lt == std::string_view::npos) {
      return atLimit;
    }
    pos = lt + 1;
    if (data.substr(pos, 3) == "!--") {
      size_t end = data.find("-->", pos + 3);
      if (end == std::string_view::npos) {
        return atLimit;
      }
      pos = end + 3;
      continue;
    }
    if (pos < data.size() && (data[pos] == '!' || data[pos] == '?')) {
      size_t gt = data.find('>', pos);
      if (gt == std::string_view::npos) {
        return atLimit;
      }
      pos = gt + 1;
      continue;
    }
    ScannedTag tag;
    size_t next = ParseTag(data, pos, tag);
    if (next == std::string_view::npos) {
      return atLimit;
    }
    pos = next;
    if (tag.mName.empty()) {
      continue;
    }
    if (tag.mEnd) {
      if (tag.Is("head")) {
        return true;
      }
      continue;
    }
    if (tag.Is("body") || tag.Is("base")) {
      return true;
    }
    if (tag.Is("meta")) {
      const auto* equiv = tag.Attr("http-equiv");
      if (equiv && EqualsIgnoreCase(*equiv, "content-security-policy")) {
        return true;
      }
      continue;
    }
    if (tag.Is("link")) {
      MaybeAddLink(tag, aHints);
      continue;
    }
    if (tag.Is("script")) {
      MaybeAddScript(tag, aHints);
    }
    if (IsSkippedContentElement(tag)) {
      pos = SkipToEndTag(data, pos, tag.mName);
      if (pos == std::string_view::npos) {
        return atLimit;
      }
    }
  }
}

EarlyHintsService::EarlyHintsService()
    : mOngoingEarlyHints(new OngoingEarlyHints()) {}

// implementing the destructor in the .cpp file to allow EarlyHintsService.h
// not to include EarlyHintPreloader.h, decoupling the two files and hopefully
// allow faster compile times
EarlyHintsService::~EarlyHintsService() = default;

void EarlyHintsService::EarlyHint(
    const nsACString& aLinkHeader, nsIURI* aBaseURI, nsIChannel* aChannel,
    const nsACString& aReferrerPolicy, const nsACString& aCSPHeader,
    const nsACString& aConnectionAllowlistHeader,
    dom::CanonicalBrowsingContext* aLoadingBrowsingContext) {
  mEarlyHintsCount++;
  if (mFirstEarlyHint.isNothing()) {
    mFirstEarlyHint.emplace(TimeStamp::NowLoRes());
  } else {
    // Only allow one early hint response with link headers. See
    // https://html.spec.whatwg.org/multipage/semantics.html#early-hints
    // > Note: Only the first early hint response served during the navigation
    // > is handled, and it is discarded if it is succeeded by a cross-origin
    // > redirect.
    return;
  }

  // TODO: find out why LinkHeaderParser uses utf16 and check if it can be
  //       changed to utf8
  nsTArray<PreloadHint> hints;
  for (auto& link : ParseLinkHeader(NS_ConvertUTF8toUTF16(aLinkHeader))) {
    hints.AppendElement(PreloadHint{std::move(link)});
  }
  ProcessLinks(hints, aBaseURI, aChannel, aReferrerPolicy, aCSPHeader,
               aConnectionAllowlistHeader, aLoadingBrowsingContext);
}

void EarlyHintsService::DocumentHints(
    const nsTArray<PreloadHint>& aHints, nsIURI* aBaseURI, nsIChannel* aChannel,
    const nsACString& aReferrerPolicy, const nsACString& aCSPHeader,
    const nsACString& aConnectionAllowlistHeader,
    dom::CanonicalBrowsingContext* aLoadingBrowsingContext) {
  ProcessLinks(aHints, aBaseURI, aChannel, aReferrerPolicy, aCSPHeader,
               aConnectionAllowlistHeader, aLoadingBrowsingContext);
}

void EarlyHintsService::ProcessLinks(
    const nsTArray<PreloadHint>& aHints, nsIURI* aBaseURI, nsIChannel* aChannel,
    const nsACString& aReferrerPolicy, const nsACString& aCSPHeader,
    const nsACString& aConnectionAllowlistHeader,
    dom::CanonicalBrowsingContext* aLoadingBrowsingContext) {
  nsCOMPtr<nsILoadInfo> loadInfo = aChannel->LoadInfo();
  // We only follow Early Hints sent on the main document. Make sure that we got
  // the main document channel here.
  if (loadInfo->GetExternalContentPolicyType() !=
      ExtContentPolicy::TYPE_DOCUMENT) {
    MOZ_ASSERT(false, "Early Hint on non-document channel");
    return;
  }
  nsCOMPtr<nsIPrincipal> principal;
  // We want to set the top-level document as the triggeringPrincipal for the
  // load of the sub-resources (image, font, fetch, script, style, fetch and in
  // the future maybe more). We can't use the `triggeringPrincipal` of the main
  // document channel, because it is the `systemPrincipal` for user initiated
  // loads. Same for the `LoadInfo::FindPrincipalToInherit(aChannel)`.
  //
  // On 3xx redirects of the main document to cross site locations, all Early
  // Hint preloads get cancelled as specified in the whatwg spec:
  //
  //   Note: Only the first early hint response served during the navigation is
  //   handled, and it is discarded if it is succeeded by a cross-origin
  //   redirect. [1]
  //
  // Therefore the channel doesn't need to change the principal for any reason
  // and has the correct principal for the whole lifetime.
  //
  // [1]: https://html.spec.whatwg.org/multipage/semantics.html#early-hints
  nsresult rv = nsContentUtils::GetSecurityManager()->GetChannelResultPrincipal(
      aChannel, getter_AddRefs(principal));
  NS_ENSURE_SUCCESS_VOID(rv);

  nsCOMPtr<nsICookieJarSettings> cookieJarSettings;
  if (NS_FAILED(
          loadInfo->GetCookieJarSettings(getter_AddRefs(cookieJarSettings)))) {
    return;
  }

  for (const auto& hint : aHints) {
    const LinkHeader& linkHeader = hint.mLink;
    if (linkHeader.mRel.LowerCaseEqualsLiteral("preconnect")) {
      mLinkType |= dom::LinkStyle::ePRECONNECT;
      OriginAttributes originAttributes;
      StoragePrincipalHelper::GetOriginAttributesForNetworkState(
          aChannel, originAttributes);
      EarlyHintPreconnect::MaybePreconnect(linkHeader, aBaseURI,
                                           std::move(originAttributes));
    } else if (linkHeader.mRel.LowerCaseEqualsLiteral("preload")) {
      mLinkType |= dom::LinkStyle::ePRELOAD;
      EarlyHintPreloader::MaybeCreateAndInsertPreload(
          mOngoingEarlyHints, linkHeader, aBaseURI, principal,
          cookieJarSettings, aReferrerPolicy, aCSPHeader,
          aConnectionAllowlistHeader, loadInfo->GetBrowsingContextID(),
          aLoadingBrowsingContext, false, hint.mBlocking);
    } else if (linkHeader.mRel.LowerCaseEqualsLiteral("modulepreload")) {
      mLinkType |= dom::LinkStyle::eMODULE_PRELOAD;
      EarlyHintPreloader::MaybeCreateAndInsertPreload(
          mOngoingEarlyHints, linkHeader, aBaseURI, principal,
          cookieJarSettings, aReferrerPolicy, aCSPHeader,
          aConnectionAllowlistHeader, loadInfo->GetBrowsingContextID(),
          aLoadingBrowsingContext, true, false);
    } else if (linkHeader.mRel.LowerCaseEqualsLiteral(
                   "compression-dictionary")) {
      mLinkType |= dom::LinkStyle::eCOMPRESSION_DICTIONARY;
      EarlyHintPreloader::MaybeCreateAndInsertPreload(
          mOngoingEarlyHints, linkHeader, aBaseURI, principal,
          cookieJarSettings, aReferrerPolicy, aCSPHeader,
          aConnectionAllowlistHeader, loadInfo->GetBrowsingContextID(),
          aLoadingBrowsingContext, true, false);
    }
  }
}

void EarlyHintsService::Cancel(const nsACString& aReason) {
  Reset();
  mOngoingEarlyHints->CancelAll(aReason);
}

void EarlyHintsService::RegisterLinksAndGetConnectArgs(
    dom::ContentParentId aCpId, nsTArray<EarlyHintConnectArgs>& aOutLinks) {
  mOngoingEarlyHints->RegisterLinksAndGetConnectArgs(aCpId, aOutLinks);
}

void EarlyHintsService::Reset() {
  if (mEarlyHintsCount == 0) {
    return;
  }
  // Reset telemetry counters and timestamps.
  mEarlyHintsCount = 0;
  mFirstEarlyHint = Nothing();
}

}  // namespace mozilla::net
