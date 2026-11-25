/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include <cstring>

#include "CacheCrypto.h"
#include "Helpers.h"
#include "LockstoreService.h"
#include "gtest/gtest.h"
#include "mozilla/gtest/MozAssertions.h"
#include "mozilla/security/lockstore/ProfileKek.h"
#include "nsCOMPtr.h"
#include "nsIX509CertDB.h"
#include "nsServiceManagerUtils.h"
#include "nsTArray.h"
#include "nsThreadUtils.h"

using namespace mozilla;
using namespace mozilla::net;
using mozilla::security::lockstore::kProfileKekId;
using mozilla::security::lockstore::kProfileLocalKek;
using mozilla::security::lockstore::kProfilePasswordKek;
using mozilla::security::lockstore::LockstoreService;
using mozilla::security::lockstore::MoveProfileDeksToLocalKey;
using testing::RunOnBackground;

namespace {

// CacheCrypto needs NSS (PK11) and a loaded key. Getting the cert DB service
// initializes NSS; InitForTesting() then generates a throwaway key, depending
// on neither the "once"-mirrored enabled pref nor the profile keystore.
// Returns the usable instance, or null if setup failed.
static already_AddRefed<CacheCrypto> InitCryptoForTest() {
  nsCOMPtr<nsIX509CertDB> certDB(do_GetService(NS_X509CERTDB_CONTRACTID));
  EXPECT_TRUE(certDB);
  CacheCrypto::InitForTesting();
  return CacheCrypto::GetInstanceOrNull();
}

}  // namespace

TEST(CacheCrypto, RoundTrip)
{
  RefPtr<CacheCrypto> crypto = InitCryptoForTest();
  ASSERT_TRUE(crypto);

  // Length deliberately not a multiple of the AES block size.
  const char* msg = "The quick brown fox jumps over the lazy dog -- 0123456789";
  const uint32_t len = strlen(msg);

  nsTArray<uint8_t> block;
  block.SetLength(len + CacheCrypto::kBlockOverhead);
  nsTArray<uint8_t> roundtrip;
  roundtrip.SetLength(len);

  for (uint64_t blockNumber :
       {uint64_t(0), uint64_t(1), uint64_t(7), uint64_t(12345),
        CacheCrypto::kMetadataBlockNumber}) {
    ASSERT_EQ(NS_OK, crypto->EncryptBlock(blockNumber,
                                          reinterpret_cast<const uint8_t*>(msg),
                                          len, block.Elements()));
    // Ciphertext differs from plaintext.
    EXPECT_NE(0, memcmp(block.Elements(), msg, len));

    ASSERT_EQ(NS_OK, crypto->DecryptBlock(blockNumber, block.Elements(), len,
                                          roundtrip.Elements()));
    EXPECT_EQ(0, memcmp(roundtrip.Elements(), msg, len));
  }

  CacheCrypto::Shutdown();
}

TEST(CacheCrypto, TamperAndWrongBlockFail)
{
  RefPtr<CacheCrypto> crypto = InitCryptoForTest();
  ASSERT_TRUE(crypto);

  const char* msg = "authenticated payload";
  const uint32_t len = strlen(msg);

  nsTArray<uint8_t> block;
  block.SetLength(len + CacheCrypto::kBlockOverhead);
  nsTArray<uint8_t> out;
  out.SetLength(len);

  ASSERT_EQ(NS_OK,
            crypto->EncryptBlock(3, reinterpret_cast<const uint8_t*>(msg), len,
                                 block.Elements()));

  // Decrypting with a different block number fails: the block number is bound
  // as additional authenticated data.
  EXPECT_NE(NS_OK,
            crypto->DecryptBlock(4, block.Elements(), len, out.Elements()));

  // Tampered ciphertext fails the AEAD tag check.
  nsTArray<uint8_t> tampered = block.Clone();
  tampered[0] ^= 0x01;
  EXPECT_NE(NS_OK,
            crypto->DecryptBlock(3, tampered.Elements(), len, out.Elements()));

  // The untouched block at its own block number still decrypts.
  EXPECT_EQ(NS_OK,
            crypto->DecryptBlock(3, block.Elements(), len, out.Elements()));
  EXPECT_EQ(0, memcmp(out.Elements(), msg, len));

  CacheCrypto::Shutdown();
}

