# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

from taskgraph.transforms.base import TransformSequence
from taskgraph.util.dependencies import get_primary_dependency

zucchini_transforms = TransformSequence()
partials_transforms = TransformSequence()
partials_zucchini_transforms = TransformSequence()


# TODO: once ESR moves over, remove the legacy "partials" kind and this transform.
def uses_legacy_partials(params):
    """Whether the legacy "partials" implementation should be used.

    This is the case for ESR release types, including those of future ESR
    branches. Everything else uses the "partials-zucchini" implementation.
    Moving ESR to zucchini partials requires changing this check explicitly.
    """
    return params["release_type"].startswith("esr")


@partials_transforms.add
def filter_legacy_partials_by_project(config, tasks):
    """Only generate legacy "partials" tasks on legacy release channels.

    partials-zucchini is used on every other project, so on non-legacy projects
    we skip generating the legacy "partials" tasks entirely. This is the inverse
    of the filtering applied by the zucchini_transforms below.
    """
    if not uses_legacy_partials(config.params):
        return
    yield from tasks


@partials_zucchini_transforms.add
def filter_zucchini_partials_by_project(config, tasks):
    """Only generate "partials-zucchini" tasks on non-legacy release channels.

    This is the inverse of filter_legacy_partials_by_project.
    """
    if uses_legacy_partials(config.params):
        return
    yield from tasks


@zucchini_transforms.add
def filter_partials_by_project(config, tasks):
    """Control the rollout of partials-zucchini across release channels.

    This transform manages the gradual transition from the legacy "partials" implementation
    to the new "partials-zucchini" implementation. It ensures that partials-zucchini is
    used everywhere except where uses_legacy_partials is true.

    The transform filters tasks based on their primary dependency (partials or partials-zucchini)
    and the current project/channel, ensuring the appropriate implementation is used for each
    release channel.
    """
    for task in tasks:
        primary_dep = get_primary_dependency(config, task)
        assert primary_dep

        if primary_dep.kind not in (
            "partials",
            "partials-zucchini",
            "partials-zucchini-l10n",
        ):
            yield task
            continue

        if primary_dep.kind == "partials" and not uses_legacy_partials(config.params):
            continue

        if primary_dep.kind in (
            "partials-zucchini",
            "partials-zucchini-l10n",
        ) and uses_legacy_partials(config.params):
            continue

        yield task
