# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.


import configparser
import json
import logging
import re
import time
from datetime import datetime, timezone
from functools import partial
from pathlib import Path

import requests
from taskcluster.exceptions import TaskclusterRestFailure
from taskgraph.util.taskcluster import (
    get_artifact,
    get_artifact_url,
    get_task_definition,
    list_artifacts,
    status_task,
)
from taskgraph.util.treeherder import join_symbol, split_symbol

from .. import GECKO
from ..util.perftest import use_raptor_ab_script
from ..util.taskgraph import find_decision_task
from .registry import register_callback_action
from .util import create_tasks, fetch_graph_and_labels, read_artifact, write_artifact

logger = logging.getLogger(__name__)

# What the native profilers look for in MOZ_FETCHES_DIR, on every platform.
SYMBOLS_ARTIFACT_NAME = "target.crashreporter-symbols.zip"

ARTIFACT_REFERENCE = re.compile(r"^<([^/>]+)/(.+)>$")
TASK_REFERENCE = re.compile(r"^<([^/>]+)>$")
FULL_REVISION = re.compile(r"^[0-9a-f]{40}$")
SCHEDULER_ID = re.compile(r"^(.+)-level-(\d+)$")

# How long the decision task waits for the base push to land and for its
# decision task to finish. Every task of the push waits for the decision task.
BASE_PUSH_TIMEOUT = 10 * 60
BASE_PUSH_POLL_INTERVAL = 30
# How much of the decision task's maxRunTime to leave for the work after the
# wait, so that the decision task is never killed while it waits.
DECISION_TASK_MARGIN = 5 * 60


def build_references(task):
    """Where the task gets the build under test and its symbols from.

    Both are task-references in the task's own definition, so reading them
    avoids hardcoding artifact paths that differ per platform: target.zip on
    Windows, target.tar.xz on Linux, target.dmg on macOS.

    Returns the name of the dependency that provides them, the installer's
    artifact path and the symbols' artifact path.
    """
    env = task.task["payload"]["env"]

    extra_config = json.loads(env["EXTRA_MOZHARNESS_CONFIG"]["artifact-reference"])
    match = ARTIFACT_REFERENCE.match(extra_config["installer_url"])
    if not match:
        raise Exception(
            f"Cannot tell which task provides {task.label}'s installer: "
            f"{extra_config['installer_url']!r}. This action needs the installer "
            "to come from a task in this push."
        )
    installer_upstream, installer_artifact = match.groups()

    fetches = json.loads(env["MOZ_FETCHES"]["task-reference"])
    symbols = [f for f in fetches if f["artifact"].endswith(SYMBOLS_ARTIFACT_NAME)]
    if not symbols:
        raise Exception(
            f"{task.label} does not fetch {SYMBOLS_ARTIFACT_NAME}, so its profiles "
            "would not be symbolicated."
        )
    match = TASK_REFERENCE.match(symbols[0]["task"])
    if not match:
        raise Exception(
            f"Cannot tell which task provides {task.label}'s symbols: "
            f"{symbols[0]['task']!r}."
        )
    symbols_upstream = match.group(1)

    if installer_upstream != symbols_upstream:
        raise Exception(
            f"{task.label} takes its installer from {installer_upstream} but its "
            f"symbols from {symbols_upstream}. This action assumes one task "
            "provides both, which holds on desktop but not on Android."
        )

    return installer_upstream, installer_artifact, symbols[0]["artifact"]


def base_build_resolver(input, graph_config):
    """Return a function that maps a build label to the base build's task id."""
    if input["base_build_task_id"]:
        return lambda build_label: input["base_build_task_id"]

    base_project = input["base_project"]
    base_revision = input["base_revision"]
    if not FULL_REVISION.match(base_revision):
        raise Exception(
            f"The base revision {base_revision!r} is not a full 40-character "
            "revision hash."
        )
    head_rev_param = "{}head_rev".format(graph_config["project-repo-param-prefix"])
    base_parameters = {"project": base_project, head_rev_param: base_revision}
    try:
        decision_task_id = find_decision_task(base_parameters, graph_config)
        label_to_taskid = get_artifact(decision_task_id, "public/label-to-taskid.json")
    except TaskclusterRestFailure as e:
        raise Exception(
            f"Could not find a decision task for revision {base_revision} "
            f"on {base_project}. Check the revision and the project, and wait "
            "for the base push's decision task to finish."
        ) from e

    def resolve(build_label):
        if build_label not in label_to_taskid:
            raise Exception(
                f"The decision task for revision {base_revision} on "
                f"{base_project} has no {build_label} task. If an action task "
                "added the base build, pass its task id as the base build task "
                "id instead."
            )
        return label_to_taskid[build_label]

    return resolve


