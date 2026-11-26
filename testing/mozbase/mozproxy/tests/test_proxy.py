#!/usr/bin/env python
import json
import os
from contextlib import ExitStack
from unittest import mock

import mozinfo
import mozunit
import pytest
import requests
from mozproxy import get_playback
from support import firefox_binary, tempdir

here = os.path.dirname(__file__)


class Process:
    def __init__(self, *args, **kw):
        pass

    def run(self):
        print("I am running something")

    def poll(self):
        return None

    def communicate(self):
        return (["mock stdout"], ["mock stderr"])

    def wait(self):
        return 0

    def kill(self, sig=9):
        pass

    proc = object()
    pid = 1234
    stderr = stdout = []
    returncode = 0


_RETRY = 0


class ProcessWithRetry(Process):
    def __init__(self, *args, **kw):
        Process.__init__(self, *args, **kw)

    def wait(self):
        global _RETRY  # noqa: PLW0603
        _RETRY += 1
        if _RETRY >= 2:
            _RETRY = 0
            return 0
        return -1


def kill(pid, signal):
    if pid == 1234:
        return
    return os.kill(pid, signal)


def get_status_code(url, playback):
    response = requests.get(
        url=url, proxies={"http": f"http://{playback.host}:{playback.port}/"}
    )
    return response.status_code


def test_mitm_check_proxy(*args):
    # test setup
    pageset_name = os.path.join(here, "files", "mitm5-linux-firefox-amazon.manifest")

    config = {
        "playback_tool": "mitmproxy",
        "playback_files": [os.path.join(here, "files", pageset_name)],
        "playback_version": "8.1.1",
        "platform": mozinfo.os,
        "run_local": "MOZ_AUTOMATION" not in os.environ,
        "app": "firefox",
        "host": "127.0.0.1",
    }

    with tempdir() as obj_path:
        config["obj_path"] = obj_path
        config["binary"] = firefox_binary(obj_path)
        playback = get_playback(config)
        assert playback is not None

        try:
            playback.start()

            url = "https://m.media-amazon.com/images/G/01/csm/showads.v2.js"
            assert get_status_code(url, playback) == 200

            url = "http://mozproxy/checkProxy"
            assert get_status_code(url, playback) == 404
        finally:
            playback.stop()


@mock.patch("mozproxy.backends.mitm.Mitmproxy.check_proxy")
@mock.patch(
    "mozproxy.backends.mitm.mitm.ProxyPlaybackUseCase._build_replay_paths",
    return_value=["/tmp/fake.mp"],
)
@mock.patch("mozproxy.backends.mitm.mitm.ProcessHandler", new=Process)
@mock.patch("mozproxy.utils.Popen", new=Process)
@mock.patch("os.kill", new=kill)
def test_mitm(*args):
    pageset_name = os.path.join(here, "files", "mitm5-linux-firefox-amazon.manifest")

    config = {
        "playback_tool": "mitmproxy",
        "playback_files": [pageset_name],
        "playback_version": "8.1.1",
        "platform": mozinfo.os,
        "run_local": True,
        "app": "firefox",
        "host": "example.com",
    }

    with tempdir() as obj_path:
        config["obj_path"] = obj_path
        config["binary"] = firefox_binary(obj_path)
        playback = get_playback(config)
        assert playback is not None
        try:
            playback.start()
        finally:
            playback.stop()


@mock.patch("mozproxy.backends.mitm.Mitmproxy.check_proxy")
@mock.patch(
    "mozproxy.backends.mitm.mitm.ProxyPlaybackUseCase._build_replay_paths",
    return_value=["/tmp/fake.mp"],
)
@mock.patch("mozproxy.backends.mitm.mitm.ProcessHandler", new=Process)
@mock.patch("mozproxy.utils.Popen", new=Process)
@mock.patch("os.kill", new=kill)
def test_playback_setup_failed(*args):
    class SetupFailed(Exception):
        pass

    def setup_that_fails(**kw):
        raise SetupFailed("Failed")

    pageset_name = os.path.join(here, "files", "mitm5-linux-firefox-amazon.manifest")

    config = {
        "playback_tool": "mitmproxy",
        "playback_files": [pageset_name],
        "playback_version": "4.0.4",
        "platform": mozinfo.os,
        "run_local": True,
        "binary": "firefox",
        "app": "firefox",
        "host": "example.com",
    }

    with tempdir() as obj_path:
        config["obj_path"] = obj_path
        with mock.patch(
            "mozproxy.backends.mitm.desktop.MitmproxyDesktopSetup.setup",
            side_effect=setup_that_fails,
        ):
            with mock.patch(
                "mozproxy.backends.mitm.mitm.Mitmproxy.stop_mitmproxy_playback"
            ) as p:
                try:
                    pb = get_playback(config)
                    pb.start()
                except SetupFailed:
                    assert p.call_count == 1
                except Exception:
                    raise


