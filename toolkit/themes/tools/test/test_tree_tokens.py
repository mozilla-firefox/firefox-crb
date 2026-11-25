# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

import os
import sys

import mozunit
import pytest

TOOLS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, TOOLS)

import token_resolve  # noqa: E402

DIST = os.path.join(TOOLS, "..", "shared", "design-system", "dist")
HERE = os.path.relpath(__file__, os.path.join(TOOLS, "..", "..", ".."))


def test_every_token_resolves(capsys):
    if token_resolve.check(DIST):
        out = capsys.readouterr().out
        # Treeherder's failure summary shows only the lines with this marker.
        heads = dict.fromkeys(line for line in out.splitlines() if line[:2] == "--")
        marked = "".join(f"TEST-UNEXPECTED-FAIL | {HERE} | {h}\n" for h in heads)
        pytest.fail(f"{marked}\n{out}", pytrace=False)


if __name__ == "__main__":
    mozunit.main()
