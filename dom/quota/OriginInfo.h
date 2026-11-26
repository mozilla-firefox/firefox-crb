/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef DOM_QUOTA_ORIGININFO_H_
#define DOM_QUOTA_ORIGININFO_H_

#include "Assertions.h"
#include "ClientUsageArray.h"
#include "mozilla/StaticString.h"
#include "mozilla/ThreadSafeWeakPtr.h"
#include "mozilla/dom/quota/QuotaManager.h"

namespace mozilla::dom::quota {

class DirtyTrackingAutoLock;

class CanonicalQuotaObject;
class GroupInfo;
class OriginUpserter;

class OriginInfo final : public SupportsThreadSafeWeakPtr<OriginInfo> {
  friend class CanonicalQuotaObject;
  friend class GroupInfo;
  friend class PersistOp;
  friend class QuotaManager;
  friend class SupportsThreadSafeWeakPtr<OriginInfo>;

 public:
  MOZ_DECLARE_REFCOUNTED_TYPENAME(OriginInfo)

  OriginInfo(GroupInfo* aGroupInfo, const nsACString& aOrigin,
             const nsACString& aStorageOrigin, bool aIsPrivate,
             bool aIsEncrypted, const ClientUsageArray& aClientUsages,
             int64_t aUsage, int64_t aAccessTime, int32_t aMaintenanceDate,
             bool aPersisted, bool aDirectoryExists);

  GroupInfo* GetGroupInfo() const { return mGroupInfo; }

  const nsCString& Origin() const { return mOrigin; }

  int64_t LockedUsage() const;

  int64_t LockedAccessTime() const {
    AssertCurrentThreadOwnsQuotaMutex();

    return mAccessTime;
  }

  int32_t LockedMaintenanceDate() const {
    AssertCurrentThreadOwnsQuotaMutex();

    return mMaintenanceDate;
  }

  bool LockedAccessed() const {
    AssertCurrentThreadOwnsQuotaMutex();

    return mAccessed;
  }

  bool LockedPersisted() const {
    AssertCurrentThreadOwnsQuotaMutex();

    return mPersisted;
  }

  bool LockedDirty() const {
    AssertCurrentThreadOwnsQuotaMutex();

    return IsDirty();
  }

  // See mDirtyOnDisk.
  bool LockedDirtyOnDisk() const {
    AssertCurrentThreadOwnsQuotaMutex();

    return mDirtyOnDisk;
  }

  bool LockedHasWriteLease() const {
    AssertCurrentThreadOwnsQuotaMutex();

    return mWriteLeaseCount != 0;
  }

  bool IsPrivate() const { return mIsPrivate; }

  bool IsEncrypted() const { return mIsEncrypted; }

  bool IsExtensionOrigin() const { return mIsExtension; }

  bool LockedDirectoryExists() const {
    AssertCurrentThreadOwnsQuotaMutex();

    return mDirectoryExists;
  }

  void LockedSetClean() {
    AssertCurrentThreadOwnsQuotaMutex();
    mMetadataDirty = false;
    mDirtyOnDisk = false;
    mCacheRowStale = false;
  }

  bool LockedCacheRowStale() const {
    AssertCurrentThreadOwnsQuotaMutex();

    return mCacheRowStale;
  }

  void LockedClearCacheRowStale() {
    AssertCurrentThreadOwnsQuotaMutex();
    mCacheRowStale = false;
  }

  void LockedSetCacheRowStale() {
    AssertCurrentThreadOwnsQuotaMutex();
    mCacheRowStale = true;
  }

  OriginMetadata FlattenToOriginMetadata() const;

  OriginStateMetadata LockedFlattenToOriginStateMetadata() const;

  FullOriginMetadata LockedFlattenToFullOriginMetadata() const;

  nsresult LockedBindToStatement(mozIStorageStatement* aStatement) const;

 private:
  // Private destructor, to discourage deletion outside of Release():
  ~OriginInfo() {
    MOZ_COUNT_DTOR(OriginInfo);

    MOZ_ASSERT(!mCanonicalQuotaObjects.Count());
  }

  void LockedDecreaseUsage(Client::Type aClientType, int64_t aSize,
                           DirtyTrackingAutoLock& aProofOfLock);

  void LockedResetUsageForClient(Client::Type aClientType,
                                 DirtyTrackingAutoLock& aProofOfLock);

  UsageInfo LockedGetUsageForClient(Client::Type aClientType);

  void LockedUpdateAccessTime(int64_t aAccessTime,
                              DirtyTrackingAutoLock& aProofOfLock) {
    AssertCurrentThreadOwnsQuotaMutex();

    mAccessTime = aAccessTime;
    MakeDirty(aProofOfLock);
    if (!mAccessed) {
      mAccessed = true;
    }
  }

  void LockedUpdateMaintenanceDate(int32_t aMaintenanceDate) {
    AssertCurrentThreadOwnsQuotaMutex();

    mMaintenanceDate = aMaintenanceDate;
  }

