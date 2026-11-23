# Any copyright is dedicated to the Public Domain.
# http://creativecommons.org/publicdomain/zero/1.0/

import unittest
from pathlib import Path
from shutil import rmtree
from tempfile import mkdtemp
from unittest import mock

import buildconfig
import mozunit

with mock.patch.object(
    buildconfig,
    "substs",
    {"BIN_SUFFIX": "", "DLL_PREFIX": "lib", "DLL_SUFFIX": ".so"},
):
    from mozbuild.action import test_archive

FILES = {
    "mochitest/runtests.py": "",
    "mochitest/tests/SimpleTest/SimpleTest.js": "",
    "mochitest/tests/dom/other/test_unrelated.html": "",
    "mochitest/tests/dom/shared/helper.js": "",
    "mochitest/tests/dom/shared/unused.js": "",
    "mochitest/tests/dom/perf/test_perf.html": "",
    "mochitest/tests/dom/perf/perftest.toml": (
        '[DEFAULT]\nsupport-files = ["!/dom/shared/helper.js"]\n\n["test_perf.html"]\n'
    ),
    "mochitest/browser/comp/perf/head.js": "",
    "mochitest/browser/comp/perf/browser_perf.js": "",
    "mochitest/browser/comp/perf/perftest.toml": (
        "[DEFAULT]\n"
        'support-files = ["head.js", "!/toolkit/shared/*.sys.mjs"]\n\n'
        '["browser_perf.js"]\n'
        'disabled = "Only runs as a perftest"\n'
    ),
    "mochitest/browser/toolkit/shared/a.sys.mjs": "",
    "mochitest/browser/toolkit/shared/b.sys.mjs": "",
    "mochitest/browser/toolkit/shared/c.js": "",
    "mochitest/browser/other/browser_unrelated.js": "",
}


class TestMochitestPerftestArchive(unittest.TestCase):
    def setUp(self):
        self.objdir = mkdtemp()
        for name, content in FILES.items():
            path = Path(self.objdir, "_tests", "testing", name)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content)
        patcher = mock.patch.object(test_archive.buildconfig, "topobjdir", self.objdir)
        patcher.start()
        self.addCleanup(patcher.stop)

    def tearDown(self):
        rmtree(self.objdir)

    def test_entry_patterns(self):
        entry = test_archive.mochitest_perftest_entry()
        roots = test_archive.MOCHITEST_TEST_ROOTS
        expected = {"mochitest/tests/dom/perf/**", "mochitest/browser/comp/perf/**"}
        expected.update(f"mochitest/{r}/dom/shared/helper.js" for r in roots)
        expected.update(f"mochitest/{r}/toolkit/shared/*.sys.mjs" for r in roots)
        self.assertEqual(entry["source"], self.objdir)
        self.assertEqual(entry["base"], "_tests/testing")
        self.assertEqual(set(entry["patterns"]), expected)

    def test_archive_contents(self):
        harness = [
            dict(e, source=self.objdir)
            for e in test_archive.ARCHIVE_FILES["mochitest-perftest"]
            if e.get("base") == "_tests/testing"
        ]
        with mock.patch.dict(
            test_archive.ARCHIVE_FILES, {"mochitest-perftest": harness}
        ), mock.patch.object(
            test_archive, "find_generated_harness_files", return_value=[]
        ):
            files = {p for p, _ in test_archive.find_files("mochitest-perftest")}
        self.assertEqual(
            files,
            {
                "mochitest/runtests.py",
                "mochitest/tests/SimpleTest/SimpleTest.js",
                "mochitest/tests/dom/shared/helper.js",
                "mochitest/tests/dom/perf/test_perf.html",
                "mochitest/tests/dom/perf/perftest.toml",
                "mochitest/browser/comp/perf/head.js",
                "mochitest/browser/comp/perf/browser_perf.js",
                "mochitest/browser/comp/perf/perftest.toml",
                "mochitest/browser/toolkit/shared/a.sys.mjs",
                "mochitest/browser/toolkit/shared/b.sys.mjs",
            },
        )


if __name__ == "__main__":
    mozunit.main()