TEST(CacheCrypto, WrongKeyFails)
{
  // Encrypt a block with the session's key.
  RefPtr<CacheCrypto> crypto = InitCryptoForTest();
  ASSERT_TRUE(crypto);

  const char* msg = "secret cache contents";
  const uint32_t len = strlen(msg);
  nsTArray<uint8_t> block;
  block.SetLength(len + CacheCrypto::kBlockOverhead);
  ASSERT_EQ(NS_OK,
            crypto->EncryptBlock(0, reinterpret_cast<const uint8_t*>(msg), len,
                                 block.Elements()));

  // Model a later session that came up with a different key: InitForTesting()
  // generates a fresh one each time. This covers both "no key could be
  // recovered" and "the key does not match".
  CacheCrypto::Shutdown();
  CacheCrypto::InitForTesting();
  RefPtr<CacheCrypto> crypto2 = CacheCrypto::GetInstanceOrNull();
  ASSERT_TRUE(crypto2);

  // Decrypting the block written with the old key must fail (AEAD auth).
  nsTArray<uint8_t> out;
  out.SetLength(len);
  EXPECT_NE(NS_OK,
            crypto2->DecryptBlock(0, block.Elements(), len, out.Elements()));

  CacheCrypto::Shutdown();
}

TEST(CacheCrypto, FreshNoncePerEncryption)
{
  RefPtr<CacheCrypto> crypto = InitCryptoForTest();
  ASSERT_TRUE(crypto);

  const char* msg = "identical plaintext, identical block number";
  const uint32_t len = strlen(msg);

  nsTArray<uint8_t> b1, b2;
  b1.SetLength(len + CacheCrypto::kBlockOverhead);
  b2.SetLength(len + CacheCrypto::kBlockOverhead);

  ASSERT_EQ(NS_OK,
            crypto->EncryptBlock(0, reinterpret_cast<const uint8_t*>(msg), len,
                                 b1.Elements()));
  ASSERT_EQ(NS_OK,
            crypto->EncryptBlock(0, reinterpret_cast<const uint8_t*>(msg), len,
                                 b2.Elements()));
  // Same key/block/plaintext, but a fresh random nonce per encryption means the
  // ciphertext (and nonce) differ. This is what prevents keystream/nonce reuse
  // when a block is rewritten.
  EXPECT_NE(0, memcmp(b1.Elements(), b2.Elements(),
                      len + CacheCrypto::kBlockOverhead));

  CacheCrypto::Shutdown();
}

// The LockstoreService gtests are skipped on Android because they hang on the
// emulator (bug 1892964); skip this one for the same reason.
#ifndef MOZ_WIDGET_ANDROID

TEST(CacheCrypto, KeyIsRecoveredFromTheKeystore)
{
  // The point of the bug: the key survives a session because the keystore
  // holds it, not because it was written to a pref. Two loads of the real
  // keystore path must yield the same key, so a block encrypted by the first
  // decrypts under the second.
  nsCOMPtr<nsIX509CertDB> certDB(do_GetService(NS_X509CERTDB_CONTRACTID));
  ASSERT_TRUE(certDB);

  // Resolve on the main thread: that is what caches the service's profile
  // path, and LoadFromKeystore() must not run here.
  RefPtr<LockstoreService> lockstore = LockstoreService::GetSingleton();
  ASSERT_TRUE(lockstore);

  auto load = [&lockstore]() -> RefPtr<CacheCrypto> {
    RefPtr<CacheCrypto> crypto;
    RunOnBackground([&] { crypto = CacheCrypto::LoadFromKeystore(lockstore); });
    return crypto;
  };

  RefPtr<CacheCrypto> first = load();
  ASSERT_TRUE(first);

  const char* msg = "cache contents that must outlive the session";
  const uint32_t len = strlen(msg);
  nsTArray<uint8_t> block;
  block.SetLength(len + CacheCrypto::kBlockOverhead);
  ASSERT_EQ(NS_OK, first->EncryptBlock(0, reinterpret_cast<const uint8_t*>(msg),
                                       len, block.Elements()));

  // A second session: the DEK already exists, so this recovers it rather than
  // minting a new one.
  RefPtr<CacheCrypto> second = load();
  ASSERT_TRUE(second);
  ASSERT_NE(first.get(), second.get());

  nsTArray<uint8_t> out;
  out.SetLength(len);
  EXPECT_EQ(NS_OK,
            second->DecryptBlock(0, block.Elements(), len, out.Elements()));
  EXPECT_EQ(0, memcmp(out.Elements(), msg, len));
}

