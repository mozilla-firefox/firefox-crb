/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "IndexedDBCommon.h"

#include "ReportInternalError.h"
#include "js/StructuredClone.h"
#include "mozilla/SnappyUncompressInputStream.h"
#include "mozilla/StaticPrefs_dom.h"
#include "mozilla/ipc/PBackgroundSharedTypes.h"
#include "nsError.h"
#include "nsIAddonPolicyService.h"

namespace mozilla::dom::indexedDB {

EnumSet<ValidatePrincipalOptions> PrincipalValidationOptions(
    const mozilla::ipc::PrincipalInfo& aPrincipalInfo) {
  EnumSet<ValidatePrincipalOptions> options;
  if (StaticPrefs::dom_indexedDB_testing_allowContentSystem() &&
      xpc::IsInAutomation()) {
    options += ValidatePrincipalOptions::AllowNotLoadedOrigin;
    options += ValidatePrincipalOptions::AlwaysAllowSystem;
  }
  // When a WebExtension accesses `browser.storage.local`, that is backed by
  // direct in-content access to IndexedDB with a special userContextId.
  // Because of this, all processes are allowed to access extension IndexedDB,
  // so long as that userContextId is in-use.
  if (aPrincipalInfo.type() ==
          mozilla::ipc::PrincipalInfo::TContentPrincipalInfo &&
      aPrincipalInfo.get_ContentPrincipalInfo().attrs().mUserContextId ==
          uint32_t(nsIAddonPolicyService::STORAGE_LOCAL_USER_CONTEXT_ID)) {
    options += ValidatePrincipalOptions::AlwaysAllowExtension;
  }
  return options;
}

nsresult ClampResultCode(nsresult aResultCode) {
  if (NS_SUCCEEDED(aResultCode) ||
      NS_ERROR_GET_MODULE(aResultCode) == NS_ERROR_MODULE_DOM_INDEXEDDB) {
    return aResultCode;
  }

  switch (aResultCode) {
    case NS_ERROR_FILE_NO_DEVICE_SPACE:
      return NS_ERROR_DOM_INDEXEDDB_QUOTA_ERR;
    case NS_ERROR_STORAGE_CONSTRAINT:
      return NS_ERROR_DOM_INDEXEDDB_CONSTRAINT_ERR;
    case NS_ERROR_CORRUPTED_CONTENT:
    case NS_ERROR_FILE_CORRUPTED:
    case NS_ERROR_FILE_NOT_FOUND:
    case NS_ERROR_FILE_ACCESS_DENIED:
    case NS_ERROR_STORAGE_IOERR:
      return NS_ERROR_DOM_INDEXEDDB_NOT_READABLE_ERR;
    default:
#ifdef DEBUG
      nsPrintfCString message("Converting non-IndexedDB error code (0x%" PRIX32
                              ") to "
                              "NS_ERROR_DOM_INDEXEDDB_UNKNOWN_ERR",
                              static_cast<uint32_t>(aResultCode));
      NS_WARNING(message.get());
#else
        ;
#endif
  }

  IDB_REPORT_INTERNAL_ERR();
  return NS_ERROR_DOM_INDEXEDDB_UNKNOWN_ERR;
}

// aStructuredCloneData is a parameter rather than a return value because one
// caller preallocates it on the heap not immediately before calling for some
// reason. Maybe this could be changed.
nsresult SnappyUncompressStructuredCloneData(
    nsIInputStream& aInputStream, JSStructuredCloneData& aStructuredCloneData) {
  const auto snappyInputStream =
      MakeRefPtr<SnappyUncompressInputStream>(&aInputStream);

  char buffer[kFileCopyBufferSize];

  QM_TRY(CollectEach(
      [&snappyInputStream = *snappyInputStream, &buffer] {
        QM_TRY_RETURN(MOZ_TO_RESULT_INVOKE_MEMBER(snappyInputStream, Read,
                                                  buffer, sizeof(buffer)));
      },
      [&aStructuredCloneData,
       &buffer](const uint32_t& numRead) -> Result<Ok, nsresult> {
        QM_TRY(OkIf(aStructuredCloneData.AppendBytes(buffer, numRead)),
               Err(NS_ERROR_OUT_OF_MEMORY));

        return Ok{};
      }));

  return NS_OK;
}

}  // namespace mozilla::dom::indexedDB
