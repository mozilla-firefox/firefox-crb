/* Any copyright is dedicated to the Public Domain.
 * https://creativecommons.org/publicdomain/zero/1.0/ */

const PROCESS_TIMEOUT_MS = 60_000;

add_task(async function test_post_update_environment() {
  let executable = do_get_file("../data/update-gtest.exe", true);
  Assert.ok(
    executable.exists(),
    "The updater test data must include update-gtest.exe"
  );
  let report = do_get_tempdir();
  report.append("post-update-environment.xml");
  let process = Cc["@mozilla.org/process/util;1"].createInstance(Ci.nsIProcess);
  process.init(executable);
  process.noShell = true;
  process.startHidden = true;
  let timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
  registerCleanupFunction(() => {
    timer.cancel();
    if (process.isRunning) {
      process.kill();
    }
  });

  let args = [
    "--gtest_filter=PostUpdateEnvironmentTest.*",
    "--gtest_fail_if_no_test_selected",
    `--gtest_output=xml:${report.path}`,
  ];
  let { promise, resolve } = Promise.withResolvers();
  timer.initWithCallback(
    () => {
      resolve("process-timeout");
      if (process.isRunning) {
        process.kill();
      }
    },
    PROCESS_TIMEOUT_MS,
    Ci.nsITimer.TYPE_ONE_SHOT
  );
  process.runwAsync(args, args.length, {
    observe(subject, topic) {
      resolve(topic);
    },
  });
  let topic = await promise;
  timer.cancel();
  let exitValue = process.exitValue;
  if (topic != "process-finished" || exitValue != 0) {
    if (await IOUtils.exists(report.path)) {
      info(await IOUtils.readUTF8(report.path));
    } else {
      info("The native test did not write an XML report.");
    }
  }
  Assert.equal(
    topic,
    "process-finished",
    "The test process should finish within 60 seconds"
  );
  Assert.equal(exitValue, 0, "Post-update environment tests should pass");
});
