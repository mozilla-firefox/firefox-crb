/* Any copyright is dedicated to the Public Domain.
 * https://creativecommons.org/publicdomain/zero/1.0/ */

#include "gtest/gtest.h"
#include "updaterfileutils_osx.h"

#include <fcntl.h>
#include <removefile.h>
#include <set>
#include <string>
#include <sys/stat.h>
#include <unistd.h>

namespace {

const uid_t kClient = 501;
const uid_t kOwner = 502;
const uid_t kOtherAdmin = 503;
const uid_t kOtherUser = 504;
const gid_t kWheel = 0;
const gid_t kStaff = 20;
const gid_t kAdmin = 80;
const int kSomeFd = 3;

class FakeInstallTreeCheck : public InstallTreeCheck {
 public:
  explicit FakeInstallTreeCheck(bool aIsClientAdmin)
      : InstallTreeCheck(kClient, kOwner, aIsClientAdmin) {
    if (aIsClientAdmin) {
      mClientGroups.insert(kAdmin);
    }
  }

  std::set<gid_t> mClientGroups = {kStaff};
  std::set<uid_t> mAdmins = {kOwner, kOtherAdmin};
  bool mHasAcl = false;
  bool mAreLookupsFailing = false;

 protected:
  bool IsUserInGroup(uid_t aUid, gid_t aGid, bool aFailureCounts) override {
    if (mAreLookupsFailing) {
      return aFailureCounts;
    }
    if (aUid == kClient) {
      return mClientGroups.count(aGid) != 0;
    }
    return aGid == kAdmin && mAdmins.count(aUid) != 0;
  }

  bool HasAclAllowingChanges(int aFd) override { return mHasAcl; }
};

struct stat Entry(uid_t aUid, gid_t aGid, mode_t aMode) {
  struct stat st = {};
  st.st_uid = aUid;
  st.st_gid = aGid;
  st.st_mode = S_IFREG | aMode;
  return st;
}

}  // namespace

TEST(InstallTreeCheck, AcceptsReadOnlyEntriesOfRootAndOwner)
{
  FakeInstallTreeCheck check(true);
  EXPECT_FALSE(check.CanBeChanged(Entry(0, kWheel, 0755), kSomeFd));
  EXPECT_FALSE(check.CanBeChanged(Entry(kOwner, kStaff, 0755), kSomeFd));
}

TEST(InstallTreeCheck, RefusesEntriesOfTheClient)
{
  FakeInstallTreeCheck check(false);
  EXPECT_TRUE(check.CanBeChanged(Entry(kClient, kWheel, 0444), kSomeFd));
}

TEST(InstallTreeCheck, RefusesWorldWritableEntries)
{
  FakeInstallTreeCheck check(false);
  EXPECT_TRUE(check.CanBeChanged(Entry(0, kWheel, 0757), kSomeFd));
}

TEST(InstallTreeCheck, RefusesEntriesOfOtherUsers)
{
  FakeInstallTreeCheck check(false);
  EXPECT_TRUE(check.CanBeChanged(Entry(kOtherUser, kWheel, 0755), kSomeFd));
}

TEST(InstallTreeCheck, AcceptsOtherAdminsOnlyWhenTheClientIsNotAdmin)
{
  FakeInstallTreeCheck clientIsAdmin(true);
  EXPECT_TRUE(
      clientIsAdmin.CanBeChanged(Entry(kOtherAdmin, kWheel, 0755), kSomeFd));
  FakeInstallTreeCheck clientIsNotAdmin(false);
  EXPECT_FALSE(
      clientIsNotAdmin.CanBeChanged(Entry(kOtherAdmin, kWheel, 0755), kSomeFd));
}

TEST(InstallTreeCheck, RefusesOtherUsersWhenTheAdminLookupFails)
{
  FakeInstallTreeCheck check(false);
  check.mAreLookupsFailing = true;
  EXPECT_TRUE(check.CanBeChanged(Entry(kOtherAdmin, kWheel, 0755), kSomeFd));
}

TEST(InstallTreeCheck, AcceptsGroupWriteForWheelUnlessTheClientIsInIt)
{
  FakeInstallTreeCheck check(false);
  EXPECT_FALSE(check.CanBeChanged(Entry(0, kWheel, 0775), kSomeFd));
  FakeInstallTreeCheck clientInWheel(false);
  clientInWheel.mClientGroups.insert(kWheel);
  EXPECT_TRUE(clientInWheel.CanBeChanged(Entry(0, kWheel, 0775), kSomeFd));
}