@mock.patch("mozproxy.backends.mitm.Mitmproxy.check_proxy")
@mock.patch("mozproxy.backends.mitm.Mitmproxy.wait_for_ca_cert")
@mock.patch(
    "mozproxy.backends.mitm.mitm.ProxyPlaybackUseCase._build_replay_paths",
    return_value=["/tmp/fake.mp"],
)
@mock.patch("mozproxy.backends.mitm.mitm.ProcessHandler", new=Process)
@mock.patch("mozproxy.utils.Popen", new=Process)
@mock.patch("os.kill", new=kill)
def test_android_setup_failed_stops_mitmproxy(*args):
    """The Android setup class has no teardown of its own, so the proxy
    process must be stopped by Mitmproxy.start() when setup raises."""

    class SetupFailed(Exception):
        pass

    pageset_name = os.path.join(here, "files", "mitm5-linux-firefox-amazon.manifest")

    config = {
        "playback_tool": "mitmproxy-android",
        "playback_files": [pageset_name],
        "playback_version": "8.1.1",
        "platform": mozinfo.os,
        "run_local": True,
        "binary": "org.mozilla.fenix",
        "app": "fenix",
        "host": "example.com",
    }

    with tempdir() as obj_path:
        config["obj_path"] = obj_path
        with mock.patch(
            "mozproxy.backends.mitm.android.MitmproxyAndroidSetup.setup",
            side_effect=SetupFailed("Failed"),
        ):
            with mock.patch(
                "mozproxy.backends.mitm.mitm.Mitmproxy.stop_mitmproxy_playback"
            ) as stop_mitmproxy_playback:
                pb = get_playback(config)
                with pytest.raises(SetupFailed):
                    pb.start()
                assert stop_mitmproxy_playback.call_count == 1


@mock.patch("mozproxy.backends.mitm.Mitmproxy.check_proxy")
@mock.patch(
    "mozproxy.backends.mitm.mitm.ProxyPlaybackUseCase._build_replay_paths",
    return_value=["/tmp/fake.mp"],
)
@mock.patch("mozproxy.backends.mitm.mitm.ProcessHandler", new=ProcessWithRetry)
@mock.patch("mozproxy.utils.Popen", new=ProcessWithRetry)
@mock.patch("os.kill", new=kill)
def test_mitm_with_retry(*args):
    pageset_name = os.path.join(here, "files", "mitm5-linux-firefox-amazon.manifest")

    config = {
        "playback_tool": "mitmproxy",
        "playback_files": [pageset_name],
        "playback_version": "8.1.1",
        "platform": mozinfo.os,
        "run_local": True,
        "app": "firefox",
        "host": "example.com",
    }

    with tempdir() as obj_path:
        config["obj_path"] = obj_path
        config["binary"] = firefox_binary(obj_path)
        playback = get_playback(config)
        assert playback is not None
        try:
            playback.start()
        finally:
            playback.stop()


@pytest.mark.parametrize("test_name", ["", "nav-bench", "nav-bench-mobile"])
def test_mitm_direct_mode(test_name):
    config = {
        "playback_tool": "mitmproxy",
        "playback_files": ["pageset.manifest"],
        "playback_mode": "direct",
        "playback_version": "12.2.1",
        "platform": mozinfo.os,
        "run_local": True,
        "binary": "/tmp/chrome",
        "app": "chrome",
        "host": "127.0.0.1",
    }

    config["test_name"] = test_name

    process = mock.Mock(pid=1234)
    with tempdir() as obj_path:
        config["obj_path"] = obj_path
        playback = get_playback(config)
        playback.proxy_use_case.playback_files = [mock.Mock()]
        with ExitStack() as stack:
            stack.enter_context(
                mock.patch(
                    "mozproxy.backends.mitm.mitm.get_available_port",
                    side_effect=[18080, 18080, 18443],
                )
            )
            stack.enter_context(
                mock.patch(
                    "mozproxy.backends.mitm.mitm.ProxyPlaybackUseCase._build_replay_paths",
                    return_value=["/tmp/fake.mp"],
                )
            )
            check_proxy = stack.enter_context(
                mock.patch(
                    "mozproxy.backends.mitm.mitm.Mitmproxy.check_proxy",
                    side_effect=[True, False, True, True],
                )
            )
            stack.enter_context(mock.patch("mozproxy.backends.mitm.mitm.time.sleep"))
            stack.enter_context(
                mock.patch("mozproxy.backends.mitm.mitm.resource", None)
            )
            process_handler = stack.enter_context(
                mock.patch(
                    "mozproxy.backends.mitm.mitm.ProcessHandler",
                    return_value=process,
                )
            )
            playback.start_mitmproxy("/tmp/mitmdump", "/tmp/chrome")

    command = process_handler.call_args.args[0]
    assert "--listen-port" not in command
    assert "reverse:http://example.invalid@18080" in command
    assert "reverse:https://example.invalid@18443" in command
    assert "keep_host_header=true" in command
    assert "alt_server_replay_ignore_port=true" in command
    assert playback.playback_mode == "direct"
    assert playback.port is None
    assert (playback.http_port, playback.https_port) == (18080, 18443)
    assert check_proxy.call_args_list == [
        mock.call(host="127.0.0.1", port=port) for port in [18080, 18443, 18080, 18443]
    ]
    script = "nav-serverplayback.py" if test_name else "alt-serverplayback.py"
    assert command[command.index("--scripts") + 1].endswith(script)
    assert any(
        arg.startswith("server_replay_ignore_params=") for arg in command
    ) == bool(test_name)


