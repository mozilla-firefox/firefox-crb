# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

import sys
import textwrap
from pathlib import Path

import mozunit
import pytest
from packaging.version import Version

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import semver_check
from semver_check import Level, Metadata

BASE = """
def connect(host, port=80):
    return host, port
"""


def write_package(root, source, extra_files=None):
    files = {"pkg/__init__.py": source, **(extra_files or {})}
    for path, content in files.items():
        target = root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(textwrap.dedent(content))
    return root


def metadata(requires=(), python=None, scripts=None):
    return Metadata(
        top_level={"pkg"},
        requires_dist=list(requires),
        requires_python=python,
        entry_points={"console_scripts": scripts} if scripts else {},
    )


def compare(
    tmp_path,
    old_source=BASE,
    new_source=BASE,
    old="1.0.0",
    new="1.0.1",
    old_meta=None,
    new_meta=None,
    exceptions=(),
    old_files=None,
    new_files=None,
):
    old_dir = write_package(tmp_path / "old", old_source, old_files)
    new_dir = write_package(tmp_path / "new", new_source, new_files)
    return semver_check.compare(
        "pkg",
        Version(new),
        Version(old),
        old_dir,
        old_meta or metadata(),
        new_dir,
        new_meta or metadata(),
        exceptions,
    )


def kinds(result, level="any"):
    return {c.kind for c in result.changes if level in ("any", c.level)}


def test_no_changes(tmp_path):
    result = compare(tmp_path)
    assert result.changes == []
    assert result.required == Level.NONE
    assert result.ok


def test_removed_public_function(tmp_path):
    result = compare(tmp_path, new_source="")
    assert "OBJECT_REMOVED" in kinds(result, Level.MAJOR)
    assert result.required == Level.MAJOR
    assert not result.ok
    assert compare(tmp_path / "major", new_source="", new="2.0.0").ok


def test_added_required_parameter(tmp_path):
    new_source = """
    def connect(host, timeout, port=80):
        return host, port
    """
    result = compare(tmp_path, new_source=new_source, new="1.1.0")
    assert "PARAMETER_ADDED_REQUIRED" in kinds(result, Level.MAJOR)
    assert not result.ok


def test_added_optional_parameter(tmp_path):
    new_source = """
    def connect(host, port=80, timeout=None):
        return host, port
    """
    result = compare(tmp_path, new_source=new_source)
    assert kinds(result, Level.MINOR) == {"PARAMETER_ADDED_OPTIONAL"}
    assert result.required == Level.MINOR
    assert not result.ok
    assert compare(tmp_path / "minor", new_source=new_source, new="1.1.0").ok


def test_added_public_function(tmp_path):
    result = compare(tmp_path, new_source=BASE + "\ndef disconnect():\n    pass\n")
    assert "OBJECT_ADDED" in kinds(result, Level.MINOR)
    assert result.required == Level.MINOR


def test_internal_changes(tmp_path):
    new_source = """
    def connect(host, port=80):
        return _normalize(host), port

    def _normalize(host):
        return host.lower()
    """
    result = compare(tmp_path, new_source=new_source)
    assert kinds(result) == {"IMPLEMENTATION_CHANGED"}
    assert result.required == Level.PATCH
    assert result.ok


def test_names_not_in_all_are_private(tmp_path):
    old_source = '__all__ = ["connect"]\n' + BASE + "\ndef helper():\n    pass\n"
    new_source = '__all__ = ["connect"]\n' + BASE
    result = compare(tmp_path, old_source=old_source, new_source=new_source)
    assert result.required == Level.PATCH


def test_removed_object_base_class_is_ignored(tmp_path):
    result = compare(
        tmp_path,
        old_source="class Client(object):\n    pass\n",
        new_source="class Client:\n    pass\n",
    )
    assert "CLASS_REMOVED_BASE" not in kinds(result)
    assert result.ok


def test_changed_attribute_value_needs_review(tmp_path):
    result = compare(tmp_path, old_source="TIMEOUT = 10\n", new_source="TIMEOUT = 20\n")
    assert "ATTRIBUTE_CHANGED_VALUE" in kinds(result, None)
    assert result.required == Level.PATCH
    assert result.ok


