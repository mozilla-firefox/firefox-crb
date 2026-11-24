/* Any copyright is dedicated to the Public Domain.
https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

ChromeUtils.defineESModuleGetters(this, {
  ERRORS: "chrome://browser/content/backup/backup-constants.mjs",
});

let bs;
let testBackupDirPath;
let testBackupPath;
let recoveryFolderPath;

add_setup(async function () {
  setupProfile();

  let sandbox = sinon.createSandbox();
  sandbox
    .stub(FakeBackupResource1.prototype, "backup")
    .resolves({ fake: "test" });

  testBackupDirPath = await IOUtils.createUniqueDirectory(
    PathUtils.tempDir,
    "staleRecoveryFolderBackup"
  );
  bs = new BackupService({ FakeBackupResource1 });
  testBackupPath = (await bs.createBackup({ profilePath: testBackupDirPath }))
    .archivePath;
  recoveryFolderPath = PathUtils.join(
    testBackupDirPath,
    BackupService.PROFILE_FOLDER_NAME,
    "recovery"
  );

  registerCleanupFunction(async () => {
    sandbox.restore();
    await IOUtils.remove(testBackupDirPath, {
      recursive: true,
      ignoreAbsent: true,
    });
  });
});

async function seedStaleFile() {
  let staleDir = PathUtils.join(recoveryFolderPath, FakeBackupResource1.key);
  await IOUtils.makeDirectory(staleDir, { createAncestors: true });
  let staleFile = PathUtils.join(staleDir, "user.js");
  await IOUtils.writeUTF8(staleFile, "stale");
  return staleFile;
}

/**
 * Tests that files left in the recovery folder by a previous recovery attempt
 * are removed before a new backup archive is decompressed.
 */
add_task(async function test_stale_files_cleared_before_decompress() {
  let sandbox = sinon.createSandbox();
  let staleFile = await seedStaleFile();
  let recoveredProfilePath = await IOUtils.createUniqueDirectory(
    PathUtils.tempDir,
    "staleRecoveryFolderRecovered"
  );

  let staleSeenDuringRecover;
  let checkStaleFile = async () => {
    staleSeenDuringRecover = await IOUtils.exists(staleFile);
    return null;
  };
  sandbox.stub(bs, "recoverFromSnapshotFolder").callsFake(checkStaleFile);
  sandbox
    .stub(bs, "recoverFromSnapshotFolderIntoSelectableProfile")
    .callsFake(checkStaleFile);

  try {
    await bs.recoverFromBackupArchive(
      testBackupPath,
      null,
      false,
      testBackupDirPath,
      recoveredProfilePath,
      true
    );
    Assert.strictEqual(
      staleSeenDuringRecover,
      false,
      "Stale file from a previous attempt should not be visible during recovery"
    );
  } finally {
    sandbox.restore();
    await IOUtils.remove(recoveredProfilePath, {
      recursive: true,
      ignoreAbsent: true,
    });
  }
});

/**
 * Tests that the recovery folder is removed when a recovery fails.
 */
add_task(async function test_recovery_folder_removed_on_failure() {
  let sandbox = sinon.createSandbox();
  let recoveredProfilePath = await IOUtils.createUniqueDirectory(
    PathUtils.tempDir,
    "staleRecoveryFolderFailed"
  );

  sandbox.stub(bs, "decompressRecoveryFile").callsFake(async () => {
    await seedStaleFile();
    await IOUtils.writeJSON(
      PathUtils.join(recoveryFolderPath, BackupService.MANIFEST_FILE_NAME),
      { invalid: "manifest" }
    );
  });

  try {
    await Assert.rejects(
      bs.recoverFromBackupArchive(
        testBackupPath,
        null,
        false,
        testBackupDirPath,
        recoveredProfilePath
      ),
      err => err.cause == ERRORS.CORRUPTED_ARCHIVE
    );
    Assert.ok(
      !(await IOUtils.exists(recoveryFolderPath)),
      "Recovery folder should be removed after a failed restore"
    );
  } finally {
    sandbox.restore();
    await IOUtils.remove(recoveredProfilePath, {
      recursive: true,
      ignoreAbsent: true,
    });
  }
});

/**
 * Tests that recovery fails, without decompressing the archive, if the
 * recovery folder cannot be removed.
 */
add_task(
  { skip_if: () => mozinfo.os == "win" },
  async function test_fails_closed_if_recovery_folder_cannot_be_cleared() {
    let sandbox = sinon.createSandbox();
    let staleFile = await seedStaleFile();
    let staleDir = PathUtils.parent(staleFile);
    let recoveredProfilePath = await IOUtils.createUniqueDirectory(
      PathUtils.tempDir,
      "staleRecoveryFolderFailClosed"
    );

    await IOUtils.setPermissions(staleDir, 0o555);
    let decompressSpy = sandbox.spy(bs, "decompressRecoveryFile");

    try {
      await Assert.rejects(
        bs.recoverFromBackupArchive(
          testBackupPath,
          null,
          false,
          testBackupDirPath,
          recoveredProfilePath
        ),
        err => err.cause == ERRORS.FILE_SYSTEM_ERROR
      );
      Assert.ok(
        decompressSpy.notCalled,
        "Should not decompress over stale state"
      );
    } finally {
      sandbox.restore();
      await IOUtils.setPermissions(staleDir, 0o755);
      await IOUtils.remove(recoveryFolderPath, {
        recursive: true,
        ignoreAbsent: true,
      });
      await IOUtils.remove(recoveredProfilePath, {
        recursive: true,
        ignoreAbsent: true,
      });
    }
  }
);
