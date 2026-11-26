# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

# Imported as a module rather than a class: import_support_class() takes the
# first BasePythonSupport subclass it finds in this file's namespace.
import condprof_support

COLD = "loadQuotaMs-cold"
WARM = "loadQuotaMs-warm"


class StorageInitialization(condprof_support.CondprofSupport):
    """Reports the cold and warm storage initialization costs separately.

    All browsertime iterations share one profile, so only the first sees the
    state the condprof scenario built (a dirty shutdown, a missing cache, and
    so on); it then shuts down cleanly, leaving every later iteration to
    measure an already-valid cache. Pooling them would hide the very cost these
    tests exist to measure, so the first iteration is reported as `-cold` and
    the rest as `-warm`, and the two are never combined.

    Aggregation is left to perfherder, which averages each subtest over its
    rolling window of pushes. One replicate per subtest per run is therefore
    enough, which is why the desktop manifest uses browser_cycles = 2. On
    Android geckodriver pushes a fresh copy of the profile for every
    iteration, so the mobile manifest runs one cycle and reports only `-cold`.
    """

    def handle_result(self, bt_result, raw_result, last_result=False, **kwargs):
        for index, extras in enumerate(raw_result.get("extras", [])):
            value = extras.get("custom_data", {}).get("loadQuotaMs")
            if value is None:
                continue
            name = COLD if index == 0 else WARM
            bt_result["measurements"].setdefault(name, []).append(value)

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
        # add_additional_metrics() is deliberately not called: it pools cpuTime
        # and friends across every iteration, which would reintroduce exactly
        # the cold/warm average this class exists to avoid.
