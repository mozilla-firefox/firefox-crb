# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

# Imported as a module rather than a class: import_support_class() takes the
# first BasePythonSupport subclass it finds in this file's namespace.
import condprof_support


class QuotaUsage(condprof_support.CondprofSupport):
    """Reports the storage usage navigator.storage.estimate() returns in a
    profile the quota_usage scenario populated."""

    def handle_result(self, bt_result, raw_result, last_result=False, **kwargs):
        for extras in raw_result.get("extras", []):
            value = extras.get("custom_data", {}).get("usage_bytes")
            if value is not None:
                bt_result["measurements"].setdefault("usage_bytes", []).append(value)

    def summarize_test(self, test, suite, **kwargs):
        suite["type"] = "pageload"
        if suite["subtests"] == {}:
            suite["subtests"] = []
        for measurement_name, replicates in test["measurements"].items():
            if not replicates:
                continue
            suite["subtests"].append(
                self._build_standard_subtest(test, replicates, measurement_name)
            )
        suite["subtests"].sort(key=lambda subtest: subtest["name"])
