/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef DOM_QUOTA_CONSTANTS_H_
#define DOM_QUOTA_CONSTANTS_H_

#include "nsLiteralString.h"
#include "prtime.h"

// The name of the file that we use to load/save the last access time of an
// origin.
// XXX We should get rid of old metadata files at some point, bug 1343576.
#define METADATA_FILE_NAME u".metadata"
#define METADATA_TMP_FILE_NAME u".metadata-tmp"
#define METADATA_V2_FILE_NAME u".metadata-v2"
#define METADATA_V2_TMP_FILE_NAME u".metadata-v2-tmp"

namespace mozilla::dom::quota {

// Seconds in one day (24 * 60 * 60). Used for time based calculations across
// quota manager code.
constexpr int64_t kSecPerDay = 86400;

// Seconds in one week.
constexpr int64_t kSecPerWeek = 7 * kSecPerDay;

// Default cutoff access time (in microseconds) used for temporary storage
// cleanup. Corresponds to "one week ago" and is used as the threshold when
// clearing non persisted zero usage origins.
constexpr int64_t aDefaultCutoffAccessTime = kSecPerWeek * PR_USEC_PER_SEC;

constexpr int64_t kDefaultLastAccessTime = 0;

const char kChromeOrigin[] = "chrome";

constexpr auto kSQLiteSuffix = u".sqlite"_ns;

constexpr nsLiteralCString kUUIDOriginScheme = "uuid"_ns;

// Special value used when quota version is unknown or not applicable.
//
// This is used in the following cases:
// - When loading quota info from the L1 cache (see LoadQuota)
// - When reading a metadata file that hasn't yet been upgraded to include the
//   quota version field
// - When the metadata file is missing or corrupted and must be restored
//
// In these situations, the quota version is effectively undefined and cannot
// be trusted.
const uint32_t kNoQuotaVersion = 0;

// Version of the .metadata-v2 file format written by this build.
//
// The file is written together with the storage database row by
// QuotaManager::CreateDirectoryMetadata2, which is reached from:
// - QuotaManager::GetOrCreateTemporaryOriginDirectory and
//   QuotaManager::EnsurePersistentOriginIsInitializedInternal when an origin
//   directory is created
// - QuotaManager::EnsureTemporaryOriginIsInitializedInternal when an existing
//   directory is initialized for the first time in a session
// - PersistOp when the persisted flag changes
// - indexedDB::Maintenance after maintenance updates the accessed flag and
//   the maintenance date
// The storage upgrade and RestoreDirectoryMetadata2Helper paths write the
// legacy layout without a version field, which reads back as
// kNoQuotaVersion.
//
// Since version 3 the file is a recovery-only identity store. Origin usage
// and client usages are written as zero and are never read back; the storage
// database is the source of truth and a full directory scan recomputes usage
// when the database can't be used.
//
// The bump to 3 exists for older builds. A build whose current version is 2
// accepts a file at or below its own version and, when the file's accessed
// flag is clear, seeds its in-memory quota from the usage fields without
// scanning. With this build's files that would mean zero usage for every
// such origin after a profile downgrade. Version 3 is above what those builds
// accept, so they fall back to a full directory scan instead. Files written
// before this build keep version 2 and their old usage values, so older
// builds handle them as before.
const uint32_t kCurrentQuotaVersion = 3;

}  // namespace mozilla::dom::quota

#endif  // DOM_QUOTA_CONSTANTS_H_
