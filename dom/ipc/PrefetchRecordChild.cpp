/* -*- Mode: C++; tab-width: 8; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "mozilla/dom/PrefetchRecordChild.h"

#include "mozilla/dom/Document.h"
#include "mozilla/dom/PrefetchLog.h"
#include "mozilla/dom/SpeculationRulesManager.h"
#include "mozilla/dom/WindowGlobalChild.h"
#include "mozilla/intl/FormatBuffer.h"
#include "mozilla/intl/LocaleService.h"
#include "mozilla/intl/NumberFormat.h"
#include "nsContentUtils.h"
#include "nsGlobalWindowInner.h"
#include "nsIScriptError.h"

namespace mozilla::dom {

// Formats a byte count as a localized size with its unit, e.g. "5 MB".
static nsAutoString FormatSize(uint32_t aBytes) {
  std::string_view unit = "byte";
  double value = aBytes;
  if (aBytes >= 1024 * 1024) {
    unit = "megabyte";
    value = aBytes / (1024.0 * 1024.0);
  } else if (aBytes >= 1024) {
    unit = "kilobyte";
    value = aBytes / 1024.0;
  }

  intl::NumberFormatOptions options;
  options.mStyle = intl::NumberFormatOptions::Style::Unit;
  options.mUnit =
      Some(std::make_pair(unit, intl::NumberFormatOptions::UnitDisplay::Short));
  options.mFractionDigits = Some(std::make_pair(0, 1));

  nsAutoCString locale;
  intl::LocaleService::GetInstance()->GetAppLocaleAsBCP47(locale);
  nsAutoString result;
  auto formatter = intl::NumberFormat::TryCreate(locale, options);
  if (formatter.isOk()) {
    intl::nsTStringToBufferAdapter adapter(result);
    if (formatter.unwrap()->format(value, adapter).isOk()) {
      return result;
    }
  }
  result.Truncate();
  result.AppendInt(aBytes);
  return result;
}

PrefetchRecordChild::PrefetchRecordChild(nsIURI* aURL,
                                         PrefetchAnonymizationPolicy aPolicy)
    : mURL(aURL), mAnonPolicy(aPolicy) {
  if (LOG_SPECRULES_ENABLED()) {
    nsAutoCString spec;
    if (mURL) {
      mURL->GetSpec(spec);
    }
    LOG_SPECRULES(("PrefetchRecordChild ctor: this=%p, url=%s, anon=%d", this,
                   spec.get(), static_cast<int>(mAnonPolicy)));
  }
}

void PrefetchRecordChild::ActorDestroy(ActorDestroyReason aReason) {
  // Remove this handle from SpeculationRulesManager::mPrefetchRecords on the
  // owning document. The window/document may already be torn down (tab close,
  // navigation, process shutdown) — bail safely if so.
  WindowGlobalChild* wgc = static_cast<WindowGlobalChild*>(Manager());
  if (!wgc) {
    return;
  }
  nsGlobalWindowInner* window = wgc->GetWindowGlobal();
  if (!window) {
    return;
  }
  Document* doc = window->GetExtantDoc();
  if (!doc) {
    return;
  }
  SpeculationRulesManager* srm = doc->GetSpeculationRulesManager();
  if (!srm) {
    return;
  }
  srm->RemoveRecord(this);
}

mozilla::ipc::IPCResult PrefetchRecordChild::RecvReportSizeLimitExceeded(
    const bool& aDocumentTotal, const uint32_t& aLimit) {
  WindowGlobalChild* wgc = static_cast<WindowGlobalChild*>(Manager());
  if (!wgc || !mURL) {
    return IPC_OK();
  }
  nsGlobalWindowInner* window = wgc->GetWindowGlobal();
  if (!window) {
    return IPC_OK();
  }
  Document* doc = window->GetExtantDoc();
  if (!doc) {
    return IPC_OK();
  }

  AutoTArray<nsString, 2> params = {
      NS_ConvertUTF8toUTF16(mURL->GetSpecOrDefault()), FormatSize(aLimit)};
  nsContentUtils::ReportToConsole(
      nsIScriptError::warningFlag, "Speculation Rules"_ns, doc,
      PropertiesFile::DOM_PROPERTIES,
      aDocumentTotal ? "SpeculationRulesPrefetchDocumentBytesExceeded"
                     : "SpeculationRulesPrefetchBodyTooLarge",
      params);
  return IPC_OK();
}

}  // namespace mozilla::dom