@pytest.mark.parametrize(
    "old_python,new_python,level",
    [
        (">=3.8", ">=3.9", Level.MINOR),
        (None, ">=3.9", Level.MINOR),
        (">=3.9", ">=3.9,<3.14", Level.MINOR),
        (">=3.9", ">=3.8", Level.PATCH),
        (">=3.9", None, Level.PATCH),
    ],
)
def test_supported_python_versions(tmp_path, old_python, new_python, level):
    result = compare(
        tmp_path,
        old_meta=metadata(python=old_python),
        new_meta=metadata(python=new_python),
    )
    assert kinds(result) == {"PYTHON_REQUIRES_CHANGED"}
    assert result.required == level


@pytest.mark.parametrize(
    "old_requires,new_requires,kind,level",
    [
        ([], ["mozlog>=6.0"], "DEPENDENCY_ADDED", Level.MINOR),
        ([], ['pyyaml; extra == "yaml"'], "DEPENDENCY_ADDED", Level.MINOR),
        (["mozlog>=6.0"], [], "DEPENDENCY_REMOVED", Level.PATCH),
        (["mozlog>=6.0"], ["mozlog>=9.0"], "DEPENDENCY_CHANGED", Level.MINOR),
        (["mozlog"], ["mozlog<10"], "DEPENDENCY_CHANGED", Level.MINOR),
        (["mozlog>=9.0"], ["mozlog>=6.0"], "DEPENDENCY_CHANGED", Level.PATCH),
        (["mozlog>=6.0,<9"], ["mozlog>=6.0"], "DEPENDENCY_CHANGED", Level.PATCH),
        (["mozlog!=7.0"], ["mozlog!=8.0"], "DEPENDENCY_CHANGED", None),
        (
            ["pywin32"],
            ['pywin32; sys_platform == "win32"'],
            "DEPENDENCY_CHANGED",
            None,
        ),
    ],
)
def test_runtime_dependencies(tmp_path, old_requires, new_requires, kind, level):
    result = compare(
        tmp_path,
        old_meta=metadata(requires=old_requires),
        new_meta=metadata(requires=new_requires),
    )
    assert [(c.kind, c.level) for c in result.changes] == [(kind, level)]


def test_console_scripts(tmp_path):
    result = compare(
        tmp_path,
        old_meta=metadata(scripts={"old-tool": "pkg:main"}),
        new_meta=metadata(scripts={"new-tool": "pkg:main"}),
    )
    assert kinds(result, Level.MAJOR) == {"SCRIPT_REMOVED"}
    assert kinds(result, Level.MINOR) == {"SCRIPT_ADDED"}


def test_command_line_options(tmp_path):
    cli = """
    def parser(p):
        p.add_argument("--verbose", "-v", action="store_true")
        p.add_argument("--{}")
    """
    result = compare(
        tmp_path,
        old_files={"pkg/cli.py": cli.format("old")},
        new_files={"pkg/cli.py": cli.format("new")},
    )
    changes = {(c.kind, c.path, c.level) for c in result.changes}
    assert ("CLI_OPTION_REMOVED", "--old", None) in changes
    assert ("CLI_OPTION_ADDED", "--new", Level.MINOR) in changes


@pytest.mark.parametrize(
    "old,new,ok",
    [
        ("0.7.1", "0.7.2", False),
        ("0.7.1", "0.8.0", True),
        ("0.7.1", "1.0.0", True),
        ("1.0.0", "1.0.1rc1", False),
        ("1.0.0", "2.0.0.dev1", True),
        ("1.0.0", "2.0.0b2", True),
    ],
)
def test_breaking_change_version_policy(tmp_path, old, new, ok):
    result = compare(tmp_path, new_source="", old=old, new=new)
    assert result.required == Level.MAJOR
    assert result.ok is ok


def test_minor_change_in_zero_major_version(tmp_path):
    result = compare(
        tmp_path,
        new_source=BASE + "\ndef disconnect():\n    pass\n",
        old="0.7.1",
        new="0.7.2",
    )
    assert result.ok


