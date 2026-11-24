# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

from unittest import mock

import mozunit
import pytest

from mozversioncontrol import get_repository_object

# One jj diff entry per file status, rendered as "status\tsource\ttarget".
ENTRIES = (
    "modified\tmodified.c\tmodified.c\n"
    "added\tadded.c\tadded.c\n"
    "removed\tremoved.c\tremoved.c\n"
    "copied\toriginal.c\tcopy.c\n"
    "renamed\told.c\tnew.c\n"
)


def jj_repository_listing(repo, entries):
    if repo.vcs != "jj":
        pytest.skip("jj only")
    vcs = get_repository_object(repo.dir)
    vcs._run = mock.MagicMock(return_value=entries)
    vcs._run_read_only = mock.MagicMock(return_value=entries)
    return vcs


@pytest.mark.parametrize(
    "diff_filter,expected",
    [
        ("M", ["modified.c"]),
        ("A", ["added.c", "copy.c", "new.c"]),
        ("D", ["old.c", "removed.c"]),
    ],
)
def test_jj_file_statuses(repo, diff_filter, expected):
    vcs = jj_repository_listing(repo, ENTRIES)

    assert sorted(vcs.get_changed_files(diff_filter)) == expected
    assert sorted(vcs.get_outgoing_files(diff_filter, "trunk()")) == expected


def test_jj_unknown_file_status(repo):
    vcs = jj_repository_listing(repo, "future-status\tfile.c\tfile.c\n")

    with pytest.raises(Exception, match="unexpected jj file status 'future-status'"):
        vcs.get_changed_files("ADM")
    with pytest.raises(Exception, match="unexpected jj file status 'future-status'"):
        vcs.get_outgoing_files("ADM", "trunk()")


if __name__ == "__main__":
    mozunit.main()
