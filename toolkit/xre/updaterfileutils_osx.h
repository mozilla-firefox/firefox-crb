/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef updaterfileutils_osx_h_
#define updaterfileutils_osx_h_

#include <map>
#include <sys/types.h>

struct stat;

// Where the privileged updater helper records its process ID while it handles
// an update.
#define UPDATER_HELPER_PID_FILE_PATH "/private/var/run/org.mozilla.updater.pid"

extern "C" {
bool IsRecursivelyWritable(const char* aPath);

// Returns whether the privileged updater helper is handling an update.
bool IsUpdaterHelperBusy();

// Returns whether aFd is on a volume that root mounted with ownership enabled.
// The privileged updater helper refuses to update an install on any other
// volume, where ownership doesn't protect it.
bool IsOnVolumeHonoringOwnership(int aFd);
}

// Decides whether the user who asked for an elevated update, the client, can
// change an entry of the install, or whether anyone else that the privileged
// updater helper doesn't accept can. The helper accepts root, the install's
// owner and, when the client isn't in the admin group, members of that group,
// which it gives write access after an update. Group write access is only
// accepted for the wheel group, which only holds root, and for the admin group
// under the same condition.
class InstallTreeCheck {
 public:
  InstallTreeCheck(uid_t aClientUid, uid_t aInstallOwner, bool aIsClientAdmin);
  virtual ~InstallTreeCheck() = default;

  // Returns whether the client, or anyone the helper doesn't accept, can
  // change the file or directory described by aStat. aFd is used for the ACL
  // and may be -1 when it couldn't be opened.
  bool CanBeChanged(const struct stat& aStat, int aFd);

 protected:
  // Returns whether aUid is a member of group aGid. With aFailureCounts, a
  // lookup that fails counts as membership.
  virtual bool IsUserInGroup(uid_t aUid, gid_t aGid, bool aFailureCounts);
  // Returns whether the ACL of aFd allows anyone to change the file or
  // directory.
  virtual bool HasAclAllowingChanges(int aFd);

 private:
  bool IsClientInGroup(gid_t aGid);
  bool IsUserAdmin(uid_t aUid);

  uid_t mClientUid;
  uid_t mInstallOwner;
  bool mIsClientAdmin;
  std::map<gid_t, bool> mIsClientInGroup;
  std::map<uid_t, bool> mIsUserAdmin;
};

// Returns whether neither the directory aDirFd nor anything in it can be
// changed by aClientUid or by anyone the privileged updater helper doesn't
// accept. A tree deeper than 128 levels counts as changeable. With
// aIsUncheckableRefused, so does an entry that can't be checked.
bool IsInstallTreeProtected(int aDirFd, uid_t aClientUid,
                            bool aIsUncheckableRefused);

#endif