@pytest.mark.parametrize(
    "old,level,expected",
    [
        ("1.2.3", Level.MAJOR, "2.0.0"),
        ("1.2.3", Level.MINOR, "1.3.0"),
        ("1.2.3", Level.PATCH, "1.2.4"),
        ("0.7.1", Level.MAJOR, "0.8.0"),
        ("0.7.1", Level.MINOR, "0.7.2"),
        ("0.2", Level.PATCH, "0.2.1"),
    ],
)
def test_next_version(old, level, expected):
    assert semver_check.next_version(Version(old), level) == expected


@pytest.mark.parametrize("new", ["1.0.0", "0.9.0", "1.0.0.post1"])
def test_version_that_is_no_bump(tmp_path, new):
    result = compare(tmp_path, new=new)
    assert result.error
    assert not result.ok


def test_insufficient_bump_message(tmp_path):
    output = semver_check.format_result(compare(tmp_path, new_source=""))
    assert "pkg 1.0.1: FAIL" in output
    assert "Previous release: 1.0.0" in output
    assert "Minimum required bump: major (next version: 2.0.0)" in output
    assert "only a patch bump" in output
    assert "[OBJECT_REMOVED] pkg.connect" in output


def test_exception_ignores_matching_change(tmp_path):
    exception = {
        "package": "pkg",
        "version": "1.0.1",
        "kind": "OBJECT_REMOVED",
        "path": "pkg.*",
        "reason": "Not used anywhere",
    }
    result = compare(tmp_path, new_source="", exceptions=[exception])
    assert result.ok
    assert [(c.kind, reason) for c, reason in result.ignored] == [
        ("OBJECT_REMOVED", "Not used anywhere")
    ]
    assert "Not used anywhere" in semver_check.format_result(result)


def test_exception_only_applies_to_its_version(tmp_path):
    exception = {"package": "pkg", "version": "1.0.2", "reason": "Not used anywhere"}
    result = compare(tmp_path, new_source="", exceptions=[exception])
    assert not result.ok


def test_exception_requires_reason(tmp_path):
    path = tmp_path / "exceptions.toml"
    path.write_text('[[exception]]\npackage = "pkg"\nversion = "1.0.1"\nreason = ""\n')
    with pytest.raises(ValueError):
        semver_check.load_exceptions(path)


def test_default_exceptions_file_is_valid():
    semver_check.load_exceptions()


def release(yanked=False):
    return [{"packagetype": "sdist", "yanked": yanked}]


def test_find_baseline():
    project = {
        "releases": {
            "0.9.0": release(),
            "1.0.0": release(),
            "1.1.0": release(yanked=True),
            "1.2.0rc1": release(),
            "1.3.0": [],
            "2.0.0": release(),
        }
    }
    assert semver_check.find_baseline(project, Version("1.5.0")) == "1.0.0"
    assert semver_check.find_baseline(project, Version("0.9.0")) is None


@pytest.mark.parametrize(
    "project",
    [
        None,
        {"releases": {}},
        {"releases": {"1.0.0b1": release(), "0.1": release(yanked=True)}},
    ],
)
def test_initial_release(tmp_path, project):
    meta = {"name": "pkg", "version": "1.0.0"}
    result = semver_check.check_package(tmp_path, project, metadata=meta)
    assert result.ok
    assert "initial release" in result.note


def test_read_setup_metadata(tmp_path):
    write_package(tmp_path, "", {"pkg/sub/__init__.py": "", "tests/__init__.py": ""})
    (tmp_path / "setup.py").write_text(
        textwrap.dedent(
            """
            from setuptools import find_packages, setup

            DEPS = ["mozlog >= 6.0"]

            setup(
                name="pkg",
                version="1.2.0",
                packages=find_packages(exclude=["tests"]),
                install_requires=DEPS,
                extras_require={"yaml": ["pyyaml"]},
                python_requires=">=3.9",
                entry_points='''
                    [console_scripts]
                    pkg = pkg:main
                ''',
            )
            """
        )
    )
    setup = semver_check.read_setup_metadata(tmp_path)
    assert setup["packages"] == ["pkg", "pkg.sub"]
    meta = semver_check.metadata_from_setup(setup)
    assert meta.top_level == {"pkg"}
    assert meta.requires_dist == ["mozlog >= 6.0", 'pyyaml; extra == "yaml"']
    assert meta.requires_python == ">=3.9"
    assert meta.entry_points == {"console_scripts": {"pkg": "pkg:main"}}


if __name__ == "__main__":
    mozunit.main()