def require_trust_level(task_id, parameters, graph_config):
    """Refuse a base build from a less trusted tree than this push's.

    This task runs the base build, so a try build must not run on autoland.
    The reverse, try comparing against an autoland build, is fine.
    """
    scheduler_id = get_task_definition(task_id).get("schedulerId", "")
    match = SCHEDULER_ID.match(scheduler_id)
    level = int(parameters["level"])
    if (
        not match
        or match.group(1) != graph_config["trust-domain"]
        or int(match.group(2)) < level
    ):
        raise Exception(
            f"The base build ({task_id}) was scheduled by {scheduler_id!r}, but "
            f"this push is level {level}. The base build has to come from a "
            "tree with the same or a higher trust level."
        )


def require_artifacts(task_id, artifacts):
    """Check now that the build's artifacts still exist.

    The task fetches the base build by URL, so otherwise it would only notice
    when it downloads them, which can be after a whole run.
    """
    available = {artifact["name"] for artifact in list_artifacts(task_id)}
    missing = sorted(set(artifacts) - available)
    if missing:
        raise Exception(
            f"The base build ({task_id}) has no {', '.join(missing)}. "
            "The artifacts may have expired, in which case the build has to be "
            "pushed again."
        )


def require_usable_build(task_id, description):
    """Refuse a build that has failed, and return its state.

    A build that is still pending or running is fine: the AB task depends on
    it and only starts once it completes.
    """
    try:
        status = status_task(task_id)
    except TaskclusterRestFailure as e:
        raise Exception(
            f"Could not find the {description} build task {task_id}."
        ) from e
    if not status:
        # `mach taskgraph test-action-callback` doesn't talk to the queue.
        return None
    state = status.get("state")
    if state in ("failed", "exception"):
        raise Exception(
            f"The {description} build ({task_id}) is {state}. Rerun it, then "
            "trigger this action again."
        )
    return state


def check_base_build(task_id, artifacts, parameters, graph_config):
    """Refuse a base build that the AB task could never use."""
    state = require_usable_build(task_id, "base")
    require_trust_level(task_id, parameters, graph_config)
    if state == "completed":
        require_artifacts(task_id, artifacts)


def ab_profiles_modifier(task, configs):
    """Turn a profiling task into a two-run task."""
    if task.label not in configs:
        return task
    config = configs[task.label]["config"]

    # The base build belongs to another push, so the task graph cannot express
    # this dependency. The optimizer adds the in-graph dependencies to this list
    # rather than replacing it. When a build is compared against itself, the
    # in-graph dependency already covers it, and the queue rejects duplicates.
    base_build_task_id = configs[task.label]["base_build_task_id"]
    if base_build_task_id != configs[task.label]["new_build_task_id"]:
        task.task.setdefault("dependencies", []).append(base_build_task_id)

    payload = task.task["payload"]
    payload["env"]["RAPTOR_AB_CONFIG"] = json.dumps(config)
    payload["command"] = use_raptor_ab_script(payload["command"])

    # These tasks run the test twice, so they take about twice as long.
    payload["maxRunTime"] *= 2

    task.task["metadata"]["name"] += "-ab"
    treeherder = task.task["extra"]["treeherder"]
    group, symbol = split_symbol(treeherder["symbol"])
    treeherder["symbol"] = join_symbol(group, f"{symbol.removesuffix('-p')}-ab")

    # A retrigger has to copy this task's definition, because recreating the
    # task from the task graph would lose its AB command and configuration. The
    # "action" tag selects the retrigger action that copies the definition; the
    # "retrigger" tag would select the one that recreates the task.
    tags = task.task.setdefault("tags", {})
    tags.pop("retrigger", None)
    tags["action"] = "ab-profiles-task"

    description = task.task["metadata"]["description"]
    prefix = (
        f"AB profiles, base: {config['runs']['base']['description']}, "
        f"new: {config['runs']['new']['description']}, "
        f"run order: {','.join(config['order'])}. "
    )
    if isinstance(description, dict) and "task-reference" in description:
        description["task-reference"] = prefix + description["task-reference"]
    else:
        task.task["metadata"]["description"] = prefix + description

    return task


