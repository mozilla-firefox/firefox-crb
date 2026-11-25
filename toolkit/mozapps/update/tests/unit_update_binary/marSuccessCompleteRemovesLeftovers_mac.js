/* Any copyright is dedicated to the Public Domain.
 * https://creativecommons.org/publicdomain/zero/1.0/ */

/* Complete MAR file patch apply success test that undoes what earlier updates
 * left in the bundle */

const LEFTOVER_DRAFT = DIR_RESOURCES + "leftover0.png.moz-draft";
const LEFTOVER_BACKUP = DIR_RESOURCES + "leftover1.png.moz-backup";
const RESTORED_FILE = DIR_RESOURCES + "leftover1.png";
const LEFTOVER_UPDATING = "updating/update.manifest";

async function run_test() {
  if (!setupTestCommon()) {
    return;
  }
  gTestFiles = gTestFilesCompleteSuccess;
  gTestDirs = gTestDirsCompleteSuccess;
  preventDistributionFiles();
  await setupUpdaterTest(FILE_COMPLETE_MAR, true);
  for (let relPath of [LEFTOVER_DRAFT, LEFTOVER_BACKUP, LEFTOVER_UPDATING]) {
    writeFile(getApplyDirFile(relPath), "LeftBehindByAnEarlierUpdate\n");
  }

  runUpdate(STATE_SUCCEEDED, false, 0, true);
  await checkPostUpdateAppLog();
  checkAppBundleModTime();
  await testPostUpdateProcessing();
  checkPostUpdateRunningFile(true);

  for (let relPath of [LEFTOVER_DRAFT, LEFTOVER_BACKUP]) {
    let leftover = getApplyDirFile(relPath);
    Assert.ok(
      !leftover.exists(),
      MSG_SHOULD_NOT_EXIST + getMsgPath(leftover.path)
    );
  }
  Assert.ok(
    !getApplyDirFile("updating").exists(),
    "the updating directory" + MSG_SHOULD_NOT_EXIST
  );
  let restored = getApplyDirFile(RESTORED_FILE);
  Assert.equal(
    readFileBytes(restored),
    "LeftBehindByAnEarlierUpdate\n",
    "the backup should be renamed back over the file that it backs up"
  );
  checkUpdateLogContains("RemoveUpdateLeftovers: removing ");
  checkUpdateLogContains("RemoveUpdateLeftovers: restoring ");
  restored.remove(false);
  checkFilesAfterUpdateSuccess(getApplyDirFile);
  await waitForUpdateXMLFiles();
  await checkUpdateManager(STATE_NONE, false, STATE_SUCCEEDED, 0, 1);
  checkCallbackLog();
}
