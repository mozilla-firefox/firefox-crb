/* -*- Mode: C++; tab-width: 8; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef mozilla_dom_PrefetchTypes_h
#define mozilla_dom_PrefetchTypes_h

#include "mozilla/Assertions.h"
#include "mozilla/TimeStamp.h"
#include "nsCOMPtr.h"
#include "nsIURI.h"
#include "nsString.h"
#include "nsTArray.h"

namespace mozilla::dom {

// Speculation Rules Prefetch — shared types used by both child- and
// parent-side actors and by the DOM-side SpeculationRulesManager.
// Spec: https://wicg.github.io/nav-speculation/prefetch.html

// Spec: https://wicg.github.io/nav-speculation/prefetch.html#prefetch-record
// (the `state` field).
enum class PrefetchState : uint8_t {
  Ongoing,
  Completed,
  Canceled,
  // Candidate recorded but never fetched; experiment control branch.
  DryRun,
};

// Outcome of a navigation a prefetch candidate covered. Ordered closest to
// served first: with several candidates, the lowest value is reported.
enum class PrefetchNavigationResult : uint8_t {
  Served,
  CacheMiss,
  Expired,
  HintMismatch,
  WaitTimeout,
  HttpError,
  TooLarge,
  NetworkError,
  Canceled,
  DryRun,
  NavigationCanceled,
};

inline nsLiteralCString PrefetchNavigationResultLabel(
    PrefetchNavigationResult aResult) {
  switch (aResult) {
    case PrefetchNavigationResult::Served:
      return "served"_ns;
    case PrefetchNavigationResult::CacheMiss:
      return "cache_miss"_ns;
    case PrefetchNavigationResult::Expired:
      return "expired"_ns;
    case PrefetchNavigationResult::HintMismatch:
      return "hint_mismatch"_ns;
    case PrefetchNavigationResult::WaitTimeout:
      return "wait_timeout"_ns;
    case PrefetchNavigationResult::HttpError:
      return "http_error"_ns;
    case PrefetchNavigationResult::TooLarge:
      return "too_large"_ns;
    case PrefetchNavigationResult::NetworkError:
      return "network_error"_ns;
    case PrefetchNavigationResult::Canceled:
      return "canceled"_ns;
    case PrefetchNavigationResult::DryRun:
      return "dry_run"_ns;
    case PrefetchNavigationResult::NavigationCanceled:
      return "navigation_canceled"_ns;
  }
  MOZ_ASSERT_UNREACHABLE("Unknown PrefetchNavigationResult");
  return "canceled"_ns;
}

// Spec:
// https://wicg.github.io/nav-speculation/prefetch.html#prefetch-ip-anonymization-policy
// Wire format uses `bool anonymizeClientIP`; the enum exists for clarity
// at C++ call sites.
enum class PrefetchAnonymizationPolicy : uint8_t {
  None,
  AnonymousClientIPWhenCrossOrigin,
};

// Spec: https://wicg.github.io/nav-speculation/prefetch.html#prefetch-record
// (the `source` field).
enum class PrefetchSource : uint8_t {
  SpeculationRules,
};

// Per-hop redirect chain entry on PrefetchRecordParent.
// Spec: https://wicg.github.io/nav-speculation/prefetch.html#prefetch-record
// (the `redirect chain` field).
// Body for each hop lives in the HTTP cache, keyed by (URI, OriginAttributes).
struct ExchangeRecord {
  nsCOMPtr<nsIURI> mRequestURI;
  // M2 placeholder; unused in M1 (URL + partition suffices for same-origin
  // cache lookup).
  nsCString mResponseCacheKey;
  uint32_t mResponseStatus = 0;
  // Raw `No-Vary-Search` response header; parsed at match time via
  // NoVarySearchUtils (bug 2038006).
  nsCString mNoVarySearchHeader;
};

}  // namespace mozilla::dom

#endif  // mozilla_dom_PrefetchTypes_h
