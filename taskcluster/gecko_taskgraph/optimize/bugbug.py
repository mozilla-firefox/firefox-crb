# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.


from collections import defaultdict
from fnmatch import fnmatch

from requests.exceptions import RetryError
from taskgraph.optimize.base import OptimizationStrategy, register_strategy, registry

from gecko_taskgraph.util.bugbug import (
    CT_HIGH,
    CT_LOW,
    CT_MEDIUM,
    BugbugTimeoutException,
    PushDataUnavailable,
    get_confidence_threshold,
    get_push_schedules,
    get_selection_parameters,
)

FALLBACK = "skip-unless-has-relevant-tests"


@register_strategy("bugbug-low", args=(CT_LOW,))
@register_strategy("bugbug-medium", args=(CT_MEDIUM,))
@register_strategy("bugbug-high", args=(CT_HIGH,))
@register_strategy("bugbug-tasks-medium", args=(CT_MEDIUM, True))
@register_strategy("bugbug-tasks-high", args=(CT_HIGH, True))
@register_strategy("bugbug-reduced", args=(CT_MEDIUM, True, True))
@register_strategy("bugbug-reduced-fallback", args=(CT_MEDIUM, True, True, FALLBACK))
@register_strategy("bugbug-reduced-high", args=(CT_HIGH, True, True))
@register_strategy("bugbug-reduced-manifests", args=(CT_MEDIUM, False, True))
@register_strategy(
    "bugbug-reduced-manifests-config-selection-low",
    args=(CT_LOW, False, True, None, 1, True),
)
@register_strategy(
    "bugbug-reduced-manifests-config-selection",
    args=(CT_MEDIUM, False, True, None, 1, True),
)
@register_strategy(
    "bugbug-reduced-manifests-config-selection-high",
    args=(CT_HIGH, False, True, None, 1, True),
)
# Uses the confidence threshold and number of pushes in the parameters, like the
# manifest loader, so that the manifests it selects are in the tasks.
@register_strategy(
    "bugbug-reduced-manifests-fallback", args=(None, False, True, FALLBACK)
)
class BugBugPushSchedules(OptimizationStrategy):
    """Query the 'bugbug' service to retrieve relevant tasks and manifests.

    Args:
        confidence_threshold (float): The minimum confidence threshold (in
            range [0, 1]) needed for a task to be scheduled, or None to use the
            ones of the `bugbug_confidence_threshold` and `bugbug_num_pushes`
            parameters (instead of `num_pushes`).
        tasks_only (bool): Whether or not to only use tasks and no groups
            (default: False)
        use_reduced_tasks (bool): Whether or not to use the reduced set of tasks
            provided by the bugbug service (default: False).
        fallback (str): The fallback strategy to use if there
            was a failure in bugbug (default: None)
        num_pushes (int): The number of pushes to consider for the selection
            (default: 1).
        select_configs (bool): Whether to select configurations for manifests
            too (default: False).
    """

    def __init__(
        self,
        confidence_threshold,
        tasks_only=False,
        use_reduced_tasks=False,
        fallback=None,
        num_pushes=1,
        select_configs=False,
    ):
        self.confidence_threshold = confidence_threshold
        self.use_reduced_tasks = use_reduced_tasks
        self.fallback = fallback
        self.tasks_only = tasks_only
        self.num_pushes = num_pushes
        self.select_configs = select_configs
        self.timedout = False

    def should_remove_task(self, task, params, importance):
        project = params["project"]

        if project not in ("autoland", "try"):
            return False

        if self.timedout:
            return registry[self.fallback].should_remove_task(task, params, importance)

        if self.confidence_threshold is None:
            confidence_threshold, num_pushes = get_selection_parameters(params)
        else:
            confidence_threshold = self.confidence_threshold
            num_pushes = self.num_pushes

        try:
            data = get_push_schedules(params, num_pushes)
        except (BugbugTimeoutException, RetryError, PushDataUnavailable):
            if not self.fallback:
                raise

            self.timedout = True
            return self.should_remove_task(task, params, importance)

        key = "reduced_tasks" if self.use_reduced_tasks else "tasks"
        tasks_threshold = get_confidence_threshold(data, "tasks", confidence_threshold)
        tasks = {
            task
            for task, confidence in data.get(key, {}).items()
            if confidence >= tasks_threshold
        }

        test_manifests = task.attributes.get("test_manifests")
        if test_manifests is None or self.tasks_only:
            if data.get("known_tasks") and task.label not in data["known_tasks"]:
                return False

            if task.label not in tasks:
                return True

            return False

        # If a task contains more than one group, use the max confidence.
        groups = data.get("groups", {})
        groups_threshold = get_confidence_threshold(
            data, "groups", confidence_threshold
        )
        confidences = [c for g, c in groups.items() if g in test_manifests]
        if not confidences or max(confidences) < groups_threshold:
            return True

        # If the task configuration doesn't match the ones selected by bugbug for
        # the manifests, optimize out.
        if self.select_configs:
            selected_groups = [
                g
                for g, c in groups.items()
                if g in test_manifests and c > groups_threshold
            ]

            config_groups = data.get("config_groups", defaultdict(list))

            # Configurations returned by bugbug are in a format such as
            # `test-windows10-64/opt-*-e10s`, while task labels are like
            # test-windows10-64-qr/opt-mochitest-browser-chrome-e10s-6.
            # In order to match the strings, we need to ignore the chunk number
            # from the task label.
            parts = task.label.split("-")
            label_without_chunk_number = "-".join(
                parts[:-1] if parts[-1].isdigit() else parts
            )

            if not any(
                fnmatch(label_without_chunk_number, config)
                for group in selected_groups
                for config in config_groups[group]
            ):
                return True

        # Store group importance so future optimizers can access it. Manifests
        # selected at a threshold lower than the low one are at least of low
        # importance, so that they run on some configuration.
        ct_high, ct_medium, ct_low = (
            get_confidence_threshold(data, "groups", ct)
            for ct in (CT_HIGH, CT_MEDIUM, min(CT_LOW, confidence_threshold))
        )
        for manifest in test_manifests:
            if manifest not in groups:
                continue

            confidence = groups[manifest]
            if confidence >= ct_high:
                importance[manifest] = "high"
            elif confidence >= ct_medium:
                importance[manifest] = "medium"
            elif confidence >= ct_low:
                importance[manifest] = "low"
            else:
                importance[manifest] = "lowest"

        return False


