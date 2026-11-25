/* Any copyright is dedicated to the Public Domain.
 * https://creativecommons.org/publicdomain/zero/1.0/ */

/* Verify how the updater's CreateAndOpenFile writes files. */

function createAndOpenFile(aPath, aContents) {
  return runTestHelperSync(["create-and-open-file", aPath, aContents]);
}

async function run_test() {
  if (!setupTestCommon()) {
    return;
  }

  let dir = PathUtils.join(PathUtils.tempDir, "createAndOpenFile");
  await IOUtils.remove(dir, { recursive: true, ignoreAbsent: true });
  await IOUtils.makeDirectory(dir);
  registerCleanupFunction(() => IOUtils.remove(dir, { recursive: true }));

  let path = PathUtils.join(dir, "update.status");
  await IOUtils.writeUTF8(path, "pending-elevate\n");
  Assert.equal(createAndOpenFile(path, "succeeded\n"), 0);
  Assert.equal(
    await IOUtils.readUTF8(path),
    "succeeded\n",
    "an existing file should be replaced"
  );

  if (AppConstants.platform == "linux") {
    // Other users of a shared installation have to be able to read these
    // files, so they get the usual permissions instead of only the owner's.
    let umask = Services.sysinfo.getProperty("umask");
    let newPath = PathUtils.join(dir, "update.log");
    Assert.equal(createAndOpenFile(newPath, "log\n"), 0);
    Assert.equal(
      (await IOUtils.stat(newPath)).permissions,
      0o666 & ~umask,
      "a new file should be created with the umask applied"
    );

    await IOUtils.setPermissions(path, 0o664);
    Assert.equal(createAndOpenFile(path, "failed: 7\n"), 0);
    Assert.equal(
      (await IOUtils.stat(path)).permissions,
      0o664,
      "an existing file should keep its permissions"
    );
  }

  if (AppConstants.platform == "macosx") {
    let target = PathUtils.join(dir, "target");
    await IOUtils.writeUTF8(target, "target\n");
    let linkPath = PathUtils.join(dir, "link.status");
    let ln = await Subprocess.call({
      command: "/bin/ln",
      arguments: ["-s", target, linkPath],
    });
    Assert.equal((await ln.wait()).exitCode, 0, "the symlink should exist");

    Assert.equal(createAndOpenFile(linkPath, "succeeded\n"), 0);
    Assert.ok(
      !new FileUtils.File(linkPath).isSymlink(),
      "the symlink should be replaced"
    );
    Assert.equal(await IOUtils.readUTF8(linkPath), "succeeded\n");
    Assert.equal(
      await IOUtils.readUTF8(target),
      "target\n",
      "the symlink's target should be left alone"
    );

    // A file can't be renamed over a directory.
    let dirPath = PathUtils.join(dir, "dir.status");
    await IOUtils.makeDirectory(dirPath);
    Assert.notEqual(
      createAndOpenFile(dirPath, "succeeded\n"),
      0,
      "replacing a directory should fail"
    );
    let leftovers = (await IOUtils.getChildren(dir)).filter(child =>
      PathUtils.filename(child).startsWith("temp.")
    );
    Assert.deepEqual(leftovers, [], "the temporary file should be removed");
  }
}
