# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

import json
import os
import shutil
import socket
import sys
import tempfile

import mozinfo
from base_python_support import BasePythonSupport
from cmdline import FIREFOX_ANDROID_APPS
from logger.logger import RaptorLogger

LOG = RaptorLogger(component="raptor-browsertime")

OVERRIDE_PREFIX = "condprof."
PROFILE_TEMPLATE_OPTION = "--firefox.profileTemplate"
DEFAULT_PLAYBACK_VERSION = "8.1.1"
PREF_FILES = ("prefs.js", "user.js")


def _parse_json_object(value):
    """The dict a JSON object encodes, or None for anything else."""
    if isinstance(value, dict):
        return value
    try:
        parsed = json.loads(value)
    except (TypeError, ValueError):
        return None
    return parsed if isinstance(parsed, dict) else None


def _find_free_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class CondprofSupport(BasePythonSupport):
    """Runs a browsertime test in a conditioned profile built by condprof,
    behind the scenario's intercept proxy.

    The manifest selects the profile with `conditioned_profile` (the condprof
    scenario name) and `customization` (a customization name or JSON
    override). `playback_version` picks the mitmproxy release and
    `persistent_profile` makes browsertime run Firefox in the profile itself
    rather than in a copy made for every browser start, so state the scenario
    built survives across iterations.

    The command line overrides the manifest through raptor's generic
    passthrough: `--browsertime-arg condprof.scenario=NAME`,
    `--browsertime-arg condprof.customization=NAME_OR_JSON` and
    `--browsertime-arg headless=true`. A JSON customization is merged over the
    manifest's, with the command-line keys winning; a bare name replaces it.
    """

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.args = None
        self.scenario = None
        self.customization = "default"
        self.headless = False
        self.playback_version = DEFAULT_PLAYBACK_VERSION
        self.persistent_profile = False
        self.android = False
        self.proxy_port = None
        self.reverse_ports = []
        self.playback = None
        self.profile_dir = None
        self._temp_dirs = []
        self._prepared = False

    def __deepcopy__(self, memo):
        # The extra profiler run deep-copies the test; share this instance so
        # its command reuses the profile and proxy prepared for the main run.
        return self

    def setup_test(self, test, args):
        super().setup_test(test, args)
        self.args = args
        self.android = args.app in FIREFOX_ANDROID_APPS
        self.scenario = test.get("conditioned_profile")
        self.customization = test.get("customization", "default")
        self.playback_version = test.get("playback_version", DEFAULT_PLAYBACK_VERSION)
        # On Android geckodriver pushes a copy of the template to the device,
        # so a host path in -profile would be meaningless.
        self.persistent_profile = (
            bool(test.get("persistent_profile")) and not self.android
        )

        for option, value in self._user_overrides(args):
            if option == "headless":
                self.headless = value.lower() == "true"
            elif option == OVERRIDE_PREFIX + "scenario":
                self.scenario = value
            elif option == OVERRIDE_PREFIX + "customization":
                self.customization = self._merge_customization(
                    self.customization, value
                )

        if self.scenario is None:
            raise Exception(
                f"Test {test['name']} uses {type(self).__name__} but sets no "
                "`conditioned_profile` scenario"
            )

        if self.android:
            # PerftestAndroid.set_reverse_ports() reads reverse_ports before
            # modify_command() runs, so the proxy port is fixed ahead of time.
            self.proxy_port = _find_free_port()
            self.reverse_ports = [self.proxy_port]

    @staticmethod
    def _user_overrides(args):
        for user_arg in getattr(args, "browsertime_user_args", None) or []:
            option, _, value = user_arg.partition("=")
            yield option, value

    @staticmethod
    def _merge_customization(base, override):
        override_dict = _parse_json_object(override)
        if override_dict is None:
            return override
        base_dict = _parse_json_object(base)
        if base_dict is None:
            base_dict = {"customization": base}
        merged = dict(base_dict)
        merged.update(override_dict)
        return json.dumps(merged)

    def modify_command(self, cmd, test):
        self._strip_overrides(cmd)
        if not self._prepared:
            self._prepare(cmd, test)
            self._prepared = True
        self._point_at_profile(cmd)
        if self.android:
            self._add_android_proxy_prefs(cmd)

    @staticmethod
    def _strip_overrides(cmd):
        """Removes the condprof.* passthrough options, which are for this class
        rather than for browsertime."""
        index = 0
        while index < len(cmd):
            if cmd[index].startswith("--" + OVERRIDE_PREFIX):
                del cmd[index : index + (1 if "=" in cmd[index] else 2)]
            else:
                index += 1

    def _prepare(self, cmd, test):
        template = self._template_profile(cmd)
        condprof_dir = self._get_conditioned_profile()
        self._temp_dirs.append(condprof_dir)
        self.profile_dir = os.path.join(self._make_temp_dir(), "profile")
        shutil.copytree(
            condprof_dir,
            self.profile_dir,
            ignore=shutil.ignore_patterns("lock"),
        )
        if template is not None:
            # Raptor's profile, whose user.js carries the base and test prefs,
            # wins over the conditioned profile's files. Its pref files are
            # appended rather than copied, since replacing prefs.js would drop
            # the prefs the conditioned profile persisted; the later user_pref
            # line wins when both set the same pref.
            shutil.copytree(
                template,
                self.profile_dir,
                dirs_exist_ok=True,
                ignore=shutil.ignore_patterns(*PREF_FILES),
            )
            for name in PREF_FILES:
                self._append_prefs(
                    os.path.join(template, name), os.path.join(self.profile_dir, name)
                )
        LOG.info(f"Conditioned test profile: {self.profile_dir}")
        self._start_proxy(test)

    @staticmethod
    def _append_prefs(source, target):
        if not os.path.exists(source):
            return
        with open(source) as src, open(target, "a") as dst:
            dst.write("\n")
            dst.write(src.read())

    def _make_temp_dir(self):
        path = tempfile.mkdtemp(prefix="raptor-condprof-")
        self._temp_dirs.append(path)
        return path

    @staticmethod
    def _template_profile(cmd):
        try:
            return cmd[cmd.index(PROFILE_TEMPLATE_OPTION) + 1]
        except (ValueError, IndexError):
            return None

    def _get_conditioned_profile(self):
        from condprof.runner import get_or_build_profile

        args = self.args
        geckodriver = args.browsertime_geckodriver or (
            "geckodriver.exe" if sys.platform.startswith("win") else "geckodriver"
        )
        release_build = getattr(args, "is_release_build", False)
        if release_build:
            # Building the profile needs the network even on a release build.
            os.environ["MOZ_DISABLE_NONLOCAL_CONNECTIONS"] = "0"
        try:
            return get_or_build_profile(
                self.scenario,
                self.customization,
                firefox=args.binary,
                geckodriver=geckodriver,
                target_dir=self._make_temp_dir(),
                device_name=args.device_name,
                visible=not self.headless,
                playback_version=self.playback_version,
                # Share mozproxy's downloads with raptor's own proxy.
                proxy_dir=getattr(args, "obj_path", None),
                run_local=getattr(args, "run_local", False),
            )
        finally:
            if release_build:
                os.environ["MOZ_DISABLE_NONLOCAL_CONNECTIONS"] = "1"

    def _start_proxy(self, test):
        from condprof.scenarii import get_scenario_module
        from mozproxy import get_playback

        scenario_module = get_scenario_module(self.scenario)
        proxy_mode = getattr(scenario_module, "PROXY_MODE", None)
        if proxy_mode is None:
            return
        if proxy_mode != "intercept":
            raise Exception(
                f"Scenario {self.scenario!r} declares proxy mode {proxy_mode!r}; "
                "only intercept is supported for tests"
            )

        args = self.args
        config = {
            "playback_tool": "mitmproxy-android" if self.android else "mitmproxy",
            "playback_version": self.playback_version,
            "proxy_mode": "intercept",
            "intercept_script_path": scenario_module.__file__,
            "host": args.host,
            "platform": mozinfo.os,
            "run_local": getattr(args, "run_local", False),
            "app": args.app,
            "binary": args.binary,
            "verbose": getattr(args, "verbose", False),
            "test_name": test.get("name", ""),
        }
        obj_path = getattr(args, "obj_path", None)
        if obj_path:
            config["obj_path"] = obj_path
        if self.android:
            config["port"] = self.proxy_port
            config["local_profile_dir"] = self.profile_dir

        self.playback = get_playback(config)
        if self.playback is None:
            raise Exception("Could not set up the intercept proxy")
        self.playback.start()

    def _point_at_profile(self, cmd):
        try:
            index = cmd.index(PROFILE_TEMPLATE_OPTION)
        except ValueError:
            cmd.extend([PROFILE_TEMPLATE_OPTION, self.profile_dir])
            return
        if self.persistent_profile:
            cmd[index : index + 2] = [f"--firefox.args=-profile={self.profile_dir}"]
        else:
            cmd[index + 1] = self.profile_dir

    def _add_android_proxy_prefs(self, cmd):
        # Geckoview cannot take the proxy from a policy, so set prefs instead,
        # as PerftestAndroid.turn_on_android_app_proxy() does for playback.
        if self.playback is None:
            return
        host, port = self.playback.host, self.playback.port
        for name, value in (
            ("network.proxy.type", 1),
            ("network.proxy.http", host),
            ("network.proxy.http_port", port),
            ("network.proxy.ssl", host),
            ("network.proxy.ssl_port", port),
            ("network.proxy.no_proxies_on", self.args.host),
        ):
            cmd.extend(["--firefox.preference", f"{name}:{value}"])

    def clean_up(self):
        if self.playback is not None:
            self.playback.stop()
            self.playback = None
        while self._temp_dirs:
            shutil.rmtree(self._temp_dirs.pop(), ignore_errors=True)
        self.profile_dir = None
        self._prepared = False
