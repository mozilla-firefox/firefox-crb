import os
import tempfile
import unittest
from unittest import mock

import mozunit

from condprof.client import (
    ProfileNotFoundError,
    compute_customization_key,
    get_profile,
    get_profile_archive_name,
    save_profile_to_cache,
)


class TestProfileArchiveName(unittest.TestCase):
    def test_plain_customization(self):
        self.assertEqual(
            get_profile_archive_name("linux64", "settled", "default"),
            "profile-linux64-settled-default.tgz",
        )

    def test_version_prefix(self):
        self.assertEqual(
            get_profile_archive_name("win64", "full", "default", version="140.0"),
            "profile-v140.0-win64-full-default.tgz",
        )

    def test_json_override_is_hashed(self):
        customization = '{"customization": "default", "max_urls": 10}'
        name = get_profile_archive_name("linux64", "settled", customization)
        key = compute_customization_key(customization)
        self.assertEqual(name, f"profile-linux64-settled-{key}.tgz")
        self.assertNotIn("{", name)

    def test_get_profile_looks_up_the_same_name(self):
        """A locally cached archive is only found if it was written under
        the name this helper produces."""
        customization = '{"customization": "default", "max_urls": 10}'
        with tempfile.TemporaryDirectory() as target:
            with self.assertRaises(ProfileNotFoundError) as cm:
                get_profile(
                    target,
                    "linux64",
                    "settled",
                    customization,
                    download_cache=False,
                    run_local=True,
                )
        expected = get_profile_archive_name("linux64", "settled", customization)
        self.assertTrue(str(cm.exception).endswith(expected), str(cm.exception))


class TestSaveProfileToCache(unittest.TestCase):
    def test_round_trip(self):
        customization = '{"customization": "default", "max_urls": 10}'
        with tempfile.TemporaryDirectory() as root:
            cache = os.path.join(root, "cache")
            profile = os.path.join(root, "profile")
            target = os.path.join(root, "target")
            for path in (cache, profile, target):
                os.makedirs(path)
            for name in ("prefs.js", "user.js"):
                with open(os.path.join(profile, name), "w") as f:
                    f.write('user_pref("test.pref", 1);\n')
            if os.name != "nt":
                os.symlink("127.0.0.1:+1", os.path.join(profile, "lock"))

            archive = save_profile_to_cache(
                profile, "linux64", "settled", customization, cache_dir=cache
            )

            self.assertEqual(os.path.dirname(archive), cache)
            self.assertEqual(
                os.path.basename(archive),
                get_profile_archive_name("linux64", "settled", customization),
            )
            self.assertFalse(os.path.exists(archive + ".partial"))

            with mock.patch("condprof.client.CONDPROF_CACHE", cache):
                result = get_profile(
                    target, "linux64", "settled", customization, run_local=True
                )
            self.assertEqual(result, target)
            self.assertTrue(os.path.exists(os.path.join(target, "prefs.js")))
            self.assertFalse(os.path.lexists(os.path.join(target, "lock")))


if __name__ == "__main__":
    mozunit.main()