@register_strategy("platform-debug")
class SkipUnlessDebug(OptimizationStrategy):
    """Only run debug platforms."""

    def should_remove_task(self, task, params, arg):
        return (
            "build_type" in task.attributes and task.attributes["build_type"] != "debug"
        )


@register_strategy("platform-disperse")
@register_strategy("platform-disperse-no-unseen", args=(None, 0))
@register_strategy(
    "platform-disperse-only-one",
    args=(
        {
            "high": 1,
            "medium": 1,
            "low": 1,
            "lowest": 0,
        },
        0,
    ),
)
class DisperseGroups(OptimizationStrategy):
    """Disperse groups across test configs.

    Each task has an associated 'importance' dict passed in via the arg. This
    is of the form `{<group>: <importance>}`.

    Where 'group' is a test group id (usually a path to a manifest), and 'importance' is
    one of `{'lowest', 'low', 'medium', 'high'}`.

    Each importance value has an associated 'count' as defined in
    `self.target_counts`. It guarantees that 'manifest' will run in at least
    'count' different configurations (assuming there are enough tasks
    containing 'manifest').

    On configurations that haven't been seen before, we'll increase the target
    count by `self.unseen_modifier` to increase the likelihood of scheduling a
    task on that configuration.

    Args:
        target_counts (dict): Override DEFAULT_TARGET_COUNTS with custom counts. This
            is a dict mapping the importance value ('lowest', 'low', etc) to the
            minimum number of configurations manifests with this value should run
            on.

        unseen_modifier (int): Override DEFAULT_UNSEEN_MODIFIER to a custom
            value. This is the amount we'll increase 'target_count' by for unseen
            configurations.
    """

    DEFAULT_TARGET_COUNTS = {
        "high": 3,
        "medium": 2,
        "low": 1,
        "lowest": 0,
    }
    DEFAULT_UNSEEN_MODIFIER = 1

    def __init__(self, target_counts=None, unseen_modifier=DEFAULT_UNSEEN_MODIFIER):
        self.target_counts = self.DEFAULT_TARGET_COUNTS.copy()
        if target_counts:
            self.target_counts.update(target_counts)
        self.unseen_modifier = unseen_modifier

        self.count = defaultdict(int)
        self.seen_configurations = set()

    def should_remove_task(self, task, params, importance):
        test_manifests = task.attributes.get("test_manifests")
        test_platform = task.attributes.get("test_platform")

        if not importance or not test_manifests or not test_platform:
            return False

        # Build the test configuration key.
        key = test_platform
        if variant := task.attributes.get("unittest_variant"):
            key += "-" + variant

        important_manifests = set(test_manifests) & set(importance)
        for manifest in important_manifests:
            target_count = self.target_counts[importance[manifest]]

            # If this configuration hasn't been seen before, increase the
            # likelihood of scheduling the task.
            if key not in self.seen_configurations:
                target_count += self.unseen_modifier

            if self.count[manifest] < target_count:
                # Update manifest counts and seen configurations.
                self.seen_configurations.add(key)
                for manifest in important_manifests:
                    self.count[manifest] += 1
                return False

        # Should remove task because all manifests have reached their
        # importance count (or there were no important manifests).
        return True