  void LockedUpdateAccessed(DirtyTrackingAutoLock& aProofOfLock) {
    AssertCurrentThreadOwnsQuotaMutex();

    if (!mAccessed) {
      mAccessed = true;
      MakeDirty(aProofOfLock);
    }
  }

  void LockedPersist(DirtyTrackingAutoLock& aProofOfLock);

  void LockedDirectoryCreated();

  void LockedTruncateUsages(Client::Type aClientType, int64_t aDelta,
                            DirtyTrackingAutoLock& aProofOfLock);

  Maybe<bool> LockedUpdateUsages(Client::Type aClientType, int64_t aDelta,
                                 DirtyTrackingAutoLock& aProofOfLock);

  bool LockedUpdateUsagesForEviction(Client::Type aClientType, int64_t aDelta,
                                     DirtyTrackingAutoLock& aProofOfLock);

  constexpr TimeStamp GetLastModifiedTime() const { return mLastModifiedTime; }

  bool CheckIfUsageIsConsistent(const nsACString& context) const;

  nsTHashMap<nsStringHashKey, NotNull<CanonicalQuotaObject*>>
      mCanonicalQuotaObjects;
  GroupInfo* mGroupInfo;
  const nsCString mOrigin;
  const nsCString mStorageOrigin;
  int64_t mAccessTime;
  int32_t mMaintenanceDate;
  bool mIsPrivate;
  bool mIsEncrypted;
  bool mAccessed;
  bool mPersisted;
  const bool mIsExtension;
  /**
   * In some special cases like the LocalStorage client where it's possible to
   * create a Quota-using representation but not actually write any data, we
   * want to be able to track quota for an origin without creating its origin
   * directory or the per-client files until they are actually needed to store
   * data. In those cases, the OriginInfo will be created by
   * InitQuotaForOrigin and the resulting mDirectoryExists will be false until
   * the origin actually needs to be created. It is possible for mUsage to be
   * greater than zero while mDirectoryExists is false, representing a state
   * where a client like LocalStorage has reserved quota for disk writes, but
   * has not yet flushed the data to disk.
   */
  bool mDirectoryExists;

 private:
  bool IsDirty() const { return mMetadataDirty; }

  void MakeDirty(DirtyTrackingAutoLock& aProofOfLock);

  // Records the quotamanager.usage_underflow event if aUsage is negative.
  void LockedMaybeRecordUsageUnderflow(Client::Type aClientType, int64_t aUsage,
                                       StaticString aCallSite);

  // Sets the in-memory dirty flag and, if the origin directory exists, queues
  // the origin for a metadata flush.
  void LockedMarkDirty();

  // LockedMarkDirty plus a note that the dirty flag was just recorded in the
  // storage database (see QuotaManager::FlagOriginInfoAsDirtyOnDisk).
  void LockedMarkDirtyOnDisk();

  void LockedAcquireWriteLease();

  void LockedReleaseWriteLease();

  ClientUsageArray mClientUsages;
  // Per client, how many times a negative usage was seen for this OriginInfo.
  // Used to throttle usage_underflow telemetry events.
  Array<uint32_t, Client::TYPE_MAX> mUsageUnderflowCount{};

  // Signed for the same reason as QuotaManager::mTemporaryStorageUsage: though
  // it shouldn't go negative, in case that happens (transient state or bug
  // elsewhere) don't let the value underflow, which would result in a huge
  // number, making all integers comparisons to become buggy. See bug 2066923
  // and bug 1585978 for details.
  int64_t mUsage;
  TimeStamp mLastModifiedTime;
  bool mMetadataDirty = false;
  // Whether this origin's row in the storage database is missing or does not
  // match this OriginInfo. Set during origin initialization: true when
  // InitQuotaForOrigin found no row for the origin, or a row that differs
  // from the metadata obtained from disk. PopulateCacheAfterScan and
  // UnloadQuota upsert every such row; the cache is marked complete only
  // when no origin has a stale row left. Cleared whenever a full row is
  // upserted from this OriginInfo. Independent of mDirtyOnDisk, which is
  // about one bit of a row that already exists.
  bool mCacheRowStale = true;
  // Whether the Dirty bit is known to be set in this origin's row of the
  // storage database, i.e. the origin has already been recorded on disk as
  // dirty. Set once a write lease recorded the bit, or the row was created
  // with it, so later leases can skip that IO. Says nothing about the other
  // columns of the row. Conservatively false after initialization even if
  // the row is dirty, so the first lease always records it. Cleared when the
  // row is settled clean.
  bool mDirtyOnDisk = false;
  uint64_t mWriteLeaseCount = 0;
};

class OriginInfoAccessTimeComparator {
 public:
  bool Equals(const NotNull<RefPtr<const OriginInfo>>& a,
              const NotNull<RefPtr<const OriginInfo>>& b) const {
    return a->LockedAccessTime() == b->LockedAccessTime();
  }

  bool LessThan(const NotNull<RefPtr<const OriginInfo>>& a,
                const NotNull<RefPtr<const OriginInfo>>& b) const {
    return a->LockedAccessTime() < b->LockedAccessTime();
  }
};

}  // namespace mozilla::dom::quota

#endif  // DOM_QUOTA_ORIGININFO_H_
