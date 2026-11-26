# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

import argparse
import json
import os
import sys
import types
from unittest import mock

import mozunit
import pytest

here = os.path.abspath(os.path.dirname(__file__))
raptor_dir = os.path.join(os.path.dirname(here), "raptor")
sys.path.insert(0, raptor_dir)

from condprof_support import CondprofSupport  # noqa: E402

SCENARIO_FILE = "/condprof/scenarii/storage_initialization.py"


def make_args(**overrides):
    args = dict(
        app="firefox",
        power_test=False,
        binary="/path/to/firefox",
        browsertime_geckodriver="/path/to/geckodriver",
        device_name=None,
        host="127.0.0.1",
        run_local=True,
        verbose=False,
        obj_path="/obj",
        browsertime_user_args=[],
        is_release_build=False,
    )
    args.update(overrides)
    return argparse.Namespace(**args)


def make_test(**overrides):
    test = {
        "name": "si-clean",
        "conditioned_profile": "qm_init",
        "customization": "qm_init",
        "playback_version": "8.1.1",
        "persistent_profile": True,
    }
    test.update(overrides)
    return test


def make_cmd(template, *extra):
    return [
        "/path/to/node",
        "/path/to/browsertime.js",
        "--firefox.profileTemplate",
        template,
        *extra,
        "--browsertime.commands",
        "[]",
    ]


@pytest.fixture(autouse=True)
def quiet_logger():
    with mock.patch("logger.logger.RaptorLogger.info"):
        yield


@pytest.fixture
def support():
    instance = CondprofSupport()
    yield instance
    instance.clean_up()


@pytest.fixture
def condprof(tmp_path):
    """Fakes the condprof modules the support class imports lazily and
    returns the mocked get_or_build_profile."""
    condprof_dir = tmp_path / "condprof-profile"
    condprof_dir.mkdir()
    (condprof_dir / "prefs.js").write_text('user_pref("from.condprof", 1);\n')
    (condprof_dir / "storage.sqlite").write_text("")

    get_or_build_profile = mock.Mock(return_value=str(condprof_dir))
    scenario_module = types.SimpleNamespace(
        __file__=SCENARIO_FILE, PROXY_MODE="intercept"
    )
    runner = types.ModuleType("condprof.runner")
    runner.get_or_build_profile = get_or_build_profile
    scenarii = types.ModuleType("condprof.scenarii")
    scenarii.get_scenario_module = lambda name: scenario_module
    package = types.ModuleType("condprof")
    package.runner = runner
    package.scenarii = scenarii
    modules = {
        "condprof": package,
        "condprof.runner": runner,
        "condprof.scenarii": scenarii,
    }
    with mock.patch.dict(sys.modules, modules):
        yield get_or_build_profile


@pytest.fixture
def playback():
    instance = mock.Mock(host="127.0.0.1", port=8080)
    with mock.patch("mozproxy.get_playback", return_value=instance) as factory:
        instance.factory = factory
        yield instance


@pytest.fixture
def template(tmp_path):
    template = tmp_path / "raptor-profile"
    template.mkdir()
    (template / "user.js").write_text('user_pref("from.raptor", 1);\n')
    (template / "prefs.js").write_text('user_pref("from.raptor.prefs", 1);\n')
    return str(template)


def test_manifest_selects_profile(support):
    support.setup_test(make_test(), make_args())

    assert support.scenario == "qm_init"
    assert support.customization == "qm_init"
    assert support.playback_version == "8.1.1"
    assert support.persistent_profile
    assert not support.headless
    assert support.reverse_ports == []


def test_missing_scenario_is_an_error(support):
    with pytest.raises(Exception, match="conditioned_profile"):
        support.setup_test(make_test(conditioned_profile=None), make_args())


def test_cli_name_replaces_customization(support):
    args = make_args(browsertime_user_args=["condprof.customization=other"])
    support.setup_test(make_test(), args)

    assert support.customization == "other"


def test_cli_json_merges_over_manifest_json(support):
    manifest = '{"dirty_shutdown": true, "max_urls": 100}'
    args = make_args(browsertime_user_args=['condprof.customization={"max_urls": 50}'])
    support.setup_test(make_test(customization=manifest), args)

    assert json.loads(support.customization) == {
        "dirty_shutdown": True,
        "max_urls": 50,
    }


def test_cli_json_over_name_keeps_the_base(support):
    args = make_args(browsertime_user_args=['condprof.customization={"max_urls": 50}'])
    support.setup_test(make_test(customization="qm_init"), args)

    assert json.loads(support.customization) == {
        "customization": "qm_init",
        "max_urls": 50,
    }


def test_cli_scenario_and_headless(support):
    args = make_args(
        browsertime_user_args=["headless=true", "condprof.scenario=qm_use"]
    )
    support.setup_test(make_test(), args)

    assert support.headless
    assert support.scenario == "qm_use"