namespace {

constexpr auto kCacheDekName = "httpcache"_ns;
constexpr auto kTestPassword = "cache-crypto-test"_ns;
constexpr const char* kPayload = "cache contents behind a password KEK";

RefPtr<CacheCrypto> LoadOnBackground(LockstoreService* aLockstore) {
  RefPtr<CacheCrypto> crypto;
  RunOnBackground([&] { crypto = CacheCrypto::LoadFromKeystore(aLockstore); });
  return crypto;
}

nsTArray<uint8_t> EncryptPayload(CacheCrypto* aCrypto) {
  const uint32_t len = strlen(kPayload);
  nsTArray<uint8_t> block;
  block.SetLength(len + CacheCrypto::kBlockOverhead);
  EXPECT_EQ(NS_OK,
            aCrypto->EncryptBlock(0, reinterpret_cast<const uint8_t*>(kPayload),
                                  len, block.Elements()));
  return block;
}

bool DecryptsToPayload(CacheCrypto* aCrypto, nsTArray<uint8_t> aBlock) {
  const uint32_t len = strlen(kPayload);
  nsTArray<uint8_t> out;
  out.SetLength(len);
  return NS_SUCCEEDED(aCrypto->DecryptBlock(0, aBlock.Elements(), len,
                                            out.Elements())) &&
         memcmp(out.Elements(), kPayload, len) == 0;
}

}  // namespace

// The profile KEKs are process-wide, so no test may leave a password KEK.
class CacheCryptoPasswordKekTest : public ::testing::Test {
 protected:
  void SetUp() override {
    nsCOMPtr<nsIX509CertDB> certDB(do_GetService(NS_X509CERTDB_CONTRACTID));
    ASSERT_TRUE(certDB);
    mLockstore = LockstoreService::GetSingleton();
    ASSERT_TRUE(mLockstore);
    bool passwordKekExists = true;
    RunOnBackground([&] {
      Result exists = mLockstore->DoKekExists(kProfilePasswordKek);
      passwordKekExists = exists.isErr() || exists.unwrap();
    });
    ASSERT_FALSE(passwordKekExists)
    << "a password profile KEK was left behind by an earlier test";
  }

  void TearDown() override {
    if (!mLockstore) {
      return;
    }
    RunOnBackground([&] {
      Result exists = mLockstore->DoKekExists(kProfilePasswordKek);
      if (exists.isErr() || !exists.unwrap()) {
        return;
      }
      // The password KEK cannot be deleted while it wraps a DEK, and the other
      // CacheCrypto tests expect the cache DEK under the LocalKey.
      EXPECT_NS_SUCCEEDED(mLockstore->DoUnlockKek(kProfilePasswordKek,
                                                  kTestPassword, UINT64_MAX));
      EXPECT_NS_SUCCEEDED(MoveProfileDeksToLocalKey(mLockstore));

      // Whatever failed above, the KEK must not be left to the next test.
      exists = mLockstore->DoKekExists(kProfilePasswordKek);
      if (exists.isOk() && !exists.unwrap()) {
        return;
      }
      (void)mLockstore->DoDeleteDek(kCacheDekName);
      EXPECT_NS_SUCCEEDED(mLockstore->DoDeleteKek(kProfilePasswordKek));
    });
  }

  void CreatePasswordKek() {
    RunOnBackground([&] {
      Result created = mLockstore->DoCreateKek("password"_ns, kProfileKekId,
                                               kTestPassword, UINT64_MAX);
      ASSERT_TRUE(created.isOk());
      EXPECT_EQ(created.unwrap(), kProfilePasswordKek);
    });
  }