def normalize_input(input):
    # Treeherder fills the schema's defaults in for us, but a caller going
    # straight at the hook doesn't have to, so don't rely on them being there.
    input = {
        "base_revision": "",
        "base_project": "try",
        "base_build_task_id": "",
        "order": "base,new",
        **(input or {}),
    }
    if not input["base_revision"] and not input["base_build_task_id"]:
        raise Exception("Either a base revision or a base build task id is required.")
    return input


def schedule_ab_profiles(parameters, graph_config, input, labels):
    decision_task_id, full_task_graph, label_to_taskid, _ = fetch_graph_and_labels(
        parameters, graph_config
    )
    create_ab_tasks(
        parameters,
        graph_config,
        input,
        labels,
        decision_task_id,
        full_task_graph,
        label_to_taskid,
    )


def create_ab_tasks(
    parameters,
    graph_config,
    input,
    labels,
    decision_task_id,
    full_task_graph,
    label_to_taskid,
    suffix="",
):
    """Create an AB task for each of the given profiling task labels.

    The new build is this push's build, which is scheduled too if the push
    doesn't have it yet. Neither build has to be finished: the AB task depends
    on both and only starts once they complete.
    """
    builds = {}
    for label in dict.fromkeys(labels):
        task = full_task_graph.tasks.get(label)
        if not task or not task.attributes.get("supports_ab_profiles"):
            supported = sorted(
                l
                for l, t in full_task_graph.tasks.items()
                if t.attributes.get("supports_ab_profiles")
            )
            raise Exception(
                f"{label} does not support AB profiles. Select a Speedometer "
                "native profiling task instead. These tasks support AB "
                f"profiles: {', '.join(supported)}"
            )
        upstream, installer_artifact, symbols_artifact = build_references(task)
        if task.dependencies[upstream] in label_to_taskid:
            require_usable_build(label_to_taskid[task.dependencies[upstream]], "new")
        builds[label] = (
            task.dependencies[upstream],
            installer_artifact,
            symbols_artifact,
        )

    build_labels = sorted({build_label for build_label, _, _ in builds.values()})
    if input["base_build_task_id"] and len(build_labels) > 1:
        raise Exception(
            "A base build task id stands in for a single build, but the "
            f"selected tasks test {', '.join(build_labels)}. Select tasks that "
            "test one build, or give a base revision instead."
        )

    resolve_base_build = base_build_resolver(input, graph_config)
    if input["base_build_task_id"]:
        base_description = f"task {input['base_build_task_id']}"
    else:
        base_description = f"{input['base_revision'][:12]} ({input['base_project']})"
    new_run = {
        "browser": "firefox",
        "description": f"{parameters['head_rev'][:12]} ({parameters['project']})",
    }

    configs = {}
    checked = set()
    for label, (build_label, installer_artifact, symbols_artifact) in builds.items():
        base_build_task_id = resolve_base_build(build_label)
        if base_build_task_id not in checked:
            check_base_build(
                base_build_task_id,
                [installer_artifact, symbols_artifact],
                parameters,
                graph_config,
            )
            checked.add(base_build_task_id)
        base_run = {
            "browser": "firefox",
            "description": base_description,
            "installer_url": get_artifact_url(base_build_task_id, installer_artifact),
            "symbols_url": get_artifact_url(base_build_task_id, symbols_artifact),
        }
        configs[label] = {
            "base_build_task_id": base_build_task_id,
            "new_build_task_id": label_to_taskid.get(build_label),
            "config": {
                "order": input["order"].split(","),
                "runs": {"base": base_run, "new": new_run},
            },
        }
        logger.info(f"Creating {label} with {configs[label]}")

    create_tasks(
        graph_config,
        list(configs),
        full_task_graph,
        label_to_taskid,
        parameters,
        decision_task_id,
        suffix=suffix,
        modifier=partial(ab_profiles_modifier, configs=configs),
    )


