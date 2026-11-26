import json
import os
import unittest

import mozunit

from condprof.customization import (
    apply_overrides,
    get_customization,
)

HERE = os.path.dirname(__file__)
CUSTOMIZATIONS = os.path.join(os.path.dirname(HERE), "customization")
FIXTURE_PATH = os.path.join(HERE, "fixtures", "test_base.json")


def _base(name):
    with open(os.path.join(CUSTOMIZATIONS, f"{name}.json")) as f:
        return json.load(f)


def _fixture():
    with open(FIXTURE_PATH) as f:
        return json.load(f)


def _override_json(**overrides):
    """Build a JSON override string using the test fixture as the base."""
    obj = {"customization": FIXTURE_PATH}
    obj.update(overrides)
    return json.dumps(obj)


class TestCustomization(unittest.TestCase):
    """Overrides are resolved from a flat JSON object.

    A key containing "/" is an exact dpath; a key without one is glob-matched
    against every leaf and only creates a top-level key when nothing matches.
    That fallback is silent, so these tests assert that each override shape
    actually changes the customization and leaves no stray top-level keys --
    an override that lands in a stray key is a test that measures nothing.
    """

    def assertNoStrayKeys(self, customized, base):
        if isinstance(base, str):
            base_keys = set(_base(base))
        else:
            base_keys = set(base)
        stray = set(customized) - base_keys
        self.assertEqual(stray, set(), f"override landed in stray keys: {stray}")

    def test_plain_name(self):
        self.assertEqual(get_customization("default"), _base("default"))

    def test_missing_name_raises(self):
        with self.assertRaises(OSError):
            get_customization("no-such-customization")

    def test_explicit_base(self):
        customized = get_customization('{"customization": "default"}')
        self.assertEqual(customized, _base("default"))

    def test_path_based_customization(self):
        customized = get_customization(FIXTURE_PATH)
        self.assertEqual(customized, _fixture())

    def test_exact_dpath_override(self):
        customized = get_customization(
            _override_json(**{"scenario/0/full/flag_a": True})
        )
        self.assertIs(customized["scenario"][0]["full"]["flag_a"], True)
        self.assertNoStrayKeys(customized, _fixture())

    def test_glob_override_of_scenario_step_key(self):
        customized = get_customization(_override_json(flag_a=True))
        self.assertIs(customized["scenario"][0]["full"]["flag_a"], True)
        self.assertNoStrayKeys(customized, _fixture())

    def test_glob_override_max_urls(self):
        customized = get_customization(_override_json(max_urls=100))
        self.assertEqual(customized["scenario"][0]["full"]["max_urls"], 100)
        self.assertNoStrayKeys(customized, _fixture())

    def test_glob_override_delete_after_build(self):
        customized = get_customization(
            _override_json(delete_after_build=["storage.sqlite"])
        )
        # The glob replaces every matching leaf, so both the customization-level
        # list and the step's list change.
        self.assertEqual(customized["delete_after_build"], ["storage.sqlite"])
        self.assertEqual(
            customized["scenario"][0]["full"]["delete_after_build"], ["storage.sqlite"]
        )
        self.assertNoStrayKeys(customized, _fixture())

    def test_multiple_glob_overrides(self):
        customized = get_customization(_override_json(max_urls=100, flag_a=True))
        step = customized["scenario"][0]["full"]
        self.assertEqual(step["max_urls"], 100)
        self.assertIs(step["flag_a"], True)
        self.assertNoStrayKeys(customized, _fixture())

    def test_glob_sets_every_matching_leaf(self):
        vanilla = {"a": {"x": 1}, "b": {"c": {"x": 2}}, "x": 3}
        customized = apply_overrides(vanilla, {"globs": {"x": 99}, "overrides": {}})
        self.assertEqual(customized, {"a": {"x": 99}, "b": {"c": {"x": 99}}, "x": 99})

    def test_scenario_override_inherits_base_defaults(self):
        base = _fixture()
        base_opts = base["scenario"][0]["full"]
        customized = get_customization(
            _override_json(**{"scenario": [{"full": {}}, {"full": {"flag_a": True}}]})
        )
        self.assertEqual(customized["scenario"][0]["full"], base_opts)
        self.assertEqual(
            customized["scenario"][1]["full"], {**base_opts, "flag_a": True}
        )
        self.assertNoStrayKeys(customized, _fixture())

    def test_pref_override_exact_dpath(self):
        customized = get_customization(_override_json(**{"prefs/some.pref.timeout": 0}))
        self.assertEqual(customized["prefs"]["some.pref.timeout"], 0)
        self.assertNoStrayKeys(customized, _fixture())

    def test_pref_override_glob(self):
        customized = get_customization(_override_json(**{"some.pref.timeout": 0}))
        self.assertEqual(customized["prefs"]["some.pref.timeout"], 0)
        self.assertNoStrayKeys(customized, _fixture())

    def test_override_does_not_mutate_base(self):
        before = _fixture()
        get_customization(_override_json(**{"scenario/0/full/flag_a": True}))
        self.assertEqual(_fixture(), before)

    def test_keep_cache_default(self):
        customized = get_customization(FIXTURE_PATH)
        self.assertIs(customized["keep_cache"], False)

    def test_keep_cache_override(self):
        customized = get_customization(_override_json(keep_cache=True))
        self.assertIs(customized["keep_cache"], True)
        self.assertNoStrayKeys(customized, _fixture())

    def test_unmatched_glob_creates_stray_key(self):
        customized = get_customization(_override_json(no_such_option=True))
        self.assertEqual(customized["scenario"], _fixture()["scenario"])
        self.assertIn("no_such_option", customized)


if __name__ == "__main__":
    mozunit.main()
