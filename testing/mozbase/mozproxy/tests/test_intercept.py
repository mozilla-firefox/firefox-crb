#!/usr/bin/env python
import os
from unittest import mock

import mozinfo
import mozunit
import pytest
from mozproxy import get_playback
from support import firefox_binary, tempdir

here = os.path.dirname(__file__)


def kill(pid, signal):
    if pid == 1234:
        return
    return os.kill(pid, signal)


class Process:
    def __init__(self, *args, **kw):
        pass

    def run(self):
        pass

    def poll(self):
        return None

    def wait(self):
        return 0

    def kill(self, sig=9):
        pass

    proc = object()
    pid = 1234
    stderr = stdout = []
    returncode = 0


@mock.patch("mozproxy.backends.mitm.Mitmproxy.check_proxy")
@mock.patch("mozproxy.backends.mitm.Mitmproxy.wait_for_ca_cert")
@mock.patch("mozproxy.backends.mitm.mitm.ProcessHandler", new=Process)
@mock.patch("mozproxy.utils.Popen", new=Process)
@mock.patch("os.kill", new=kill)
def test_intercept_mode(*args):
    config = {
        "playback_tool": "mitmproxy",
        "playback_version": "11.0.0",
        "platform": mozinfo.os,
        "proxy_mode": "intercept",
        "intercept_script_path": os.path.join(here, "intercept_addon.py"),
        "run_local": True,
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
            assert playback.port is not None
        finally:
            playback.stop()


@mock.patch("mozproxy.backends.mitm.Mitmproxy.check_proxy")
@mock.patch("mozproxy.backends.mitm.Mitmproxy.wait_for_ca_cert")
@mock.patch("mozproxy.backends.mitm.mitm.ProcessHandler", new=Process)
@mock.patch("mozproxy.utils.Popen", new=Process)
def test_intercept_mode_missing_script(*args):
    config = {
        "playback_tool": "mitmproxy",
        "playback_version": "11.0.0",
        "platform": mozinfo.os,
        "proxy_mode": "intercept",
        "run_local": True,
        "binary": "firefox",
        "app": "firefox",
        "host": "127.0.0.1",
    }

    with tempdir() as obj_path:
        config["obj_path"] = obj_path
        with pytest.raises(Exception, match="intercept_script_path"):
            get_playback(config)


@mock.patch("mozproxy.backends.mitm.Mitmproxy.check_proxy")
@mock.patch("mozproxy.backends.mitm.Mitmproxy.wait_for_ca_cert")
@mock.patch("mozproxy.backends.mitm.mitm.ProcessHandler", new=Process)
@mock.patch("mozproxy.utils.Popen", new=Process)
def test_intercept_mode_nonexistent_script(*args):
    config = {
        "playback_tool": "mitmproxy",
        "playback_version": "11.0.0",
        "platform": mozinfo.os,
        "proxy_mode": "intercept",
        "intercept_script_path": os.path.join(here, "does_not_exist.py"),
        "run_local": True,
        "binary": "firefox",
        "app": "firefox",
        "host": "127.0.0.1",
    }

    with tempdir() as obj_path:
        config["obj_path"] = obj_path
        with pytest.raises(Exception, match="does not exist"):
            get_playback(config)


if __name__ == "__main__":
    mozunit.main(runwith="pytest")