def test_mitm_direct_mode_rejects_unsupported_version():
    config = {
        "playback_tool": "mitmproxy",
        "playback_files": ["pageset.manifest"],
        "playback_mode": "direct",
        "playback_version": "6.0.2",
        "platform": mozinfo.os,
        "run_local": True,
        "binary": "/tmp/chrome",
        "app": "chrome",
        "host": "127.0.0.1",
    }

    with tempdir() as obj_path:
        config["obj_path"] = obj_path
        with pytest.raises(
            ValueError,
            match=(
                "Direct playback does not support mitmproxy 6.0.2; "
                "supported versions: 11.0.0, 12.2.1"
            ),
        ):
            get_playback(config)


def test_mitm_direct_mode_rejects_intercept():
    config = {
        "playback_tool": "mitmproxy",
        "playback_mode": "direct",
        "proxy_mode": "intercept",
        "intercept_script_path": os.path.join(here, "intercept_addon.py"),
        "playback_version": "11.0.0",
        "platform": mozinfo.os,
        "run_local": True,
        "binary": "/tmp/chrome",
        "app": "chrome",
        "host": "127.0.0.1",
    }

    with tempdir() as obj_path:
        config["obj_path"] = obj_path
        with pytest.raises(ValueError, match="does not support intercept"):
            get_playback(config)


def test_mitm_direct_mode_firefox_policy():
    config = {
        "playback_tool": "mitmproxy",
        "playback_files": ["pageset.manifest"],
        "playback_mode": "direct",
        "playback_version": "12.2.1",
        "platform": mozinfo.os,
        "run_local": True,
        "binary": "firefox",
        "app": "firefox",
        "host": "127.0.0.1",
    }

    with tempdir() as obj_path:
        config["obj_path"] = obj_path
        playback = get_playback(config)

    playback.environment_setup.cert_path = "/tmp/mitmproxy-ca-cert.cer"
    policies = json.loads(
        playback.environment_setup._policies_content(
            playback.proxy_use_case.browser_policies(playback.host)
        )
    )["policies"]
    assert policies == {
        "Certificates": {"Install": ["/tmp/mitmproxy-ca-cert.cer"]},
        "Proxy": {"Mode": "none", "Locked": True},
    }


