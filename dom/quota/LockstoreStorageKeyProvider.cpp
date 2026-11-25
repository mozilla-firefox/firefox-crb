/* -*- Mode: C++; tab-width: 8; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* vim: set ts=8 sts=2 et sw=2 tw=80: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "mozilla/dom/quota/LockstoreStorageKeyProvider.h"

#include <tuple>

#include "mozilla/dom/quota/DekNameCodec.h"
#include "mozilla/dom/quota/QuotaCommon.h"
#include "mozilla/security/lockstore/ProfileKek.h"
#include "nsThreadUtils.h"
#include "nsXULAppAPI.h"

namespace mozilla::dom::quota {

static constexpr auto kDekPrefix = "dom-quota:"_ns;

// static
already_AddRefed<LockstoreStorageKeyProvider>
LockstoreStorageKeyProvider::Create(const nsACString& aProfileId) {
  MOZ_ASSERT(XRE_IsParentProcess());
  MOZ_ASSERT(NS_IsMainThread());

  RefPtr<mozilla::security::lockstore::LockstoreService> lockstore =
      mozilla::security::lockstore::LockstoreService::GetSingleton();
  if (!lockstore) {
    return nullptr;
  }

  return do_AddRef(
      new LockstoreStorageKeyProvider(lockstore.forget(), aProfileId));
}

LockstoreStorageKeyProvider::LockstoreStorageKeyProvider(
    already_AddRefed<mozilla::security::lockstore::LockstoreService> aLockstore,
    const nsACString& aProfileId)
    : mLockstore(aLockstore), mProfileId(aProfileId) {
  MOZ_ASSERT(mLockstore);
}

nsCString LockstoreStorageKeyProvider::DekName(const nsACString& aOrigin,
                                               const nsACString& aClientType,
                                               const nsACString& aKeyId) const {
  return DekNameCodec::Build({mProfileId, nsCString(aOrigin),
                              nsCString(DekNameCodec::kNilBottleUUID),
                              nsCString(aClientType), nsCString(aKeyId)});
}

Result<Maybe<NSSCipherStrategy::KeyType>, nsresult>
LockstoreStorageKeyProvider::Get(const nsACString& aOrigin,
                                 const nsACString& aClientType,
                                 const nsACString& aKeyId) {
  const nsCString dekName = DekName(aOrigin, aClientType, aKeyId);

  // Probing first keeps the lockstore from logging a missing DEK as an
  // error on every first use of a key.
  QM_TRY_INSPECT(const bool& exists, mLockstore->DoDekExists(dekName));
  if (!exists) {
    return Maybe<NSSCipherStrategy::KeyType>(Nothing());
  }

  QM_TRY_INSPECT(const auto& bytes, mLockstore->DoGetDekAutomatic(dekName));
  if (bytes.Length() != std::tuple_size_v<NSSCipherStrategy::KeyType>) {
    return Err(NS_ERROR_UNEXPECTED);
  }

  NSSCipherStrategy::KeyType key{};
  std::copy_n(bytes.Elements(), key.size(), key.begin());
  return Some(key);
}

nsresult LockstoreStorageKeyProvider::Put(
    const nsACString& aOrigin, const nsACString& aClientType,
    const nsACString& aKeyId, const NSSCipherStrategy::KeyType& aKey) {
  QM_TRY_INSPECT(
      const auto& kekName,
      mozilla::security::lockstore::GetActiveProfileKek(*mLockstore));

  nsTArray<uint8_t> keyBytes;
  keyBytes.AppendElements(aKey.data(), aKey.size());

  return mLockstore->DoImportDek(DekName(aOrigin, aClientType, aKeyId), kekName,
                                 keyBytes,
                                 /* extractable */ true);
}

nsresult LockstoreStorageKeyProvider::Remove(const nsACString& aOrigin) {
  auto deksResult = mLockstore->DoListDeks();
  if (deksResult.isErr()) {
    return deksResult.unwrapErr();
  }

  nsCString prefix = DekNameCodec::OriginPrefix(mProfileId, nsCString(aOrigin));

  nsresult firstError = NS_OK;
  for (const auto& name : deksResult.inspect()) {
    if (StringBeginsWith(name, prefix)) {
      nsresult rv = mLockstore->DoDeleteDek(name);
      if (NS_FAILED(rv) && NS_SUCCEEDED(firstError)) {
        firstError = rv;
      }
    }
  }
  return firstError;
}

nsresult LockstoreStorageKeyProvider::Clear() {
  auto deksResult = mLockstore->DoListDeks();
  if (deksResult.isErr()) {
    return deksResult.unwrapErr();
  }

  nsresult firstError = NS_OK;
  for (const auto& name : deksResult.inspect()) {
    if (StringBeginsWith(name, kDekPrefix)) {
      nsresult rv = mLockstore->DoDeleteDek(name);
      if (NS_FAILED(rv) && NS_SUCCEEDED(firstError)) {
        firstError = rv;
      }
    }
  }
  return firstError;
}

void LockstoreStorageKeyProvider::Close() {}

}  // namespace mozilla::dom::quota
