# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""Script that launches profiles creation."""

import os
import shutil
import asyncio

import mozversion

from condprof.creator import ProfileCreator
from condprof.desktop import DesktopEnv
from condprof.android import AndroidEnv
from condprof.changelog import Changelog
from condprof.scenarii import get_scenario_module, scenarii
from condprof.util import (
    logger,
    get_current_platform,
    extract_from_dmg,
    mozproxy_download_dir,
)
from condprof.customization import get_customizations, find_customization
from condprof.client import read_changelog, ProfileNotFoundError


class Runner:
    def __init__(
        self,
        profile,
        firefox,
        geckodriver,
        archive,
        device_name,
        strict,
        force_new,
        visible,
        skip_logs=False,
        remote_test_root="/sdcard/test_root/",
        proxy_mode=None,
        playback_version=None,
        proxy_dir=None,
        run_local=True,
    ):
        self.force_new = force_new
        self.proxy_dir = proxy_dir
        self.run_local = run_local
        self.profile = profile
        self.geckodriver = geckodriver
        self.archive = archive
        self.device_name = device_name
        self.strict = strict
        self.visible = visible
        self.skip_logs = skip_logs
        self.remote_test_root = remote_test_root
        self._proxy_mode_override = proxy_mode
        self._playback_version_override = playback_version
        self.proxy_mode = None
        self.playback = None
        self.env = {}
        # unpacking a dmg
        # XXX do something similar if we get an apk (but later)
        # XXX we want to do
        #   adb install -r target.apk
        #   and get the installed app name
        if firefox is not None and firefox.endswith("dmg"):
            target = os.path.join(os.path.dirname(firefox), "firefox.app")
            extract_from_dmg(firefox, target)
            firefox = os.path.join(target, "Contents", "MacOS", "firefox")
        self.firefox = firefox
        self.android = self.firefox is not None and self.firefox.startswith(
            "org.mozilla"
        )

    def prepare(self, scenario, customization):
        self.scenario = scenario
        self.customization = customization

        # early checks to avoid extra work
        if self.customization != "all":
            path, _ = find_customization(self.customization, scenario=self.scenario)
            if path is None:
                raise IOError(f"Cannot find customization {self.customization!r}")

        if self.scenario != "all" and self.scenario not in scenarii:
            raise IOError(f"Cannot find scenario {self.scenario!r}")

        if not self.android and self.firefox is not None:
            logger.info("Verifying Desktop Firefox binary")
            # we want to verify we do have a firefox binary
            # XXX so lame
            if not os.path.exists(self.firefox):
                if "MOZ_FETCHES_DIR" in os.environ:
                    target = os.path.join(os.environ["MOZ_FETCHES_DIR"], self.firefox)
                    if os.path.exists(target):
                        self.firefox = target

            if not os.path.exists(self.firefox):
                raise IOError(f"Cannot find {self.firefox}")

            mozversion.get_version(self.firefox)

        logger.info(os.environ)
        if self.archive:
            self.archive = os.path.abspath(self.archive)
            logger.info(f"Archives directory is {self.archive}")
            if not os.path.exists(self.archive):
                os.makedirs(self.archive, exist_ok=True)

        if shutil.which(self.geckodriver) is None and not os.path.exists(
            self.geckodriver
        ):
            raise IOError(f"Cannot find {self.geckodriver}")

        # Changelog needs a directory path; when archive is None (e.g. raptor's
        # build_conditioned_profile which caches profiles itself), skip it.
        # All Changelog usage is guarded by skip_logs, so None is safe here.
        self.changelog = Changelog(self.archive) if self.archive else None
        if not self.skip_logs and self.archive:
            try:
                if self.android:
                    app = self.firefox.split("org.mozilla.")[-1]
                    plat = f"{self.device_name}-{app}"
                else:
                    plat = get_current_platform()
                self.changelog = read_changelog(plat)
                logger.info("Got the changelog from TaskCluster")
            except ProfileNotFoundError:
                logger.info("changelog not found on TaskCluster, creating a local one.")

        if self.scenario != "all":
            # Fail on a misconfigured scenario before any work is done.
            self._proxy_settings(self.scenario)

    def _proxy_settings(self, scenario):
        """(scenario module, proxy mode, playback version) when the scenario
        runs behind a proxy, None otherwise."""
        scenario_module = get_scenario_module(scenario)

        proxy_mode = self._proxy_mode_override or getattr(
            scenario_module, "PROXY_MODE", None
        )
        if not proxy_mode:
            return None

        playback_version = self._playback_version_override or getattr(
            scenario_module, "PLAYBACK_VERSION", None
        )
        if playback_version is None:
            raise ValueError(
                "playback_version must be set to use proxy mode %r" % proxy_mode
            )
        self._proxy_mode_config(scenario_module, proxy_mode)
        return scenario_module, proxy_mode, playback_version

    def _proxy_mode_config(self, scenario_module, proxy_mode):
        """The mozproxy config keys specific to one proxy mode, taken from
        the scenario module's constants."""
        if proxy_mode == "intercept":
            if not hasattr(scenario_module, "addons"):
                raise ValueError(
                    "Scenario %r does not define the `addons` mitmproxy addon "
                    "required by the intercept proxy mode" % self.scenario
                )
            return {"intercept_script_path": scenario_module.__file__}
        if proxy_mode == "playback":
            playback_files = getattr(scenario_module, "PLAYBACK_FILES", None)
            if not playback_files:
                raise ValueError(
                    "Scenario %r does not define PLAYBACK_FILES required by "
                    "the playback proxy mode" % self.scenario
                )
            return {"playback_files": list(playback_files)}
        if proxy_mode == "record":
            recording_file = getattr(scenario_module, "RECORDING_FILE", None)
            if not recording_file:
                raise ValueError(
                    "Scenario %r does not define RECORDING_FILE required by "
                    "the record proxy mode" % self.scenario
                )
            return {"recording_file": recording_file}
        raise ValueError("Unknown proxy mode %r" % proxy_mode)

    @staticmethod
    def _ensure_default_logger():
        """mozproxy logs through mozlog's default logger and raises when there
        is none, which is the case for a standalone condprof run."""
        import sys

        from mozlog import get_default_logger, set_default_logger
        from mozlog.formatters import MachFormatter
        from mozlog.handlers import StreamHandler
        from mozlog.structuredlog import StructuredLogger

        if get_default_logger() is not None:
            return
        structured = StructuredLogger("condprof")
        structured.add_handler(StreamHandler(sys.stdout, MachFormatter()))
        set_default_logger(structured)

    def _start_proxy(self, scenario):
        settings = self._proxy_settings(scenario)
        if settings is None:
            return
        scenario_module, proxy_mode, playback_version = settings

        import mozinfo
        from mozproxy import get_playback

        self._ensure_default_logger()

        config = {
            "run_local": self.run_local,
            "host": "127.0.0.1",
            "binary": self.firefox,
            "app": self.firefox.split("org.mozilla.")[-1]
            if self.android
            else "firefox",
            "proxy_mode": proxy_mode,
            "platform": mozinfo.os,
            "playback_tool": "mitmproxy-android" if self.android else "mitmproxy",
            "playback_version": playback_version,
        }
        if self.android:
            # mozproxy creates the certificate database in this directory,
            # which AndroidDevice.prepare() then pushes to the device.
            os.makedirs(self.env.profile, exist_ok=True)
            config["local_profile_dir"] = self.env.profile
        config.update(self._proxy_mode_config(scenario_module, proxy_mode))
        obj_path = mozproxy_download_dir(self.proxy_dir)
        if obj_path is not None:
            config["obj_path"] = obj_path
        self.proxy_mode = proxy_mode
        self.playback = get_playback(config)
        self.playback.start()
        self.env.proxy = (self.playback.host, self.playback.port)

    def _stop_proxy(self):
        if self.playback is not None:
            self.playback.stop()
            self.playback = None

    def _create_env(self):
        if self.android:
            klass = AndroidEnv
        else:
            klass = DesktopEnv

        return klass(
            self.profile, self.firefox, self.geckodriver, self.archive, self.device_name
        )

    def display_error(self, scenario, customization):
        logger.error(f"{scenario} x {customization} failed.", exc_info=True)
        # TODO: this might avoid the exceptions that slip through in automation
        # if self.strict:
        #     raise

    async def one_run(self, scenario, customization):
        """Runs one single conditioned profile.

        Create an instance of the environment and run the ProfileCreator.
        """
        self.env = self._create_env()
        self._start_proxy(scenario)
        try:
            return await ProfileCreator(
                scenario,
                customization,
                self.archive,
                self.changelog,
                self.force_new,
                self.env,
                skip_logs=self.skip_logs,
                remote_test_root=self.remote_test_root,
                accept_insecure_certs=(self.proxy_mode == "intercept"),
            ).run(not self.visible)
        finally:
            self._stop_proxy()

    async def run_all(self):
        """Runs the conditioned profile builders"""
        if self.scenario != "all":
            selected_scenario = [self.scenario]
        else:
            selected_scenario = scenarii.keys()

        # this is the loop that generates all combinations of profile
        # for the current platform when "all" is selected
        res = []
        failures = 0
        for scenario in selected_scenario:
            if self.customization != "all":
                try:
                    res.append(await self.one_run(scenario, self.customization))
                except Exception:
                    failures += 1
                    self.display_error(scenario, self.customization)
            else:
                for customization in get_customizations():
                    logger.info(f"Customization {customization}")
                    try:
                        res.append(await self.one_run(scenario, customization))
                    except Exception:
                        failures += 1
                        self.display_error(scenario, customization)

        return failures, [one_res for one_res in res if one_res]

    def save(self):
        if not self.skip_logs and self.changelog:
            self.changelog.save(self.archive)


