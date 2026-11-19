# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

import os
import shutil
import subprocess
import sys
import tempfile
import uuid
from contextlib import ExitStack, contextmanager


def make_version(make):
    try:
        output = subprocess.check_output(
            [make, "--version"], stderr=subprocess.DEVNULL, text=True
        )
    except (subprocess.CalledProcessError, OSError):
        return None
    first_line = output.splitlines()[0] if output else ""
    if not first_line.startswith("GNU Make "):
        return None
    try:
        return tuple(
            int(part) for part in first_line.removeprefix("GNU Make ").split(".")[:2]
        )
    except ValueError:
        return None


@contextmanager
def _semaphore(jobs):
    import ctypes
    from ctypes import wintypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateSemaphoreW.restype = wintypes.HANDLE
    kernel32.CreateSemaphoreW.argtypes = (
        ctypes.c_void_p,
        wintypes.LONG,
        wintypes.LONG,
        wintypes.LPCWSTR,
    )
    kernel32.CloseHandle.argtypes = (wintypes.HANDLE,)
    name = f"gmake_semaphore_{os.getpid()}_{uuid.uuid4().hex}"
    handle = kernel32.CreateSemaphoreW(None, jobs - 1, jobs - 1, name)
    if not handle:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        yield name
    finally:
        kernel32.CloseHandle(handle)


@contextmanager
def _pipe(jobs):
    read, write = os.pipe()
    try:
        os.write(write, b"+" * (jobs - 1))
        os.set_inheritable(read, True)
        os.set_inheritable(write, True)
        yield f"{read},{write}"
    finally:
        os.close(read)
        os.close(write)


@contextmanager
def _fifo(jobs):
    tmpdir = tempfile.mkdtemp(prefix="jobserver")
    path = os.path.join(tmpdir, "fifo")
    try:
        os.mkfifo(path, 0o600)
        fd = os.open(path, os.O_RDWR)
        try:
            os.write(fd, b"+" * (jobs - 1))
            yield f"fifo:{path}"
        finally:
            os.close(fd)
    finally:
        shutil.rmtree(tmpdir)


@contextmanager
def jobserver(jobs, make):
    inherited = os.environ.get("MAKEFLAGS", "")
    version = make_version(make) or (0,)
    flags, sep, assignments = f" {inherited}".partition(" -- ")
    flags = [
        flag
        for flag in flags.split()
        if not flag.startswith(("-j", "--jobserver-auth=", "--jobserver-fds="))
    ]
    flags.append(f"-j{jobs}")
    with ExitStack() as stack:
        if jobs >= 2 and version >= (4, 2):
            if sys.platform == "win32":
                server = _semaphore
            elif version >= (4, 4):
                server = _fifo
            else:
                server = _pipe
            try:
                auth = stack.enter_context(server(jobs))
                flags.append(f"--jobserver-auth={auth}")
            except OSError:
                pass
        yield " ".join(flags) + sep + assignments
