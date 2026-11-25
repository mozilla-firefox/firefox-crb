/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "updaterfileutils_osx.h"

#include <Cocoa/Cocoa.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <libproc.h>
#include <membership.h>
#include <stdlib.h>
#include <string.h>
#include <sys/acl.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <unistd.h>

bool IsRecursivelyWritable(const char* aPath) {
  NSAutoreleasePool* pool = [[NSAutoreleasePool alloc] init];

  NSString* rootPath = [NSString stringWithUTF8String:aPath];
  NSFileManager* fileManager = [NSFileManager defaultManager];
  NSError* error = nil;
  NSArray* subPaths = [fileManager subpathsOfDirectoryAtPath:rootPath
                                                       error:&error];
  NSMutableArray* paths =
      [NSMutableArray arrayWithCapacity:[subPaths count] + 1];
  [paths addObject:@""];
  [paths addObjectsFromArray:subPaths];

  if (error) {
    [pool drain];
    return false;
  }

  for (NSString* currPath in paths) {
    NSString* child = [rootPath stringByAppendingPathComponent:currPath];

    NSDictionary* attributes = [fileManager attributesOfItemAtPath:child
                                                             error:&error];
    if (error) {
      [pool drain];
      return false;
    }

    // Don't check for writability of files pointed to by symlinks, as they may
    // not be descendants of the root path.
    if ([attributes fileType] != NSFileTypeSymbolicLink &&
        [fileManager isWritableFileAtPath:child] == NO) {
      [pool drain];
      return false;
    }
  }

  [pool drain];
  return true;
}

bool IsUpdaterHelperBusy() {
  int fd =
      open(UPDATER_HELPER_PID_FILE_PATH, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) {
    return false;
  }
  struct stat st;
  char buffer[16] = {};
  bool isValid = fstat(fd, &st) == 0 && S_ISREG(st.st_mode) && st.st_uid == 0 &&
                 read(fd, buffer, sizeof(buffer) - 1) > 0;
  close(fd);
  if (!isValid) {
    return false;
  }
  pid_t pid = (pid_t)strtol(buffer, nullptr, 10);
  // The file stays behind if the helper crashed, so check that the process is
  // still the helper.
  char path[PROC_PIDPATHINFO_MAXSIZE];
  return pid > 0 && proc_pidpath(pid, path, sizeof(path)) > 0 &&
         strcmp(path, "/Library/PrivilegedHelperTools/org.mozilla.updater") ==
             0;
}

bool IsOnVolumeHonoringOwnership(int aFd) {
  struct statfs volume;
  return fstatfs(aFd, &volume) == 0 && volume.f_owner == 0 &&
         !(volume.f_flags & MNT_IGNORE_OWNERSHIP);
}

static const int kInstallTreeMaxDepth = 128;
static const gid_t kInstallTreeAdminGroup = 80;

static bool IsUserInGroupByLookup(uid_t aUid, gid_t aGid, bool aFailureCounts) {
  uuid_t user;
  uuid_t group;
  int isMember = 0;
  if (mbr_uid_to_uuid(aUid, user) != 0 || mbr_gid_to_uuid(aGid, group) != 0 ||
      mbr_check_membership(user, group, &isMember) != 0) {
    return aFailureCounts;
  }
  return isMember != 0;
}

InstallTreeCheck::InstallTreeCheck(uid_t aClientUid, uid_t aInstallOwner,
                                   bool aIsClientAdmin)
    : mClientUid(aClientUid),
      mInstallOwner(aInstallOwner),
      mIsClientAdmin(aIsClientAdmin) {}

bool InstallTreeCheck::IsUserInGroup(uid_t aUid, gid_t aGid,
                                     bool aFailureCounts) {
  return IsUserInGroupByLookup(aUid, aGid, aFailureCounts);
}

bool InstallTreeCheck::HasAclAllowingChanges(int aFd) {
  acl_t acl = acl_get_fd_np(aFd, ACL_TYPE_EXTENDED);
  if (!acl) {
    return errno != ENOENT && errno != ENOTSUP;
  }
  static const acl_perm_t kChangePerms[] = {
      ACL_WRITE_DATA,     ACL_APPEND_DATA,      ACL_DELETE,
      ACL_DELETE_CHILD,   ACL_WRITE_ATTRIBUTES, ACL_WRITE_EXTATTRIBUTES,
      ACL_WRITE_SECURITY, ACL_CHANGE_OWNER};
  bool allowsChanges = false;
  acl_entry_t entry;
  for (int id = ACL_FIRST_ENTRY;
       !allowsChanges && acl_get_entry(acl, id, &entry) == 0;
       id = ACL_NEXT_ENTRY) {
    acl_tag_t tag;
    acl_permset_t perms;
    if (acl_get_tag_type(entry, &tag) != 0 || tag != ACL_EXTENDED_ALLOW ||
        acl_get_permset(entry, &perms) != 0) {
      continue;
    }
    for (acl_perm_t perm : kChangePerms) {
      if (acl_get_perm_np(perms, perm) == 1) {
        allowsChanges = true;
        break;
      }
    }
  }
  acl_free(acl);
  return allowsChanges;
}

