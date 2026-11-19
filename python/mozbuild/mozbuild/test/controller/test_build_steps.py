# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

import unittest
from unittest import mock

import mozunit

from mozbuild.controller.building import (
    BuildDriver,
    build_step_command,
    select_build_steps,
)

ARTIFACT = {"MOZ_ARTIFACT_BUILDS": True}


class TestSelectBuildSteps(unittest.TestCase):
    def test_select_build_steps_default(self):
        self.assertEqual(select_build_steps(None, ARTIFACT), (["artifact"], None))

    def test_select_build_steps_default_empty(self):
        self.assertEqual(select_build_steps([], ARTIFACT), (["artifact"], None))

    def test_select_build_steps_default_disabled(self):
        self.assertEqual(select_build_steps(None, {}), ([], None))

    def test_select_build_steps_requested(self):
        self.assertEqual(
            select_build_steps(["artifact", "faster"], ARTIFACT),
            (["artifact"], ["faster"]),
        )

    def test_select_build_steps_requested_only(self):
        self.assertEqual(select_build_steps(["artifact"], ARTIFACT), (["artifact"], []))

    def test_select_build_steps_not_requested(self):
        self.assertEqual(select_build_steps(["faster"], ARTIFACT), ([], ["faster"]))

    def test_select_build_steps_requested_disabled(self):
        with self.assertRaisesRegex(ValueError, "Not enabled in this build: artifact"):
            select_build_steps(["artifact"], {})

    def test_select_build_steps_all(self):
        for target in ("all", "default"):
            self.assertEqual(
                select_build_steps([target], ARTIFACT), (["artifact"], [target])
            )

    def test_select_build_steps_all_disabled(self):
        self.assertEqual(select_build_steps(["default"], {}), ([], ["default"]))

    def test_select_build_steps_directory(self):
        self.assertEqual(
            select_build_steps(["all"], ARTIFACT, "some/dir"), ([], ["all"])
        )


class TestBuildStepCommand(unittest.TestCase):
    def _command(self, substs, verbose=False):
        return build_step_command(
            "artifact", {"PYTHON3": "python3", **substs}, "/src", verbose
        )

    def test_build_step_command_artifact(self):
        self.assertEqual(
            self._command({"ENABLE_TESTS": True}),
            ["python3", "/src/mach", "--log-no-times", "artifact", "install"],
        )

    def test_build_step_command_artifact_no_tests(self):
        self.assertEqual(
            self._command({}),
            [
                "python3",
                "/src/mach",
                "--log-no-times",
                "artifact",
                "install",
                "--no-tests",
            ],
        )

    def test_build_step_command_artifact_symbols(self):
        self.assertEqual(
            self._command({"ENABLE_TESTS": True, "MOZ_ARTIFACT_BUILD_SYMBOLS": True}),
            [
                "python3",
                "/src/mach",
                "--log-no-times",
                "artifact",
                "install",
                "--symbols",
            ],
        )

    def test_build_step_command_artifact_symbols_full(self):
        self.assertEqual(
            self._command(
                {"ENABLE_TESTS": True, "MOZ_ARTIFACT_BUILD_SYMBOLS": "full"},
                verbose=True,
            ),
            [
                "python3",
                "/src/mach",
                "--log-no-times",
                "artifact",
                "install",
                "--symbols=full",
                "-v",
            ],
        )

    def test_build_step_command_unknown(self):
        with self.assertRaisesRegex(ValueError, "Unknown build step: faster"):
            build_step_command("faster", {"PYTHON3": "python3"}, "/src", False)


class TestRunBuildSteps(unittest.TestCase):
    def _run(self, status):
        driver = mock.Mock(topsrcdir="/src", topobjdir="/obj")
        driver.run_process.return_value = status
        output = mock.Mock()
        result = BuildDriver._run_build_steps(
            driver, ["artifact"], {"PYTHON3": "python3"}, output, False, {}
        )
        return result, [c.args[0] for c in output.on_stdout_line.call_args_list]

    def test_run_build_steps(self):
        self.assertEqual(
            self._run(0),
            (
                0,
                [
                    "BUILDSTATUS TIERS artifact",
                    "BUILDSTATUS TIER_START artifact",
                    "BUILDSTATUS TIER_FINISH artifact",
                ],
            ),
        )

    def test_run_build_steps_failure(self):
        self.assertEqual(
            self._run(2),
            (2, ["BUILDSTATUS TIERS artifact", "BUILDSTATUS TIER_START artifact"]),
        )


if __name__ == "__main__":
    mozunit.main()
