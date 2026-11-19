# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

import io
import os
import subprocess
import tempfile
import unittest
from unittest import mock

import mozunit

from mozbuild.action import check_elfhack


class TestCheckElfhack(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = self._tmp.name
        self.libraries = []
        for name in ("libtest-array.so", "libtest-ctors.so"):
            path = os.path.join(self.tmp, name)
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(name)
            self.libraries.append(path)
        self.output = mock.Mock()
        self.output.name = os.path.join(self.tmp, "elfhack-test.stamp")
        self.calls = []

    def tearDown(self):
        self._tmp.cleanup()

    def _run(
        self,
        dynamic=None,
        backup=True,
        relocations=(3, 2),
        dummy_status=0,
        readelf_error=None,
    ):
        dynamic = dynamic or {
            "libtest-array.so": "INIT_ARRAY",
            "libtest-ctors.so": "INIT",
        }

        def check_output(argv, text):
            if readelf_error:
                raise readelf_error
            readelf, flag, path = argv
            if flag == "-d":
                return f" 0x19 ({dynamic[os.path.basename(path)]}) 0x0\n"
            count = relocations[0] if path.endswith(".bak") else relocations[1]
            return "r\n" * count

        def check_call(argv, env=None):
            self.calls.append((argv, env and env.get("LD_PRELOAD")))
            if argv[1:2] == ["-b"]:
                with open(argv[-1], "w", encoding="utf-8") as fh:
                    fh.write("hacked")
                if backup:
                    with open(f"{argv[-1]}.bak", "w", encoding="utf-8"):
                        pass
            if env and dummy_status:
                raise subprocess.CalledProcessError(dummy_status, argv)

        with mock.patch.object(
            check_elfhack.subprocess, "check_output", side_effect=check_output
        ), mock.patch.object(
            check_elfhack.subprocess, "check_call", side_effect=check_call
        ), mock.patch("sys.stderr", new_callable=io.StringIO) as stderr:
            status = check_elfhack.main(
                self.output, *self.libraries, "elfhack", "dummy", "readelf"
            )
        self.stderr = stderr.getvalue()
        return status

    def test_check_elfhack(self):
        self.assertEqual(self._run(), 0)
        workdir = f"{self.output.name}.libs"
        hacked = [os.path.join(workdir, os.path.basename(l)) for l in self.libraries]
        self.assertEqual(
            self.calls,
            [
                ([os.path.abspath("elfhack"), "-b", "-f", hacked[0]], None),
                ([os.path.abspath("dummy")], os.path.abspath(hacked[0])),
                ([os.path.abspath("elfhack"), "-b", "-f", hacked[1]], None),
                ([os.path.abspath("dummy")], os.path.abspath(hacked[1])),
            ],
        )

    def test_check_elfhack_cross_compile(self):
        with mock.patch.object(
            check_elfhack, "_elfhack", side_effect=lambda *args: args[2]
        ) as elfhack, mock.patch.object(
            check_elfhack.subprocess, "check_call"
        ) as check_call:
            self.assertEqual(
                check_elfhack.main(self.output, *self.libraries, "elfhack", "readelf"),
                0,
            )
        check_call.assert_not_called()
        workdir = f"{self.output.name}.libs"
        self.assertEqual(
            elfhack.call_args_list,
            [
                mock.call(
                    "readelf",
                    os.path.abspath("elfhack"),
                    self.libraries[0],
                    "INIT_ARRAY",
                    workdir,
                ),
                mock.call(
                    "readelf",
                    os.path.abspath("elfhack"),
                    self.libraries[1],
                    "INIT",
                    workdir,
                ),
            ],
        )

    def _assert_fails(self, message, **kwargs):
        self.assertEqual(self._run(**kwargs), 1)
        self.assertIn(message, self.stderr)

    def test_check_elfhack_missing_dynamic_tag(self):
        self._assert_fails(
            f"{self.libraries[0]} has no INIT_ARRAY .dynamic entry",
            dynamic={"libtest-array.so": "INIT", "libtest-ctors.so": "INIT"},
        )

    def test_check_elfhack_init_array_is_not_init(self):
        self._assert_fails(
            f"{self.libraries[1]} has no INIT .dynamic entry",
            dynamic={
                "libtest-array.so": "INIT_ARRAY",
                "libtest-ctors.so": "INIT_ARRAY",
            },
        )

    def test_check_elfhack_missing_backup(self):
        self._assert_fails("elfhack did not write", backup=False)

    def test_check_elfhack_relocations_not_removed(self):
        self._assert_fails(
            f"elfhack did not remove relocations from {self.libraries[0]}",
            relocations=(2, 2),
        )

    def test_check_elfhack_dummy_failure(self):
        hacked = os.path.join(f"{self.output.name}.libs", "libtest-array.so")
        self._assert_fails(
            f"with LD_PRELOAD={os.path.abspath(hacked)}\n", dummy_status=1
        )

    def test_check_elfhack_missing_readelf(self):
        self._assert_fails(
            "No such file: 'readelf'",
            readelf_error=FileNotFoundError(2, "No such file", "readelf"),
        )

    def test_check_elfhack_keeps_library(self):
        self._run()
        with open(self.libraries[0], encoding="utf-8") as fh:
            self.assertEqual(fh.read(), "libtest-array.so")

    def test_check_elfhack_rerun_missing_backup(self):
        self.assertEqual(self._run(), 0)
        self._assert_fails("elfhack did not write", backup=False)


if __name__ == "__main__":
    mozunit.main()