@pytest.mark.parametrize(
    "playback_mode,expected_calls",
    [
        ("direct", [mock.call(7, (10240, -1)), mock.call(7, (256, -1))]),
        ("proxy", []),
    ],
)
@pytest.mark.parametrize("spawn_fails", [False, True])
def test_mitm_nofile_limit_for_mitmdump(playback_mode, expected_calls, spawn_fails):
    config = {
        "playback_tool": "mitmproxy",
        "playback_files": ["pageset.manifest"],
        "playback_mode": playback_mode,
        "playback_version": "12.2.1",
        "platform": mozinfo.os,
        "run_local": True,
        "binary": "/tmp/chrome",
        "app": "chrome",
        "host": "127.0.0.1",
    }

    fake_resource = mock.Mock()
    fake_resource.RLIMIT_NOFILE = 7
    fake_resource.RLIM_INFINITY = -1
    fake_resource.getrlimit.return_value = (256, -1)
    process = mock.Mock(pid=1234)
    with tempdir() as obj_path:
        config["obj_path"] = obj_path
        playback = get_playback(config)
        playback.proxy_use_case.playback_files = [mock.Mock()]
        with ExitStack() as stack:
            stack.enter_context(
                mock.patch("mozproxy.backends.mitm.mitm.resource", fake_resource)
            )
            stack.enter_context(
                mock.patch(
                    "mozproxy.backends.mitm.mitm.get_available_port",
                    side_effect=[18080, 18443],
                )
            )
            stack.enter_context(
                mock.patch(
                    "mozproxy.backends.mitm.mitm.ProxyPlaybackUseCase._build_replay_paths",
                    return_value=["/tmp/fake.mp"],
                )
            )
            stack.enter_context(
                mock.patch(
                    "mozproxy.backends.mitm.mitm.Mitmproxy.check_proxy",
                    return_value=True,
                )
            )
            stack.enter_context(
                mock.patch(
                    "mozproxy.backends.mitm.mitm.ProcessHandler",
                    return_value=process,
                )
            )
            if spawn_fails:
                process.run.side_effect = OSError("spawn failed")
                with pytest.raises(OSError, match="spawn failed"):
                    playback.start_mitmproxy("/tmp/mitmdump", "/tmp/chrome")
            else:
                playback.start_mitmproxy("/tmp/mitmdump", "/tmp/chrome")

    assert fake_resource.setrlimit.call_args_list == expected_calls


@pytest.mark.parametrize("proxy_mode", ["record", "playback", "intercept"])
def test_proxy_strategy_command_and_policies(proxy_mode):
    config = {
        "playback_tool": "mitmproxy",
        "proxy_mode": proxy_mode,
        "playback_version": "12.2.1",
        "platform": mozinfo.os,
        "run_local": True,
        "binary": "firefox",
        "app": "firefox",
        "host": "127.0.0.1",
        "intercept_script_path": os.path.join(here, "intercept_addon.py"),
    }
    with tempdir() as obj_path:
        config["obj_path"] = obj_path
        if proxy_mode == "record":
            config["recording_file"] = os.path.join(obj_path, "recording.zip")
        elif proxy_mode == "playback":
            config["playback_files"] = ["pageset.manifest"]
        playback = get_playback(config)
        strategy = playback.proxy_use_case
        if proxy_mode == "record":
            strategy.recording = mock.Mock(recording_path="recording.mp")
        elif proxy_mode == "playback":
            strategy.playback_files = [mock.Mock()]
        with ExitStack() as stack:
            stack.enter_context(
                mock.patch(
                    "mozproxy.backends.mitm.mitm.get_available_port", return_value=18080
                )
            )
            stack.enter_context(
                mock.patch(
                    "mozproxy.backends.mitm.mitm.ProxyPlaybackUseCase._build_replay_paths",
                    return_value=["/tmp/fake.mp"],
                )
            )
            check_proxy = stack.enter_context(
                mock.patch.object(playback, "check_proxy", return_value=True)
            )
            process_handler = stack.enter_context(
                mock.patch("mozproxy.backends.mitm.mitm.ProcessHandler")
            )
            playback.start_mitmproxy("/tmp/mitmdump", "firefox")
        command = process_handler.call_args.args[0]
        assert command[command.index("--listen-port") + 1] == "18080"
        assert "--mode" not in command
        assert "alt_server_replay_ignore_port=true" not in command
        if proxy_mode == "record":
            assert command[command.index("--save-stream-file") + 1] == "recording.mp"
        elif proxy_mode == "playback":
            assert "alt_server_replay=/tmp/fake.mp" in command
        else:
            assert (
                command[command.index("--scripts") + 1]
                == config["intercept_script_path"]
            )
        assert playback.playback_mode == "proxy"
        assert playback.port == 18080
        check_proxy.assert_called_once_with(host="127.0.0.1", port=18080)
        setup = playback.environment_setup
        setup.cert_path = r"C:\test\mitmproxy-ca-cert.pem"
        policies = json.loads(
            setup._policies_content(strategy.browser_policies(playback.host))
        )["policies"]
        assert policies["Certificates"]["Install"] == [setup.cert_path]
        assert policies["CaptivePortal"] is False
        assert policies["Proxy"] == {
            "Mode": "manual",
            "HTTPProxy": "127.0.0.1:18080",
            "SSLProxy": "127.0.0.1:18080",
            "Passthrough": "127.0.0.1",
            "Locked": True,
        }
        if proxy_mode == "intercept":
            assert policies["DNSOverHTTPS"] == {"Enabled": False}
        else:
            assert "DNSOverHTTPS" not in policies


if __name__ == "__main__":
    mozunit.main(runwith="pytest")