def test_persistent_profile_command(support, condprof, playback, template):
    support.setup_test(make_test(), make_args())
    cmd = make_cmd(template, "--condprof.customization", '{"max_urls": 50}')

    support.modify_command(cmd, make_test())

    assert not any(token.startswith("--condprof.") for token in cmd)
    assert "--firefox.profileTemplate" not in cmd
    profile_args = [t for t in cmd if t.startswith("--firefox.args=-profile=")]
    assert len(profile_args) == 1
    profile_dir = profile_args[0].split("=", 2)[2]
    assert profile_dir == support.profile_dir
    assert os.path.exists(os.path.join(profile_dir, "storage.sqlite"))
    assert "from.raptor" in open(os.path.join(profile_dir, "user.js")).read()
    prefs = open(os.path.join(profile_dir, "prefs.js")).read()
    # The conditioned profile's persisted prefs survive, raptor's come last.
    assert prefs.index("from.condprof") < prefs.index("from.raptor.prefs")
    assert cmd[-2:] == ["--browsertime.commands", "[]"]

    condprof.assert_called_once()
    call = condprof.call_args
    assert call.args == ("qm_init", "qm_init")
    assert call.kwargs["firefox"] == "/path/to/firefox"
    assert call.kwargs["geckodriver"] == "/path/to/geckodriver"
    assert call.kwargs["visible"]
    assert call.kwargs["playback_version"] == "8.1.1"
    assert call.kwargs["proxy_dir"] == "/obj"
    assert call.kwargs["run_local"] is True

    config = playback.factory.call_args.args[0]
    assert config["proxy_mode"] == "intercept"
    assert config["intercept_script_path"] == SCENARIO_FILE
    assert config["playback_tool"] == "mitmproxy"
    assert config["playback_version"] == "8.1.1"
    assert config["binary"] == "/path/to/firefox"
    assert config["obj_path"] == "/obj"
    assert "port" not in config
    playback.start.assert_called_once()


def test_template_profile_command(support, condprof, playback, template):
    support.setup_test(make_test(persistent_profile=False), make_args())
    cmd = make_cmd(template)

    support.modify_command(cmd, make_test())

    index = cmd.index("--firefox.profileTemplate")
    assert cmd[index + 1] == support.profile_dir
    assert cmd[index + 1] != template
    assert not any(token.startswith("--firefox.args=") for token in cmd)


def test_headless_builds_invisibly(support, condprof, playback, template):
    support.setup_test(make_test(), make_args(browsertime_user_args=["headless=true"]))

    support.modify_command(make_cmd(template), make_test())

    assert condprof.call_args.kwargs["visible"] is False


def test_second_command_reuses_profile_and_proxy(support, condprof, playback, template):
    support.setup_test(make_test(), make_args())
    test = make_test()
    support.modify_command(make_cmd(template), test)
    profile_dir = support.profile_dir

    cmd = make_cmd(template)
    support.modify_command(cmd, test)

    assert support.profile_dir == profile_dir
    assert f"--firefox.args=-profile={profile_dir}" in cmd
    condprof.assert_called_once()
    playback.start.assert_called_once()


def test_clean_up_stops_proxy_and_removes_profile(
    support, condprof, playback, template
):
    support.setup_test(make_test(), make_args())
    support.modify_command(make_cmd(template), make_test())
    profile_dir = support.profile_dir

    support.clean_up()

    playback.stop.assert_called_once()
    assert not os.path.exists(os.path.dirname(profile_dir))
    assert not os.path.exists(condprof.return_value)
    assert support.profile_dir is None
    assert support.playback is None


def test_android_command(support, condprof, playback, template):
    args = make_args(app="geckoview", binary="org.mozilla.geckoview_example")
    support.setup_test(make_test(), args)
    port = support.proxy_port
    assert support.reverse_ports == [port]
    assert not support.persistent_profile

    cmd = make_cmd(template)
    support.modify_command(cmd, make_test())

    config = playback.factory.call_args.args[0]
    assert config["playback_tool"] == "mitmproxy-android"
    assert config["port"] == port
    assert config["local_profile_dir"] == support.profile_dir
    assert cmd[cmd.index("--firefox.profileTemplate") + 1] == support.profile_dir
    prefs = [cmd[i + 1] for i, t in enumerate(cmd) if t == "--firefox.preference"]
    assert "network.proxy.type:1" in prefs
    assert "network.proxy.http:127.0.0.1" in prefs
    assert "network.proxy.http_port:8080" in prefs
    assert "network.proxy.ssl_port:8080" in prefs
    assert "network.proxy.no_proxies_on:127.0.0.1" in prefs


def test_deepcopy_shares_the_instance(support):
    from copy import deepcopy

    assert deepcopy(support) is support


if __name__ == "__main__":
    mozunit.main()