def run(
    archive,
    firefox=None,
    scenario="all",
    profile=None,
    customization="all",
    visible=False,
    archives_dir="/tmp/archives",
    force_new=False,
    strict=True,
    geckodriver="geckodriver",
    device_name=None,
    skip_logs=False,
    proxy_dir=None,
):
    runner = Runner(
        profile,
        firefox,
        geckodriver,
        archive,
        device_name,
        strict,
        force_new,
        visible,
        skip_logs=skip_logs,
        proxy_dir=proxy_dir,
    )

    runner.prepare(scenario, customization)
    loop = asyncio.new_event_loop()

    try:
        failures, results = loop.run_until_complete(runner.run_all())
        logger.info(f"Saving changelog in {archive}")
        runner.save()
        if failures > 0:
            raise Exception("At least one scenario failed")
    except Exception as e:
        raise e
    finally:
        runner._stop_proxy()
        loop.close()


def get_or_build_profile(
    scenario,
    customization,
    firefox,
    geckodriver,
    target_dir,
    device_name=None,
    visible=False,
    remote_test_root="/sdcard/test_root/",
    proxy_mode=None,
    playback_version=None,
    use_cache=True,
    proxy_dir=None,
    run_local=True,
):
    """Returns a directory holding the conditioned profile for the scenario
    and customization.

    A profile found in the local cache is extracted into target_dir. Otherwise
    one is built now, saved to the cache, and returned where the runner left
    it. proxy_dir is passed to mozproxy as obj_path; harnesses pass the same
    directory they give their own proxy so the binaries are shared. run_local
    is mozproxy's flag too: in automation (False) the Android certutil comes
    from the hostutils tooltool manifest, locally from MOZ_HOST_BIN.
    """
    from condprof.client import get_profile, save_profile_to_cache

    if firefox is not None and firefox.startswith("org.mozilla"):
        app = firefox.split("org.mozilla.")[-1]
        platform = app if device_name is None else f"{device_name}-{app}"
    else:
        platform = get_current_platform()

    if use_cache:
        try:
            return get_profile(
                target_dir, platform, scenario, customization, run_local=True
            )
        except ProfileNotFoundError:
            logger.info("No cached profile found, building one")

    runner = Runner(
        profile=None,
        firefox=firefox,
        geckodriver=geckodriver,
        archive=None,
        device_name=device_name,
        strict=True,
        force_new=True,
        visible=visible,
        skip_logs=True,
        remote_test_root=remote_test_root,
        proxy_mode=proxy_mode,
        playback_version=playback_version,
        proxy_dir=proxy_dir,
        run_local=run_local,
    )
    runner.prepare(scenario, customization)
    loop = asyncio.new_event_loop()
    try:
        loop.run_until_complete(runner.one_run(scenario, customization))
    except Exception as e:
        # An incompatible geckodriver ahead of the build's on PATH (often the
        # system one) otherwise fails deep inside condprof with no hint of the
        # real cause.
        if "binary is not a Firefox executable" in str(e):
            raise Exception(
                "Geckodriver rejected the Firefox binary. Ensure the geckodriver "
                "built alongside your Firefox binary is first on PATH (it lives "
                "under the objdir's Rust target directory), or pass its path "
                "explicitly."
            ) from e
        raise
    finally:
        runner._stop_proxy()
        loop.close()

    if use_cache:
        save_profile_to_cache(runner.env.profile, platform, scenario, customization)
    return runner.env.profile
