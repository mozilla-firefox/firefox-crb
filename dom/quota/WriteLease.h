/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef DOM_QUOTA_WRITELEASE_H_
#define DOM_QUOTA_WRITELEASE_H_

#include "mozilla/RefPtr.h"

namespace mozilla::dom::quota {

class OriginInfo;

// Move-only token for a write lease taken with QuotaManager::AcquireWriteLease
// or TryAcquireWriteLease. Releasing the lease happens in the destructor, which
// may run on any thread but must not run while mQuotaMutex is held. An empty
// token (no OriginInfo) is valid and releases nothing.
class WriteLease final {
 public:
  WriteLease();

  explicit WriteLease(RefPtr<OriginInfo> aOriginInfo);

  WriteLease(const WriteLease&) = delete;
  WriteLease& operator=(const WriteLease&) = delete;

  WriteLease(WriteLease&& aOther) noexcept;
  WriteLease& operator=(WriteLease&& aOther) noexcept;

  ~WriteLease();

 private:
  RefPtr<OriginInfo> mOriginInfo;
};

}  // namespace mozilla::dom::quota

#endif  // DOM_QUOTA_WRITELEASE_H_
