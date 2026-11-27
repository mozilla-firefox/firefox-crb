# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

import os
import tempfile
import unittest
import zipfile
from unittest import mock

import mozunit

from mozbuild.action import langpack_manifest, package_langpack


class TestPackageLangpack(unittest.TestCase):
    def test_package_langpack(self):
        with tempfile.TemporaryDirectory() as tmp:
            stage = os.path.join(tmp, "stage")
            for path in (
                "chrome.manifest",
                "chrome/de/locale/de/global/intl.properties",
                "chrome/de/locale/de/global/prefs.js",
                "chrome/de/locale/de/global/update.ini",
                "localization/de/browser/browser.ftl",
                "res/multilocale.txt",
            ):
                os.makedirs(os.path.dirname(os.path.join(stage, path)), exist_ok=True)
                with open(os.path.join(stage, path), "w") as fh:
                    fh.write(path)
            output = os.path.join(tmp, "xpi", "de.langpack.xpi")

            with mock.patch.object(
                langpack_manifest, "langpack_manifest", return_value='{"name": "de"}'
            ) as manifest:
                rc = package_langpack.package_langpack(
                    locale="de",
                    xpi_stage=stage,
                    metadata="/l10n/de/langpack-metadata.ftl",
                    output=output,
                    eid="langpack-de@firefox.mozilla.org",
                    app_version="156.0a1",
                    max_app_ver="156.*",
                    app_name="Firefox",
                    l10n_basedir="/l10n",
                    includes=["chrome", "localization"],
                )

            self.assertEqual(rc, 0)
            manifest.assert_called_once_with(
                locales="de",
                app_version="156.0a1",
                max_app_ver="156.*",
                app_name="Firefox",
                l10n_basedir="/l10n",
                langpack_eid="langpack-de@firefox.mozilla.org",
                metadata="/l10n/de/langpack-metadata.ftl",
                input=stage,
            )
            with zipfile.ZipFile(output) as xpi:
                self.assertEqual(
                    sorted(xpi.namelist()),
                    [
                        "chrome/de/locale/de/global/intl.properties",
                        "localization/de/browser/browser.ftl",
                        "manifest.json",
                    ],
                )
                self.assertEqual(xpi.read("manifest.json"), b'{"name": "de"}\n')
            self.assertFalse(os.path.exists(os.path.join(stage, "manifest.json")))


if __name__ == "__main__":
    mozunit.main()
