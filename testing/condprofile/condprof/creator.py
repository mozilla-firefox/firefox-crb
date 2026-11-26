# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""Creates or updates profiles.

The profile creation works as following:

For each scenario:

- The latest indexed profile is picked on TC, if none we create a fresh profile
- The scenario is done against it
- The profile is uploaded on TC, replacing the previous one as the freshest

For each platform we keep a changelog file that keep track of each update
with the Task ID. That offers us the ability to get a profile from a specific
date in the past.

Artifacts are staying in TaskCluster for 3 months, and then they are removed,
so the oldest profile we can get is 3 months old. Profiles are being updated
continuously, so even after 3 months they are still getting "older".

When Firefox changes its version, profiles from the previous version
should work as expected. Each profile tarball comes with a metadata file
that keep track of the Firefox version that was used and the profile age.
"""

import glob
import json
import os
import tempfile
import shutil

from arsenic import get_session
from arsenic.browsers import Firefox

from condprof.util import fresh_profile, logger, obfuscate_file, obfuscate, get_version
from condprof.helpers import close_extra_windows
from condprof.scenarii import scenarii
from condprof.client import get_profile, compute_customization_key, ProfileNotFoundError
from condprof.archiver import Archiver
from condprof.customization import get_customization
from condprof.metadata import Metadata


START, INIT_GECKODRIVER, START_SESSION, START_SCENARIO = range(4)


class ProfileCreator:
    def __init__(
        self,
        scenario,
        customization,
        archive,
        changelog,
        force_new,
        env,
        skip_logs=False,
        remote_test_root="/sdcard/test_root/",
        accept_insecure_certs=False,
    ):
        self.env = env
        self.scenario = scenario
        self.customization = customization
        self.archive = archive
        self.changelog = changelog
        self.force_new = force_new
        self.skip_logs = skip_logs
        self.remote_test_root = remote_test_root
        self.accept_insecure_certs = accept_insecure_certs
        self.customization_data = get_customization(customization, scenario=scenario)
        self.customization_key = compute_customization_key(self.customization)
        self.tmp_dir = None

        # Make a temporary directory for the logs if an
        # archive dir is not provided
        if not self.archive:
            if os.environ.get("MOZ_UPLOAD_DIR"):
                self.tmp_dir = os.path.join(
                    os.environ.get("MOZ_UPLOAD_DIR"), "condprof"
                )
                os.makedirs(self.tmp_dir, exist_ok=True)
            else:
                self.tmp_dir = tempfile.mkdtemp()

    def _log_filename(self, name):
        filename = f"{name}-{self.scenario}-{self.customization_key}.log"
        return os.path.join(self.archive or self.tmp_dir, filename)

    async def run(self, headless=True):
        logger.info(f"Building {self.scenario} x {self.customization_data['name']}")

        if self.scenario in self.customization_data.get("ignore_scenario", []):
            logger.info("Skipping (ignored scenario in that customization)")
            return

        filter_by_platform = self.customization_data.get("platforms")
        if filter_by_platform and self.env.target_platform not in filter_by_platform:
            logger.info("Skipping (ignored platform in that customization)")
            return

        with self.env.get_device(
            2828, verbose=True, remote_test_root=self.remote_test_root
        ) as device:
            try:
                with self.env.get_browser():
                    metadata = await self.build_profile(device, headless)
            except Exception:
                raise
            finally:
                if not self.skip_logs:
                    self.env.dump_logs()

        if not self.archive:
            return

        logger.info("Creating generic archive")
        names = ["profile-%(platform)s-%(name)s-%(customization_key)s.tgz"]
        if (
            metadata["name"] == "full"
            and metadata.get("customization_key") == "default"
        ):
            names = [
                "profile-%(platform)s-%(name)s-%(customization_key)s.tgz",
                "profile-v%(version)s-%(platform)s-%(name)s-%(customization_key)s.tgz",
            ]

        keep_cache = self.customization_data.get("keep_cache", False)
        for name in names:
            if not keep_cache:
                # The following removes files from the profile before archival. An
                # alternative is to exclude the file in the _filter of create_archive.
                shutil.rmtree(
                    os.path.join(self.env.profile, "cache"), ignore_errors=True
                )
                shutil.rmtree(
                    os.path.join(self.env.profile, "cache2"), ignore_errors=True
                )

            archiver = Archiver(self.scenario, self.env.profile, self.archive)
            # the archive name is of the form
            # profile[-vXYZ.x]-<platform>-<scenario>-<customization>.tgz
            name = name % metadata
            archive_name = os.path.join(self.archive, name)
            dir = os.path.dirname(archive_name)
            if not os.path.exists(dir):
                os.makedirs(dir)
            archiver.create_archive(archive_name)
            logger.info(f"Archive created at {archive_name}")
            statinfo = os.stat(archive_name)
            logger.info(f"Current size is {statinfo.st_size}")

        logger.info("Extracting logs")
        if "logs" in metadata:
            logs = metadata.pop("logs")
            for prefix, prefixed_logs in logs.items():
                for log in prefixed_logs:
                    content = obfuscate(log["content"])[1]
                    with open(os.path.join(dir, prefix + "-" + log["name"]), "wb") as f:
                        f.write(content.encode("utf-8"))

        if metadata.get("result", 0) != 0:
            logger.info("The scenario returned a bad exit code")
            raise Exception(metadata.get("result_message", "scenario error"))
        if not self.skip_logs:
            self.changelog.append("update", **metadata)

    def _delete_after_build(self, profile, patterns):
        for pattern in patterns:
            matches = glob.glob(os.path.join(profile, pattern))
            for path in matches:
                if os.path.isdir(path):
                    shutil.rmtree(path)
                    logger.info(f"Deleted directory {path}")
                elif os.path.isfile(path):
                    os.remove(path)
                    logger.info(f"Deleted file {path}")
                else:
                    logger.warning(f"File not found for deletion: {path}")

    def _apply_step_prefs(self, profile, prefs):
        user_js = os.path.join(profile, "user.js")
        with open(user_js, "a") as f:
            for key, value in prefs.items():
                f.write(f"user_pref({json.dumps(key)}, {json.dumps(value)});\n")
        logger.info(f"Applied per-step prefs: {list(prefs.keys())}")

    async def build_profile(self, device, headless):
        scenario = self.scenario
        profile = self.env.profile
        customization_data = self.customization_data

        steps = customization_data["scenario"]
        if isinstance(steps, dict):
            steps = [{scenario: steps.get(scenario, {})}]
        logger.info(f"Loaded steps for scenario {scenario}: {steps}")

        if not self.force_new:
            try:
                get_profile(
                    profile,
                    self.env.target_platform,
                    scenario,
                    self.customization,
                )
            except ProfileNotFoundError:
                # XXX we'll use a fresh profile for now
                fresh_profile(profile, customization_data)
        else:
            fresh_profile(profile, customization_data)

        logger.info(f"Updating profile located at {profile!r}")
        metadata = Metadata(profile)

        logger.info("Starting the Gecko app...")
        adb_logs = self._log_filename("adb")
        self.env.prepare(logfile=adb_logs)
        geckodriver_logs = self._log_filename("geckodriver")
        logger.info(f"Writing geckodriver logs in {geckodriver_logs}")
        delete_after_build = list(customization_data.get("delete_after_build", []))
        step = START
        try:
            # The intercept proxy presents a self-signed mitmproxy certificate.
            firefox_instance = Firefox(
                **self.env.get_browser_args(headless),
                acceptInsecureCerts=self.accept_insecure_certs,
            )
            step = INIT_GECKODRIVER
            with open(geckodriver_logs, "w") as glog:
                geckodriver = self.env.get_geckodriver(log_file=glog)
                for scenario_description in steps:
                    # Copy so repeated runs over the same customization don't
                    # consume the step's keys.
                    scenario_description = dict(scenario_description)
                    step_prefs = scenario_description.pop("prefs", None)
                    if step_prefs:
                        self._apply_step_prefs(profile, step_prefs)

                    if not scenario_description:
                        continue

                    scenario_keys = list(scenario_description.keys())
                    if len(scenario_keys) != 1:
                        raise Exception(
                            f"Scenario step malformed: {scenario_description}"
                        )
                    scenario_name = scenario_keys[0]
                    options = dict(scenario_description[scenario_name])
                    delete_after_build.extend(options.pop("delete_after_build", []))
                    # keep_cache is read per-customization at archival time; drop
                    # it here so it never reaches the scenario function.
                    options.pop("keep_cache", None)
                    # Adding general options
                    options["platform"] = self.env.target_platform
                    options["app_name"] = getattr(self.env, "firefox", None)
                    options["profile_dir"] = profile
                    scenario_func = scenarii[scenario_name]

                    step = START_SESSION
                    async with get_session(geckodriver, firefox_instance) as session:
                        step = START_SCENARIO
                        self.env.check_session(session)
                        logger.info(f"Running the {scenario_name} scenario")
                        metadata.update(await scenario_func(session, options))
                        logger.info(f"{scenario_name} scenario done.")
                        # A scenario that killed the browser (dirty shutdown)
                        # has detached the session; there is nothing to close.
                        if not getattr(session, "detached", False):
                            await close_extra_windows(session)
        except Exception:
            logger.error(f"{scenario} scenario broke!")
            if step == START:
                logger.info("Could not initialize the browser")
            elif step == INIT_GECKODRIVER:
                logger.info("Could not initialize Geckodriver")
            elif step == START_SESSION:
                logger.info(
                    f"Could not start the session, check {geckodriver_logs} first"
                )
            else:
                logger.info("Could not run the scenario, probably a faulty scenario")
            raise
        finally:
            self.env.stop_browser()
            for logfile in (adb_logs, geckodriver_logs):
                if os.path.exists(logfile):
                    obfuscate_file(logfile)
        self.env.collect_profile()

        if delete_after_build:
            self._delete_after_build(profile, delete_after_build)

        # writing metadata
        metadata.write(
            name=self.scenario,
            customization_key=self.customization_key,
            version=self.env.get_browser_version(),
            platform=self.env.target_platform,
        )

        logger.info(f"Profile at {profile}.\nDone.")
        return metadata
