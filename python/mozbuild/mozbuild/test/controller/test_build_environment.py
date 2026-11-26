# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

import unittest

import mozunit

from mozbuild.base import build_environment, mozconfig_exports


class TestBuildEnvironment(unittest.TestCase):
    def test_mozconfig_exports(self):
        self.assertEqual(
            mozconfig_exports([
                "export FOO=bar",
                "export EMPTY=",
                "export NOVALUE",
                "MOZ_MAKE_FLAGS=-j4",
                "UPLOAD_EXTRA_FILES=a",
            ]),
            {"FOO": "bar", "EMPTY": ""},
        )

    def test_mozconfig_exports_none(self):
        self.assertEqual(mozconfig_exports(None), {})

    def test_build_environment(self):
        self.assertEqual(
            build_environment(
                ["export FOO=mozconfig", "export LIB=mozconfig"],
                {
                    "BUILDCACHE_DIR": "/buildcache",
                    "CCACHE_DIR": "/ccache",
                    "LIB": "lib",
                    "SCCACHE_BASEDIRS": "",
                    "SCCACHE_CLIENT_SIDE": "1",
                    "SCCACHE_DIR": "/sccache",
                    "SCCACHE_VERBOSE_STATS": "1",
                },
                {
                    "FOO": "append",
                    "MOZ_PROFILE_GENERATE": "1",
                    "SCCACHE_CLIENT_SIDE": "append",
                },
            ),
            {
                "FOO": "mozconfig",
                "MOZ_PROFILE_GENERATE": "1",
                "BUILDCACHE_DIR": "/buildcache",
                "CCACHE_DIR": "/ccache",
                "LIB": "mozconfig",
                "SCCACHE_CLIENT_SIDE": "1",
                "SCCACHE_DIR": "/sccache",
            },
        )


if __name__ == "__main__":
    mozunit.main()
