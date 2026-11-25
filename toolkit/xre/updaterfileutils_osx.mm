/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "updaterfileutils_osx.h"

#include <Cocoa/Cocoa.h>
#include <fcntl.h>
#include <libproc.h>
#include <stdlib.h>
#include <string.h>
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
