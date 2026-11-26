# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

import os
import tempfile
import unittest
from unittest import mock

import mozunit

from mozbuild.action import find_dupes

_DEFINES = {"ALLDEFINES": {}}


class TestAllowedDupes(unittest.TestCase):
    def test_per_instance(self):
        first = find_dupes.AllowedDupes()
        first.add("chrome/foo.properties")
        first.add("res/fonts/*")

        second = find_dupes.AllowedDupes()

        self.assertTrue(first.is_allowed("chrome/foo.properties"))
        self.assertTrue(first.is_allowed("res/fonts/TwemojiMozilla.ttf"))
        self.assertFalse(second.is_allowed("chrome/foo.properties"))
        self.assertFalse(second.is_allowed("res/fonts/TwemojiMozilla.ttf"))


def _tree(root, dupes=("one.txt", "two.txt")):
    source = os.path.join(root, "staged")
    for name in dupes:
        path = os.path.join(source, name)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as f:
            f.write("identical")
    with open(os.path.join(source, "unique.txt"), "w") as f:
        f.write("different")
    return source


class TestFindDupes(unittest.TestCase):
    def test_unexpected_dupes(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = _tree(tmp)

            self.assertEqual(
                find_dupes.find_dupes(source, find_dupes.AllowedDupes()), 1
            )

    def test_warn_dupes(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = _tree(tmp)

            self.assertEqual(
                find_dupes.find_dupes(source, find_dupes.AllowedDupes(), bail=False), 0
            )

    def test_allowed_dupes(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = _tree(tmp)
            allowed = find_dupes.AllowedDupes()
            allowed.add("one.txt")
            allowed.add("two.txt")

            self.assertEqual(find_dupes.find_dupes(source, allowed), 0)

    def test_l10n_dupes(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = _tree(
                tmp,
                (
                    "chrome/en-US/locale/one.txt",
                    "browser/localization/en-US/one.ftl",
                    "localization/en-US/one.ftl",
                ),
            )

            self.assertEqual(
                find_dupes.find_dupes(source, find_dupes.AllowedDupes()), 0
            )


class TestFindDupesMain(unittest.TestCase):
    def _run(self, source, allowlist):
        with mock.patch.object(find_dupes.buildconfig, "defines", _DEFINES):
            return find_dupes.main(["-f", allowlist, source])

    def test_allowlists_per_invocation(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = _tree(tmp)

            permissive = os.path.join(tmp, "allowed-dupes.txt")
            with open(permissive, "w") as f:
                f.write("one.txt\ntwo.txt\n")
            strict = os.path.join(tmp, "no-allowed-dupes.txt")
            with open(strict, "w") as f:
                f.write("# nothing is allowed\n")

            self.assertEqual(self._run(source, permissive), 0)
            self.assertEqual(self._run(source, strict), 1)


if __name__ == "__main__":
    mozunit.main()