def lando_api_domain(instance_id):
    """Look up a Lando instance's API domain in the in-tree .lando.ini."""
    parser = configparser.ConfigParser()
    parser.read(Path(GECKO, ".lando.ini"))
    for section in parser.sections():
        if parser[section].get("instance_id", section) == instance_id:
            return parser[section]["api_domain"]
    raise Exception(f"Unknown Lando instance {instance_id!r}.")


def landed_revision(domain, job_id):
    """Return the revision a Lando landing job landed, or None until it has."""
    try:
        response = requests.get(f"https://{domain}/landing_jobs/{job_id}/", timeout=60)
    except requests.RequestException as e:
        logger.warning(f"Could not reach Lando, trying again: {e}")
        return None
    if response.status_code >= 500:
        logger.warning(f"Lando returned {response.status_code}, trying again.")
        return None
    response.raise_for_status()
    job = response.json()
    if job["status"] == "LANDED":
        return job["commit_id"]
    if job["status"] in ("FAILED", "CANCELLED"):
        raise Exception(
            f"Lando landing job {job_id} is {job['status']}: {job.get('error')}"
        )
    return None


def finished_decision_task(graph_config, project, revision):
    """Return the push's decision task id, or None until that task has finished.

    The index only lists a decision task once it has completed.
    """
    head_rev_param = "{}head_rev".format(graph_config["project-repo-param-prefix"])
    try:
        return find_decision_task(
            {"project": project, head_rev_param: revision}, graph_config
        )
    except TaskclusterRestFailure as e:
        if e.status_code == 404:
            return None
        if e.status_code and e.status_code >= 500:
            logger.warning(f"Could not query the index, trying again: {e}")
            return None
        raise


def wait_deadline(decision_task_id):
    """Return when to stop waiting for the base push, as a time.monotonic() value.

    That is BASE_PUSH_TIMEOUT from now, or earlier if the decision task would
    otherwise get too close to its maxRunTime.
    """
    deadline = time.monotonic() + BASE_PUSH_TIMEOUT
    status = status_task(decision_task_id)
    runs = (status or {}).get("runs")
    if not runs or not runs[-1].get("started"):
        # `mach taskgraph` runs this outside of a task.
        return deadline
    started = datetime.fromisoformat(runs[-1]["started"].replace("Z", "+00:00"))
    elapsed = (datetime.now(timezone.utc) - started).total_seconds()
    max_run_time = get_task_definition(decision_task_id)["payload"]["maxRunTime"]
    remaining = max_run_time - elapsed - DECISION_TASK_MARGIN
    return min(deadline, time.monotonic() + remaining)


def wait_for(deadline, description, poll):
    while True:
        result = poll()
        if result is not None:
            return result
        if time.monotonic() >= deadline:
            raise Exception(f"Timed out waiting for {description}.")
        logger.info(f"Waiting for {description}.")
        time.sleep(BASE_PUSH_POLL_INTERVAL)


def create_ab_tasks_from_try_config(
    parameters, graph_config, decision_task_id, full_task_graph, label_to_taskid
):
    """Create the AB tasks that try_task_config's "ab" asks for.

    `mach try perf --ab` pushes the base revision first and passes its
    Lando landing job id. The base push's decision task usually finishes at about
    the same time as this one, so this waits for it for a while.
    """
    config = parameters["try_task_config"]["ab"]
    base_project = config.get("base-project", "try")
    base_revision = config.get("base-revision")
    if not base_revision and not (
        config.get("base-lando-instance") and config.get("base-lando-job-id")
    ):
        raise Exception(
            'try_task_config\'s "ab" needs either "base-revision", or both '
            '"base-lando-instance" and "base-lando-job-id".'
        )
    deadline = wait_deadline(decision_task_id)
    if not base_revision:
        domain = lando_api_domain(config["base-lando-instance"])
        job_id = config["base-lando-job-id"]
        base_revision = wait_for(
            deadline,
            f"Lando landing job {job_id} of the base push",
            partial(landed_revision, domain, job_id),
        )
    wait_for(
        deadline,
        f"the decision task of the base push {base_revision}",
        partial(finished_decision_task, graph_config, base_project, base_revision),
    )

    input = normalize_input({
        "base_revision": base_revision,
        "base_project": base_project,
        "order": config.get("order", "base,new"),
    })
    create_ab_tasks(
        parameters,
        graph_config,
        input,
        config["tasks"],
        decision_task_id,
        full_task_graph,
        label_to_taskid,
        suffix="ab",
    )

    # Actions and Chain of Trust read the decision task's task-graph.json and
    # label-to-taskid.json, so these have to list the new tasks too.
    for name in ("task-graph", "label-to-taskid"):
        merged = read_artifact(f"{name}.json")
        merged.update(read_artifact(f"{name}-ab.json"))
        write_artifact(f"{name}.json", merged)


