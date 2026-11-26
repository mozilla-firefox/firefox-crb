/* import-globals-from ../unit/head_crashreporter.js */
load("../unit/head_crashreporter.js");

// The manifest sources the module list from the process mappings. Any init
// error, NoModulesInProcessMappings in particular, means we fell back to the
// debugger rendezvous.

add_task(async function run_test() {
  if (!("@mozilla.org/toolkit/crash-reporter;1" in Cc)) {
    dump(
      "INFO | test_content_module_list_procmaps.js | Can't test crashreporter in a non-libxul build.\n"
    );
    return;
  }

  await do_content_crash(
    function () {
      crashType = CrashTestUtils.CRASH_MOZ_CRASH;
    },
    async function (mdump, extra) {
      Assert.greater(mdump.fileSize, 0);
      Assert.ok(!("DumperError" in extra), extra.DumperError);
      Assert.ok(
        CrashTestUtils.dumpHasStream(
          mdump.path,
          CrashTestUtils.MD_MODULE_LIST_STREAM
        )
      );
      Assert.deepEqual(
        await CrashTestUtils.getErrorsForCategory(mdump.path, "InitErrors"),
        []
      );
    }
  );
});
