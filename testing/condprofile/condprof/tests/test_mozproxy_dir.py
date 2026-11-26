import os
import shutil
import unittest
from unittest import mock

import mozunit

from condprof.util import mozproxy_download_dir


class TestMozproxyDownloadDir(unittest.TestCase):
    def setUp(self):
        self.temp_dirs = []

    def tearDown(self):
        for path in self.temp_dirs:
            shutil.rmtree(path, ignore_errors=True)

    def resolve(self, proxy_dir, env):
        with mock.patch.dict(os.environ, env, clear=True):
            with mock.patch("condprof.util.logger") as logger:
                result = mozproxy_download_dir(proxy_dir)
        if result is not None and result != proxy_dir:
            self.temp_dirs.append(result)
        return result, logger

    def test_explicit_proxy_dir_wins(self):
        result, logger = self.resolve("/obj", {"MOZ_UPLOAD_DIR": "/task/upload"})
        self.assertEqual(result, "/obj")
        logger.warning.assert_not_called()

    def test_automation_leaves_it_to_mozproxy(self):
        result, logger = self.resolve(None, {"MOZ_UPLOAD_DIR": "/task/upload"})
        self.assertIsNone(result)
        logger.warning.assert_not_called()

    def test_no_directory_warns_and_uses_a_temp_dir(self):
        result, logger = self.resolve(None, {})
        self.assertTrue(os.path.isdir(result))
        logger.warning.assert_called_once()


if __name__ == "__main__":
    mozunit.main()
