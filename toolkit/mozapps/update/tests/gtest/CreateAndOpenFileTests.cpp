/* Any copyright is dedicated to the Public Domain.
 * https://creativecommons.org/publicdomain/zero/1.0/ */

#include "gtest/gtest.h"
#include "updatecommon.h"

#include <filesystem>
#include <pwd.h>
#include <stdio.h>
#include <stdlib.h>
#include <string>
#include <sys/stat.h>
#include <unistd.h>

namespace fs = std::filesystem;

// The elevated updater runs as root, so this test only runs as root. See
// README.md for how to run it.
TEST(CreateAndOpenFile, GivesNewFileToDirectoryOwnerWhenRoot)
{
  if (geteuid() != 0) {
    GTEST_SKIP() << "needs to run as root";
  }

  uid_t uid;
  gid_t gid;
  const char* sudoUid = getenv("SUDO_UID");
  const char* sudoGid = getenv("SUDO_GID");
  if (sudoUid && sudoGid) {
    uid = static_cast<uid_t>(atoi(sudoUid));
    gid = static_cast<gid_t>(atoi(sudoGid));
  } else {
    struct passwd* nobody = getpwnam("nobody");
    ASSERT_NE(nobody, nullptr);
    uid = nobody->pw_uid;
    gid = nobody->pw_gid;
  }
  ASSERT_NE(uid, 0u);

  char dirTemplate[] = "/tmp/CreateAndOpenFileTest.XXXXXX";
  ASSERT_NE(mkdtemp(dirTemplate), nullptr);
  std::string dir = dirTemplate;
  ASSERT_EQ(chown(dir.c_str(), uid, gid), 0);

  std::string path = dir + "/update.status";
  FILE* file = CreateAndOpenFile(path.data(), /* binary = */ true);
  ASSERT_NE(file, nullptr);
  fputs("succeeded\n", file);
  fclose(file);

  struct stat info;
  ASSERT_EQ(lstat(path.c_str(), &info), 0);
  EXPECT_TRUE(S_ISREG(info.st_mode));
  EXPECT_EQ(info.st_uid, uid);
  EXPECT_EQ(info.st_gid, gid);

  std::error_code ec;
  fs::remove_all(dir, ec);
}
