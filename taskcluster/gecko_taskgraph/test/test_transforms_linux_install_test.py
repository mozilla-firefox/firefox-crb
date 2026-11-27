# Any copyright is dedicated to the Public Domain.
# https://creativecommons.org/publicdomain/zero/1.0/

from copy import deepcopy

import pytest
from mozunit import main
from taskgraph.task import Task

from gecko_taskgraph.transforms import linux_install_test
from gecko_taskgraph.transforms.linux_install_test import (
    build_run_command,
    expand_distros,
    run_jobs,
)

SOURCE_ARTIFACT_LABEL = "source-artifact-linux64"
KIND_DEPENDENCIES_TASKS = {
    SOURCE_ARTIFACT_LABEL: Task(
        kind="source-artifact",
        label=SOURCE_ARTIFACT_LABEL,
        attributes={},
        task={},
    )
}

INSTALL_TASK = {
    "name": "fedora-41-x64-rpm",
    "worker-type": "b-linux",
    "worker": {
        "docker-image": "fedora:41",
        "env": {"MOZ_FETCHES_DIR": "/builds/worker/fetches"},
    },
    "install-method": "rpm",
    "install-script-command": "sh $MOZ_FETCHES_DIR/install-firefox.sh",
    "pre-install": "dnf install -y curl",
    "run": {"using": "run-task", "run-as-root": True, "checkout": False},
    "dependencies": {"source-artifact": SOURCE_ARTIFACT_LABEL},
    "fetches": {
        "source-artifact": [{"artifact": "install-firefox.sh", "extract": False}]
    },
}


def test_expand_distros_upstream_image_for_all_arches(run_transform):
    task = {
        "name": "distros",
        "architectures": {
            "x64": {"worker-type": "b-linux", "platform": "linux64/opt"},
            "a64": {
                "worker-type": "b-linux-aarch64",
                "platform": "linux64-aarch64/opt",
            },
        },
        "distros": {
            "fedora-41": {
                "symbol": "f41",
                "docker-image": "fedora:41",
                "methods": ["rpm"],
            },
        },
    }
    tasks = list(run_transform(expand_distros, task))
    assert [(t["name"], t["worker"]["docker-image"]) for t in tasks] == [
        ("fedora-41-x64-rpm", "fedora:41"),
        ("fedora-41-a64-rpm", "fedora:41"),
    ]


def test_build_run_command_upstream_image_downloads_fetches(run_transform):
    (task,) = run_transform(
        build_run_command,
        deepcopy(INSTALL_TASK),
        kind_dependencies_tasks=KIND_DEPENDENCIES_TASKS,
    )
    assert "fetches" not in task
    assert task["worker"]["env"] == {
        "MOZ_FETCHES_DIR": "/builds/worker/fetches",
        "MOZ_FETCH_URL_0": {
            "artifact-reference": "<source-artifact/public/build/install-firefox.sh>"
        },
    }
    assert task["run"]["command"] == (
        "dnf install -y curl"
        ' && mkdir -p "$MOZ_FETCHES_DIR"'
        ' && (curl --retry 5 -fsSL -o "$MOZ_FETCHES_DIR/install-firefox.sh" "$MOZ_FETCH_URL_0"'
        ' || wget --tries=5 -qO "$MOZ_FETCHES_DIR/install-firefox.sh" "$MOZ_FETCH_URL_0")'
        " && sh $MOZ_FETCHES_DIR/install-firefox.sh"
        " --channel {matrix[channel]} --install-method rpm --lang {matrix[locale]}"
    )


def test_build_run_command_in_tree_image_keeps_fetches(run_transform):
    task = deepcopy(INSTALL_TASK)
    task["worker"]["docker-image"] = {"in-tree": "debian12-flatpak"}
    (task,) = run_transform(build_run_command, task)
    assert task["fetches"] == INSTALL_TASK["fetches"]
    assert task["worker"]["env"] == INSTALL_TASK["worker"]["env"]
    assert task["run"]["command"] == (
        "dnf install -y curl && sh $MOZ_FETCHES_DIR/install-firefox.sh"
        " --channel {matrix[channel]} --install-method rpm --lang {matrix[locale]}"
    )


def test_build_run_command_upstream_image_rejects_extracted_fetches(run_transform):
    task = deepcopy(INSTALL_TASK)
    task["fetches"]["source-artifact"][0]["extract"] = True
    with pytest.raises(ValueError, match="extract: false"):
        list(
            run_transform(
                build_run_command,
                task,
                kind_dependencies_tasks=KIND_DEPENDENCIES_TASKS,
            )
        )


def test_build_run_command_upstream_image_requires_fetches_dir(run_transform):
    task = deepcopy(INSTALL_TASK)
    del task["worker"]["env"]
    with pytest.raises(ValueError, match="MOZ_FETCHES_DIR"):
        list(
            run_transform(
                build_run_command,
                task,
                kind_dependencies_tasks=KIND_DEPENDENCIES_TASKS,
            )
        )


@pytest.fixture
def docker_worker(monkeypatch):
    monkeypatch.setattr(
        linux_install_test,
        "worker_type_implementation",
        lambda graph_config, params, worker_type: ("docker-worker", "linux"),
    )


def test_run_jobs_upstream_image_runs_command_with_sh(run_transform, docker_worker):
    task = {
        "name": "fedora-41-x64-rpm",
        "worker-type": "b-linux",
        "worker": {"docker-image": "fedora:41", "env": {"FOO": "bar"}},
        "run": {
            "using": "run-task",
            "run-as-root": True,
            "checkout": False,
            "command": "dnf install -y curl && sh install-firefox.sh",
        },
        "dependencies": {"source-artifact": SOURCE_ARTIFACT_LABEL},
    }
    (task,) = run_transform(run_jobs, task)
    assert task == {
        "label": "fake-kind-fedora-41-x64-rpm",
        "worker-type": "b-linux",
        "worker": {
            "implementation": "docker-worker",
            "os": "linux",
            "docker-image": "fedora:41",
            "env": {"FOO": "bar"},
            "command": ["sh", "-xc", "dnf install -y curl && sh install-firefox.sh"],
        },
        "dependencies": {"source-artifact": SOURCE_ARTIFACT_LABEL},
    }


@pytest.mark.parametrize(
    "run_override,match",
    (
        pytest.param({"checkout": True}, "checkout: false", id="checkout"),
        pytest.param({"run-as-root": False}, "run-as-root: true", id="not-root"),
    ),
)
def test_run_jobs_upstream_image_rejects_run_task_features(
    run_transform, docker_worker, run_override, match
):
    task = {
        "name": "fedora-41-x64-rpm",
        "worker-type": "b-linux",
        "worker": {"docker-image": "fedora:41"},
        "run": {
            "using": "run-task",
            "run-as-root": True,
            "checkout": False,
            "command": "true",
            **run_override,
        },
    }
    with pytest.raises(ValueError, match=match):
        list(run_transform(run_jobs, task))


if __name__ == "__main__":
    main()