  // What adopting a primary password does.
  void MoveCacheDekToPasswordKek() {
    CreatePasswordKek();
    RunOnBackground([&] {
      EXPECT_NS_SUCCEEDED(mLockstore->DoSwitchKek(
          kCacheDekName, kProfileLocalKek, kProfilePasswordKek));
    });
  }

  nsTArray<nsCString> CacheDekKeks() {
    nsTArray<nsCString> keks;
    RunOnBackground([&] {
      Result listed = mLockstore->DoListKeks(kCacheDekName);
      ASSERT_TRUE(listed.isOk());
      keks = listed.unwrap();
    });
    return keks;
  }

  RefPtr<LockstoreService> mLockstore;
};

TEST_F(CacheCryptoPasswordKekTest, NewKeyIsWrappedUnderThePasswordKek) {
  RunOnBackground([&] { (void)mLockstore->DoDeleteDek(kCacheDekName); });
  CreatePasswordKek();

  ASSERT_TRUE(LoadOnBackground(mLockstore));

  nsTArray<nsCString> keks = CacheDekKeks();
  ASSERT_EQ(keks.Length(), 1u);
  EXPECT_EQ(keks[0], kProfilePasswordKek);
}

// After adoption the load must not replace the DEK.
TEST_F(CacheCryptoPasswordKekTest, KeyIsRecoveredFromThePasswordKek) {
  RefPtr<CacheCrypto> first = LoadOnBackground(mLockstore);
  ASSERT_TRUE(first);
  nsTArray<uint8_t> block = EncryptPayload(first);

  MoveCacheDekToPasswordKek();

  RefPtr<CacheCrypto> second = LoadOnBackground(mLockstore);
  ASSERT_TRUE(second);
  EXPECT_TRUE(DecryptsToPayload(second, block.Clone()));

  nsTArray<nsCString> keks = CacheDekKeks();
  ASSERT_EQ(keks.Length(), 1u);
  EXPECT_EQ(keks[0], kProfilePasswordKek);
}

// The DEK must survive until the KEK is unlocked. Entries opened in between do
// not: without a cipher they are reinitialized.
TEST_F(CacheCryptoPasswordKekTest, LockedPasswordKekLeavesTheKeyAlone) {
  RefPtr<CacheCrypto> first = LoadOnBackground(mLockstore);
  ASSERT_TRUE(first);
  nsTArray<uint8_t> block = EncryptPayload(first);

  MoveCacheDekToPasswordKek();
  RunOnBackground(
      [&] { EXPECT_NS_SUCCEEDED(mLockstore->DoLockKek(kProfilePasswordKek)); });

  EXPECT_FALSE(LoadOnBackground(mLockstore));

  nsTArray<nsCString> keks = CacheDekKeks();
  ASSERT_EQ(keks.Length(), 1u);
  EXPECT_EQ(keks[0], kProfilePasswordKek);

  RunOnBackground([&] {
    EXPECT_NS_SUCCEEDED(mLockstore->DoUnlockKek(kProfilePasswordKek,
                                                kTestPassword, UINT64_MAX));
  });

  RefPtr<CacheCrypto> second = LoadOnBackground(mLockstore);
  ASSERT_TRUE(second);
  EXPECT_TRUE(DecryptsToPayload(second, block.Clone()));
}

// Without a DEK, a locked password KEK must not fall back to the LocalKey.
TEST_F(CacheCryptoPasswordKekTest, LockedPasswordKekDoesNotCreateAKey) {
  RunOnBackground([&] { (void)mLockstore->DoDeleteDek(kCacheDekName); });
  CreatePasswordKek();
  RunOnBackground(
      [&] { EXPECT_NS_SUCCEEDED(mLockstore->DoLockKek(kProfilePasswordKek)); });

  EXPECT_FALSE(LoadOnBackground(mLockstore));

  RunOnBackground([&] {
    Result exists = mLockstore->DoDekExists(kCacheDekName);
    ASSERT_TRUE(exists.isOk());
    EXPECT_FALSE(exists.unwrap());
  });
}

#endif  // MOZ_WIDGET_ANDROID
