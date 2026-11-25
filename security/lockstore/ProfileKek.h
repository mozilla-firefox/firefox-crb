/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef mozilla_security_lockstore_ProfileKek_h
#define mozilla_security_lockstore_ProfileKek_h

#include "mozilla/FunctionRef.h"
#include "mozilla/Maybe.h"
#include "mozilla/Result.h"
#include "nsError.h"
#include "nsLiteralString.h"
#include "nsStringFwd.h"

namespace mozilla::security::lockstore {

class LockstoreService;

// Constants for the profile KEK. lockstore derives a kek_ref from
// (type, identifier), so the same pair always names the same record; keep
// these in step with ProfileKekPassword.sys.mjs, which names the same two
// records from JS.
constexpr auto kProfileKekId = "profile"_ns;
constexpr auto kProfilePasswordKek = "lockstore::kek::password:profile"_ns;
constexpr auto kProfileLocalKek = "lockstore::kek::local:profile"_ns;

enum class PrimaryPasswordSync {
  // Reopen a password KEK this session has not unlocked yet.
  Unlock,
  // Bring a primary password lockstore knows nothing about under its wing.
  Adopt,
};

/**
 * Decide what startup has to do to keep the profile KEK in step with the
 * primary password, given the observed state. Nothing means the two already
 * agree. Only consulted while security.lockstore.unlock.enabled is set.
 *
 * aKekExists         whether a password profile KEK is on disk
 * aKekUnlocked       whether the KEK is unlocked, which at this point in
 *                    startup means someone else opened it and owns it
 * aTokenHasPassword  queried only when the outcome turns on it, since
 *                    instantiating the internal key token is not free
 */
Maybe<PrimaryPasswordSync> ChoosePrimaryPasswordSync(
    bool aKekExists, bool aKekUnlocked, FunctionRef<bool()> aTokenHasPassword);

/**
 * Whether giving up on aSync leaves the session usable. Adoption is the one
 * sync with nothing at stake: no password KEK exists yet, so every DEK is
 * still under the LocalKey. Giving up on an unlock leaves DEKs under a KEK this
 * session cannot unlock, which breaks every consumer of an encrypted database.
 */
bool SyncIsSkippable(PrimaryPasswordSync aSync);

/**
 * While security.lockstore.unlock.enabled is set, bring the profile KEK in step
 * with the primary password, prompting for it when needed. Whatever the pref,
 * move the profile DEKs back to a LocalKey if it is turned off later in the
 * session. Called from nsXREDirProvider::DoStartup just before
 * profile-do-change, ahead of the first encrypted database open.
 * Returns false when startup cannot continue. Main-thread only.
 */
bool SyncProfileKekAtStartup();

/**
 * Move the profile DEKs from the password KEK to the LocalKey, created on
 * demand, and delete the password KEK. Requires the password KEK to be
 * unlocked. Must not be called on the main thread.
 */
nsresult MoveProfileDeksToLocalKey(LockstoreService* aLockstore);

/**
 * The profile KEK to wrap new DEKs under: the password KEK if it exists, else
 * the LocalKey, created on demand.
 *
 * Must not be called on the main thread; callers there dispatch to a
 * background thread themselves.
 *
 * The returned KEK can be gone by the time the caller uses it: turning
 * security.lockstore.unlock.enabled off migrates the DEKs to the LocalKey and
 * deletes the password KEK. Wrapping a DEK under it then fails; nothing is
 * left behind under the password KEK.
 */
Result<nsCString, nsresult> GetActiveProfileKek(LockstoreService& aLockstore);

}  // namespace mozilla::security::lockstore

#endif  // mozilla_security_lockstore_ProfileKek_h
