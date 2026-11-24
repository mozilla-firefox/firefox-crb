# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

import os

import mozunit

from mozversioncontrol import get_repository_object

STEPS = {
    "hg": [
        """
        hg mv foo qux
        """,
        """
        hg commit -m "Rename foo to qux"
        """,
    ],
    "git": [
        """
        git mv foo qux
        """,
        """
        git commit -m "Rename foo to qux"
        """,
    ],
    "jj": [
        # snapshot, since bug 1962245 suppresses automatic ones
        """
        mv foo qux
        jj log -n0
        """,
        """
        jj commit -m "Rename foo to qux"
        """,
    ],
}


def assert_files(actual, expected):
    assert set(map(os.path.basename, actual)) == set(expected)


def test_renamed_files(repo):
    vcs = get_repository_object(repo.dir)

    repo.execute_next_step()

    assert_files(vcs.get_changed_files("A", "all"), ["qux"])
    assert_files(vcs.get_changed_files("D", "all"), ["foo"])
    assert_files(vcs.get_changed_files("ADM", "all"), ["foo", "qux"])
    if repo.vcs == "git":
        assert_files(vcs.get_changed_files("A", "staged"), ["qux"])
        assert_files(vcs.get_changed_files("D", "staged"), ["foo"])

    repo.execute_next_step()

    assert_files(vcs.get_outgoing_files("A"), ["qux"])
    assert_files(vcs.get_outgoing_files("D"), ["foo"])
    assert_files(vcs.get_outgoing_files("ADM"), ["foo", "qux"])


if __name__ == "__main__":
    mozunit.main()