TEST(InstallTreeCheck, AcceptsGroupWriteForAdminOnlyWhenTheClientIsNotAdmin)
{
  FakeInstallTreeCheck clientIsNotAdmin(false);
  EXPECT_FALSE(clientIsNotAdmin.CanBeChanged(Entry(0, kAdmin, 0775), kSomeFd));
  FakeInstallTreeCheck clientIsAdmin(true);
  EXPECT_TRUE(clientIsAdmin.CanBeChanged(Entry(0, kAdmin, 0775), kSomeFd));
}

TEST(InstallTreeCheck, RefusesGroupWriteForOtherGroups)
{
  FakeInstallTreeCheck check(false);
  check.mClientGroups.clear();
  EXPECT_TRUE(check.CanBeChanged(Entry(0, kStaff, 0775), kSomeFd));
}

TEST(InstallTreeCheck, RefusesGroupWriteWhenTheClientLookupFails)
{
  FakeInstallTreeCheck check(false);
  check.mAreLookupsFailing = true;
  EXPECT_TRUE(check.CanBeChanged(Entry(0, kWheel, 0775), kSomeFd));
}

TEST(InstallTreeCheck, RefusesEntriesWithAnAclAllowingChanges)
{
  FakeInstallTreeCheck check(true);
  check.mHasAcl = true;
  EXPECT_TRUE(check.CanBeChanged(Entry(0, kWheel, 0755), kSomeFd));
  EXPECT_FALSE(check.CanBeChanged(Entry(0, kWheel, 0755), -1));
}

class InstallTreeWalk : public ::testing::Test {
 protected:
  void SetUp() override {
    char path[] = "/tmp/InstallTreeCheck.XXXXXX";
    ASSERT_TRUE(mkdtemp(path));
    char resolved[PATH_MAX];
    ASSERT_TRUE(realpath(path, resolved));
    mRoot = resolved;
    ASSERT_EQ(mkdir((mRoot + "/Contents").c_str(), 0755), 0);
    int fd = open((mRoot + "/Contents/file").c_str(),
                  O_WRONLY | O_CREAT | O_EXCL, 0644);
    ASSERT_GE(fd, 0);
    close(fd);
    ASSERT_EQ(chmod(mRoot.c_str(), 0755), 0);
  }

  void TearDown() override {
    chmod((mRoot + "/Contents").c_str(), 0755);
    removefile(mRoot.c_str(), nullptr, REMOVEFILE_RECURSIVE);
  }

  // The install's owner is the user running the test, so a client with
  // another user ID only sees entries of the install's owner.
  bool IsProtected(uid_t aClientUid, bool aIsUncheckableRefused) {
    int fd = open(mRoot.c_str(), O_RDONLY | O_DIRECTORY);
    if (fd < 0) {
      return false;
    }
    bool isProtected =
        IsInstallTreeProtected(fd, aClientUid, aIsUncheckableRefused);
    close(fd);
    return isProtected;
  }

  std::string mRoot;
};

TEST_F(InstallTreeWalk, AcceptsATreeOfTheInstallOwner) {
  EXPECT_TRUE(IsProtected(getuid() + 1, true));
}

TEST_F(InstallTreeWalk, RefusesATreeOfTheClient) {
  EXPECT_FALSE(IsProtected(getuid(), true));
}

TEST_F(InstallTreeWalk, RefusesAWorldWritableEntry) {
  ASSERT_EQ(chmod((mRoot + "/Contents/file").c_str(), 0646), 0);
  EXPECT_FALSE(IsProtected(getuid() + 1, true));
}

TEST_F(InstallTreeWalk, IgnoresSymlinks) {
  ASSERT_EQ(symlink("/tmp", (mRoot + "/Contents/link").c_str()), 0);
  EXPECT_TRUE(IsProtected(getuid() + 1, true));
}

TEST_F(InstallTreeWalk, RefusesUnreadableDirectoriesOnlyWhenAsked) {
  ASSERT_EQ(chmod((mRoot + "/Contents").c_str(), 0), 0);
  EXPECT_FALSE(IsProtected(getuid() + 1, true));
  EXPECT_TRUE(IsProtected(getuid() + 1, false));
}

TEST_F(InstallTreeWalk, RefusesATreeDeeperThan128Levels) {
  // Contents is the first level below the install.
  std::string path = mRoot + "/Contents";
  for (int i = 1; i < 128; i++) {
    path += "/d";
    ASSERT_EQ(mkdir(path.c_str(), 0755), 0);
  }
  EXPECT_TRUE(IsProtected(getuid() + 1, true));
  path += "/d";
  ASSERT_EQ(mkdir(path.c_str(), 0755), 0);
  EXPECT_FALSE(IsProtected(getuid() + 1, true));
}
