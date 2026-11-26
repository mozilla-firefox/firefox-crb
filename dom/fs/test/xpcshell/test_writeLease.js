/**
 * Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/
 */

const { QuotaUtils } = ChromeUtils.importESModule(
  "resource://testing-common/dom/quota/test/modules/QuotaUtils.sys.mjs"
);
const {
  flushDirtyOriginInfos,
  isOriginDirty,
  waitForCondition,
  waitForOriginToSettle,
} = ChromeUtils.importESModule(
  "resource://testing-common/dom/quota/test/modules/StorageUtils.sys.mjs"
);

/**
 * OPFS handles that can write hold a quota write lease while they are open,
 * and requests that modify the file system database hold one for their
 * duration. Sync access handles are worker-only and are covered by the
 * writable stream case here (both share the lease handling on the parent).
 */

const kQuiescentThresholdPref =
  "dom.quotaManager.originWriteQuiescentThresholdMs";

add_task(async function testSteps() {
  const principal = Cc["@mozilla.org/systemprincipal;1"].createInstance(
    Ci.nsIPrincipal
  );

  Services.prefs.setIntPref(kQuiescentThresholdPref, 100);
  registerCleanupFunction(() =>
    Services.prefs.clearUserPref(kQuiescentThresholdPref)
  );

  async function settle() {
    await waitForOriginToSettle(principal);
  }

  info("Stage 1 - Creating an entry records the dirty flag");

  const root = await storage.getDirectory();
  const file = await root.getFileHandle("test.txt", { create: true });

  ok(await isOriginDirty(principal), "Origin dirty after creating a file");

  info("Stage 2 - Open handles that cannot write do not pin the origin");

  await settle();

  await root.getFileHandle("test.txt");

  await flushDirtyOriginInfos();
  ok(!(await isOriginDirty(principal)), "Lookup did not dirty the origin");

  info("Stage 3 - A writable file stream holds the lease until it is closed");

  const writable = await file.createWritable();

  ok(await isOriginDirty(principal), "Origin dirty with an open writable");

  const observationEnd = ChromeUtils.now() + 200;
  await waitForCondition(async () => {
    await flushDirtyOriginInfos();
    Assert.ok(
      await isOriginDirty(principal),
      "An open writable keeps the origin dirty"
    );
    return ChromeUtils.now() >= observationEnd;
  }, "dirty flag to remain set past the quiescence threshold");

  await writable.write("hello world");
  await writable.close();

  await settle();

  await Assert.rejects(
    writable.close(),
    /TypeError/,
    "Closing an already closed stream is rejected"
  );

  const readBack = await (await file.getFile()).text();
  Assert.equal(readBack, "hello world", "Data written");

  info("Stage 4 - Lease failures prevent mutations but allow reads");

  const directory = await root.getDirectoryHandle("directory", {
    create: true,
  });
  const lazyFile = await root.getFileHandle("lazy.txt", { create: true });
  const missingBackingFile = await root.getFileHandle("missing-backing.txt", {
    create: true,
  });
  const backingFile = await missingBackingFile.getFile();
  await IOUtils.remove(backingFile.mozFullPath);

  await settle();

  for (const [category, errorCode, expectedError] of [
    [
      Ci.nsIQuotaArtificialFailure.CATEGORY_FLAG_ORIGIN_INFO_AS_DIRTY,
      Cr.NS_ERROR_FILE_ACCESS_DENIED,
      /NotAllowedError/,
    ],
    [
      Ci.nsIQuotaArtificialFailure.CATEGORY_ACQUIRE_WRITE_LEASE_DISPATCH,
      Cr.NS_ERROR_FAILURE,
      /UnknownError/,
    ],
  ]) {
    await QuotaUtils.withArtificialFailures(
      category,
      /* aProbability */ 100,
      errorCode,
      async function () {
        Assert.equal(
          (await root.getFileHandle("test.txt", { create: true })).name,
          file.name,
          "An existing file does not need a lease"
        );
        Assert.equal(
          (await root.getDirectoryHandle("directory", { create: true })).name,
          directory.name,
          "An existing directory does not need a lease"
        );
        Assert.equal(
          await (await file.getFile()).text(),
          "hello world",
          "Reading an existing backing file does not need a lease"
        );

        await Assert.rejects(
          root.getFileHandle("directory", { create: true }),
          /TypeMismatchError/,
          "Lookup errors are preserved"
        );
        await Assert.rejects(
          root.getDirectoryHandle("test.txt", { create: true }),
          /TypeMismatchError/,
          "Directory lookup errors are preserved"
        );
        for (const [method, name] of [
          ["getFileHandle", "blocked.txt"],
          ["getDirectoryHandle", "blocked"],
        ]) {
          const [creation, lookup] = await Promise.allSettled([
            root[method](name, { create: true }),
            root[method](name),
          ]);
          Assert.equal(
            creation.status,
            "rejected",
            "Creation requires a lease"
          );
          Assert.ok(
            expectedError.test(creation.reason),
            "Lease error is preserved"
          );
          Assert.equal(
            lookup.status,
            "rejected",
            "Lookup rejects for the missing entry"
          );
          Assert.equal(
            lookup.reason?.name,
            "NotFoundError",
            "The entry is absent"
          );
        }
        for (const handle of [lazyFile, missingBackingFile]) {
          await Assert.rejects(
            handle.getFile(),
            expectedError,
            "Lazy initialization requires a lease"
          );
        }

        await Assert.rejects(
          file.createWritable(),
          expectedError,
          "Opening a writable requires a lease"
        );
        await Assert.rejects(
          root.removeEntry("test.txt"),
          expectedError,
          "Removing a file requires a lease"
        );
        await Assert.rejects(
          root.removeEntry("directory"),
          expectedError,
          "Removing a directory requires a lease"
        );
        await Assert.rejects(
          file.move(directory, "moved.txt"),
          expectedError,
          "Moving a file requires a lease"
        );
        await Assert.rejects(
          file.move("renamed.txt"),
          expectedError,
          "Renaming a file requires a lease"
        );

        const originalFile = await root.getFileHandle("test.txt");
        Assert.equal(
          await (await originalFile.getFile()).text(),
          "hello world",
          "Failed mutations preserve the original file and contents"
        );
        Assert.equal(
          (await root.getDirectoryHandle("directory")).name,
          directory.name,
          "Failed removal preserves the directory"
        );
        for (const [parent, name] of [
          [root, "blocked.txt"],
          [root, "renamed.txt"],
          [directory, "moved.txt"],
        ]) {
          await Assert.rejects(
            parent.getFileHandle(name),
            /NotFoundError/,
            "Failed mutations do not create destination entries"
          );
        }
        await Assert.rejects(
          root.getDirectoryHandle("blocked"),
          /NotFoundError/,
          "Failed creation does not create a directory"
        );
        ok(!(await isOriginDirty(principal)), "Origin remains settled");
      }
    );
  }

  const recoveredWritable = await file.createWritable({
    keepExistingData: true,
  });
  await recoveredWritable.close();
  Assert.equal(
    await (await file.getFile()).text(),
    "hello world",
    "A writable can open after lease rejection without losing data"
  );
  await settle();

  for (const handle of [lazyFile, missingBackingFile]) {
    Assert.equal(
      (await handle.getFile()).size,
      0,
      "Lazy initialization succeeds"
    );
    ok(
      await isOriginDirty(principal),
      "Lazy initialization dirtied the origin"
    );
    await settle();
    Assert.equal(
      (await handle.getFile()).size,
      0,
      "The empty file is readable"
    );
    ok(!(await isOriginDirty(principal)), "Reading leaves the origin settled");
  }

  info("Stage 5 - Removing an entry records the flag and settles again");

  await root.removeEntry("test.txt");

  ok(await isOriginDirty(principal), "Origin dirty after removeEntry");

  await settle();

  info(
    "Stage 6 - A removed entry remains missing when lease acquisition fails"
  );

  await QuotaUtils.withArtificialFailures(
    Ci.nsIQuotaArtificialFailure.CATEGORY_FLAG_ORIGIN_INFO_AS_DIRTY,
    /* aProbability */ 100,
    Cr.NS_ERROR_FAILURE,
    async function () {
      await Assert.rejects(
        file.getFile(),
        /NotFoundError/,
        "A removed entry is not recreated"
      );
    }
  );

  ok(!(await isOriginDirty(principal)), "Origin still settled");

  const other = await root.getFileHandle("other.txt", { create: true });
  const otherWritable = await other.createWritable();
  await otherWritable.write("x");
  await otherWritable.close();
  Assert.equal((await other.getFile()).size, 1, "Writes work again");

  await settle();

  info("Stage 7 - Creation precedes lookup without an intervening await");

  for (const method of ["getFileHandle", "getDirectoryHandle"]) {
    const [created, found] = await Promise.all([
      root[method]("ordered", { create: true }),
      root[method]("ordered"),
    ]);
    ok(await created.isSameEntry(found), "The lookup observes the new entry");
    await root.removeEntry("ordered");
    await settle();
  }

  await root.removeEntry("other.txt");
  await root.removeEntry("lazy.txt");
  await root.removeEntry("missing-backing.txt");
  await root.removeEntry("directory");
});