bool InstallTreeCheck::IsClientInGroup(gid_t aGid) {
  auto cached = mIsClientInGroup.find(aGid);
  if (cached != mIsClientInGroup.end()) {
    return cached->second;
  }
  bool isMember = IsUserInGroup(mClientUid, aGid, true);
  mIsClientInGroup[aGid] = isMember;
  return isMember;
}

bool InstallTreeCheck::IsUserAdmin(uid_t aUid) {
  auto cached = mIsUserAdmin.find(aUid);
  if (cached != mIsUserAdmin.end()) {
    return cached->second;
  }
  bool isAdmin = IsUserInGroup(aUid, kInstallTreeAdminGroup, false);
  mIsUserAdmin[aUid] = isAdmin;
  return isAdmin;
}

bool InstallTreeCheck::CanBeChanged(const struct stat& aStat, int aFd) {
  // An owner can always change the permissions.
  if (aStat.st_uid == mClientUid || (aStat.st_mode & S_IWOTH)) {
    return true;
  }
  if (aStat.st_uid != 0 && aStat.st_uid != mInstallOwner &&
      (mIsClientAdmin || !IsUserAdmin(aStat.st_uid))) {
    return true;
  }
  if (aStat.st_mode & S_IWGRP) {
    bool isAcceptedGroup =
        aStat.st_gid == 0 ||
        (aStat.st_gid == kInstallTreeAdminGroup && !mIsClientAdmin);
    if (!isAcceptedGroup || IsClientInGroup(aStat.st_gid)) {
      return true;
    }
  }
  return aFd >= 0 && HasAclAllowingChanges(aFd);
}

static bool IsInstallSubtreeProtected(int aDirFd, int aDepth,
                                      bool aIsUncheckableRefused,
                                      InstallTreeCheck& aCheck) {
  if (aDepth > kInstallTreeMaxDepth) {
    return false;
  }
  struct stat dirStat;
  if (fstat(aDirFd, &dirStat) != 0) {
    return !aIsUncheckableRefused;
  }
  if (aCheck.CanBeChanged(dirStat, aDirFd)) {
    return false;
  }
  int iterFd =
      openat(aDirFd, ".", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (iterFd < 0) {
    return !aIsUncheckableRefused;
  }
  DIR* dir = fdopendir(iterFd);
  if (!dir) {
    close(iterFd);
    return !aIsUncheckableRefused;
  }
  bool isProtected = true;
  while (isProtected) {
    // readdir returns null both at the end and on an error.
    errno = 0;
    struct dirent* entry = readdir(dir);
    if (!entry) {
      isProtected = errno == 0 || !aIsUncheckableRefused;
      break;
    }
    const char* name = entry->d_name;
    if (strcmp(name, ".") == 0 || strcmp(name, "..") == 0) {
      continue;
    }
    struct stat st;
    if (fstatat(aDirFd, name, &st, AT_SYMLINK_NOFOLLOW) != 0) {
      isProtected = !aIsUncheckableRefused;
      continue;
    }
    if (S_ISLNK(st.st_mode)) {
      continue;
    }
    int fd =
        openat(aDirFd, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
    if (fd < 0 && S_ISDIR(st.st_mode) && aIsUncheckableRefused) {
      isProtected = false;
    } else if (fd >= 0 && fstat(fd, &st) != 0) {
      isProtected = !aIsUncheckableRefused;
    } else if (fd >= 0 && S_ISDIR(st.st_mode)) {
      isProtected = IsInstallSubtreeProtected(fd, aDepth + 1,
                                              aIsUncheckableRefused, aCheck);
    } else if (aCheck.CanBeChanged(st, fd)) {
      isProtected = false;
    }
    if (fd >= 0) {
      close(fd);
    }
  }
  closedir(dir);
  return isProtected;
}

bool IsInstallTreeProtected(int aDirFd, uid_t aClientUid,
                            bool aIsUncheckableRefused) {
  struct stat installStat;
  if (fstat(aDirFd, &installStat) != 0) {
    return !aIsUncheckableRefused;
  }
  InstallTreeCheck check(
      aClientUid, installStat.st_uid,
      IsUserInGroupByLookup(aClientUid, kInstallTreeAdminGroup, true));
  return IsInstallSubtreeProtected(aDirFd, 0, aIsUncheckableRefused, check);
}