BASE_BUILD_SCHEMA_PROPERTIES = {
    "base_revision": {
        "type": "string",
        "default": "",
        "title": "Base revision",
        "description": (
            "Full 40-character revision of the push whose build should be "
            "compared against this one. Ignored if a base build task id is given."
        ),
    },
    "base_project": {
        "type": "string",
        "default": "try",
        "title": "Base project",
        "description": "Project (branch) the base revision was pushed to.",
    },
    "base_build_task_id": {
        "type": "string",
        "default": "",
        "title": "Base build task id",
        "description": (
            "Task id of the build to compare against. Overrides the base "
            "revision, for cases where the build cannot be looked up from a push "
            "(a build from an action task on another repository, say)."
        ),
    },
    "order": {
        "type": "string",
        "enum": ["base,new", "new,base"],
        "default": "base,new",
        "title": "Run order",
        "description": (
            "Which side to run first. The machine is warmer for the second run, "
            "so triggering the action twice with both orders and comparing the "
            "pairs separates that effect out."
        ),
    },
}

AB_PROFILES_DESCRIPTION = (
    "Run a Speedometer profiling task for two Firefox builds in one task on "
    "the same machine, so that machine differences affect the comparison less. "
    "The builds don't have to be finished: the task waits for both. The base "
    "push's decision task has to be finished, though. The base build must come "
    "from a tree with the same or a higher trust level, so try can compare "
    "against autoland but not the other way around."
)


@register_callback_action(
    title="AB profiles",
    name="ab-profiles",
    symbol="ab-prof",
    description=AB_PROFILES_DESCRIPTION,
    order=210,
    context=[{"test-type": "raptor"}],
    schema={
        "type": "object",
        "properties": BASE_BUILD_SCHEMA_PROPERTIES,
        "additionalProperties": False,
    },
)
def ab_profiles_action(parameters, graph_config, input, task_group_id, task_id):
    input = normalize_input(input)
    label = get_task_definition(task_id)["metadata"]["name"]
    schedule_ab_profiles(parameters, graph_config, input, [label])


@register_callback_action(
    title="AB profiles",
    name="ab-profiles-push",
    symbol="ab-prof",
    description=(
        AB_PROFILES_DESCRIPTION
        + " This push doesn't need the profiling tasks or the Firefox build: "
        "the action schedules the build if the push doesn't have it."
    ),
    order=211,
    context=[],
    schema={
        "type": "object",
        "properties": {
            "tasks": {
                "type": "array",
                "items": {"type": "string"},
                "minItems": 1,
                "title": "Profiling tasks",
                "description": (
                    "Labels of the Speedometer native profiling tasks to run "
                    "for both builds, for example "
                    "test-windows11-64-24h2-shippable/opt-browsertime-benchmark"
                    "-firefox-speedometer3-native-profiling."
                ),
            },
            **BASE_BUILD_SCHEMA_PROPERTIES,
        },
        "required": ["tasks"],
        "additionalProperties": False,
    },
)
def ab_profiles_push_action(parameters, graph_config, input, task_group_id, task_id):
    input = normalize_input(input)
    if not input.get("tasks"):
        raise Exception("Select at least one profiling task.")
    schedule_ab_profiles(parameters, graph_config, input, input["tasks"])
