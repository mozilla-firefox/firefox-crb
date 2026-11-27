/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/
 */

"use strict";

const { EXIT_CODE } = ChromeUtils.importESModule(
  "resource://gre/modules/BackgroundUpdate.sys.mjs"
).BackgroundUpdate;

const UNELEVATED_PREF =
  "app.update.background.allowUpdatesForUnelevatedInstallations";
const UPLOAD_PREF = "datareporting.healthreport.uploadEnabled";

setupProfileService();

let syncManager = Cc["@mozilla.org/updates/update-sync-manager;1"].getService(
  Ci.nsIUpdateSyncManager
);
let lockFile = do_get_profile();
lockFile.append("customExePath");
lockFile.append("customExe");
syncManager.resetLock(lockFile);

let gAppDataDir;
let gDefaultProfileDir;

async function writeDefaultProfilePrefs(userPrefs) {
  let lines = Object.entries(userPrefs).map(
    ([name, value]) => `user_pref(${JSON.stringify(name)}, ${JSON.stringify(value)});`
  );
  await IOUtils.writeUTF8(
    PathUtils.join(gDefaultProfileDir, "prefs.js"),
    lines.join("\n") + "\n"
  );
}

async function runTask() {
  let exitCode = await do_backgroundtask("backgroundupdate", {
    extraEnv: {
      MOZ_APP_DATA: gAppDataDir,
      MOZ_BACKGROUNDTASKS_DEFAULT_PROFILE_PATH: gDefaultProfileDir,
    },
  });
  Assert.equal(EXIT_CODE.SUCCESS, exitCode, "Task should succeed");
}

async function getTaskProfileDir() {
  let candidates = [
    PathUtils.join(gAppDataDir, "Background Tasks Profiles"),
    gAppDataDir,
  ];
  let taskProfileDirs = [];
  for (let root of candidates) {
    if (!(await IOUtils.exists(root))) {
      continue;
    }
    for (let child of await IOUtils.getChildren(root)) {
      if (child.endsWith("-backgroundupdate")) {
        taskProfileDirs.push(child);
      }
    }
  }
  Assert.equal(
    1,
    taskProfileDirs.length,
    `Exactly one backgroundupdate task profile: ${taskProfileDirs}`
  );
  info(`Task profile: ${taskProfileDirs[0]}`);
  return taskProfileDirs[0];
}

async function readTaskProfilePrefs() {
  let taskProfileDir = await getTaskProfileDir();
  let prefs = {};
  let prefsFile = PathUtils.join(taskProfileDir, "prefs.js");
  let data = await IOUtils.read(prefsFile);
  let addPref = (kind, name, value) => {
    prefs[name] = value;
  };
  Services.prefs.parsePrefsFromBuffer(
    data,
    {
      onStringPref: addPref,
      onIntPref: addPref,
      onBoolPref: addPref,
      onError(message) {
        Assert.ok(false, message);
      },
    },
    prefsFile
  );
  return prefs;
}

add_setup(async function () {
  let root = do_get_profile();
  gAppDataDir = PathUtils.join(root.path, "stale_prefs_appdata");
  gDefaultProfileDir = PathUtils.join(root.path, "stale_prefs_default");
  await IOUtils.makeDirectory(gAppDataDir);
  await IOUtils.makeDirectory(
    PathUtils.join(gDefaultProfileDir, "datareporting")
  );
  await IOUtils.writeJSON(
    PathUtils.join(gDefaultProfileDir, "datareporting", "state.json"),
    { clientID: "decafdec-afde-cafd-ecaf-decafdecafde" }
  );

  // Create the persistent task profile without running the task to completion,
  // then keep the task away from the network. These prefs are not mirrored from
  // the default profile, so they cannot be set there.
  let exitCode = await do_backgroundtask("backgroundupdate", {
    extraEnv: {
      MOZ_APP_DATA: gAppDataDir,
      MOZ_BACKGROUNDTASKS_NO_DEFAULT_PROFILE: "1",
    },
  });
  Assert.equal(EXIT_CODE.DEFAULT_PROFILE_DOES_NOT_EXIST, exitCode);
  await IOUtils.writeUTF8(
    PathUtils.join(await getTaskProfileDir(), "user.js"),
    [
      `user_pref("browser.region.network.url", "");`,
      `user_pref("browser.region.update.enabled", false);`,
      `user_pref("browser.search.region", "US");`,
    ].join("\n") + "\n"
  );
});

const BASE_PREFS = {
  "app.update.disabledForTesting": true,
  "services.settings.server": "data:,#remote-settings-dummy/v1",
};

async function runWithDefaultProfilePrefs(userPrefs) {
  await writeDefaultProfilePrefs({ ...BASE_PREFS, ...userPrefs });
  await runTask();
  // A user value equal to the default value is not written to prefs.js, so a
  // missing entry means the task sees the default value.
  let taskPrefs = await readTaskProfilePrefs();
  return {
    [UNELEVATED_PREF]: taskPrefs[UNELEVATED_PREF] ?? false,
    [UPLOAD_PREF]: taskPrefs[UPLOAD_PREF] ?? true,
  };
}

add_task(async function test_cleared_default_profile_prefs_go_stale() {
  // A Nimbus rollout has set the pref on the user branch of the default
  // profile, and the user has disabled telemetry upload.
  Assert.deepEqual(
    await runWithDefaultProfilePrefs({
      [UNELEVATED_PREF]: true,
      [UPLOAD_PREF]: false,
    }),
    { [UNELEVATED_PREF]: true, [UPLOAD_PREF]: false },
    "Prefs set in the default profile are copied into the task profile"
  );

  // Control: explicit value changes in the default profile are propagated.
  Assert.deepEqual(
    await runWithDefaultProfilePrefs({
      [UNELEVATED_PREF]: false,
      [UPLOAD_PREF]: true,
    }),
    { [UNELEVATED_PREF]: false, [UPLOAD_PREF]: true },
    "Prefs changed in the default profile are updated in the task profile"
  );

  await runWithDefaultProfilePrefs({
    [UNELEVATED_PREF]: true,
    [UPLOAD_PREF]: false,
  });

  // The rollout ended and Nimbus cleared the user value, and the user reset the
  // upload pref to its default: neither appears in prefs.js anymore.
  Assert.deepEqual(
    await runWithDefaultProfilePrefs({}),
    { [UNELEVATED_PREF]: false, [UPLOAD_PREF]: true },
    "Prefs cleared in the default profile revert to their default values in the task profile"
  );
});
