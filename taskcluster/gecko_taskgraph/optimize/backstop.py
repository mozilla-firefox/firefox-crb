# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.


from taskgraph.optimize.base import OptimizationStrategy, register_strategy

from gecko_taskgraph.util.backstop import is_expanded


@register_strategy("skip-unless-android-perftest-backstop")
class SkipUnlessAndroidPerftestBackstop(OptimizationStrategy):
    """Always removes tasks except on backstop pushes."""

    def should_remove_task(self, task, params, _):
        return not params["android_perftest_backstop"]


@register_strategy("skip-unless-backstop")
class SkipUnlessBackstop(OptimizationStrategy):
    """Always removes tasks except on backstop pushes."""

    def should_remove_task(self, task, params, _):
        return not params["backstop"]


@register_strategy("skip-unless-push-interval-5", args=(5,))
class SkipUnlessPushInterval(OptimizationStrategy):
    """Always removes tasks except every N pushes.

    Args:
        push_interval (int): Number of pushes
    """

    def __init__(self, push_interval, remove_on_projects=None):
        self.push_interval = push_interval

    @property
    def description(self):
        return f"skip-unless-push-interval-{self.push_interval}"

    def should_remove_task(self, task, params, _):
        # On every Nth push, want to run all tasks.
        return int(params["pushlog_id"]) % self.push_interval != 0


@register_strategy("skip-unless-expanded")
class SkipUnlessExpanded(OptimizationStrategy):
    """Always removes tasks except on "expanded" pushes, currently defined as
    pushes at half the backstop interval, and on backstop pushes."""

    def should_remove_task(self, task, params, _):
        return not (params["backstop"] or is_expanded(params))
