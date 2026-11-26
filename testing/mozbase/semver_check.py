#!/usr/bin/env python3

# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this file,
# You can obtain one at http://mozilla.org/MPL/2.0/.

"""
Check that unreleased mozbase package versions are bumped according to SemVer.

Each package whose in-tree version is not on PyPI yet is compared against its
latest stable release on PyPI, and the version bump has to be at least as large
as the changes require:

- major: removed or incompatibly changed public API (removed modules, classes,
  functions, methods or attributes, removed or moved parameters, new required
  parameters), removed console scripts.
- minor: new public API (modules, classes, functions, methods, attributes,
  optional parameters, console scripts, command line options), new runtime
  dependencies, raised minimum versions of dependencies, raised minimum
  Python version, new or lowered upper bounds.
- patch: any other change to the package's Python files or relaxed
  requirements.

Changes that can't be classified reliably by static analysis, like changed
default values, changed type annotations or removed command line options, are
listed for manual review and don't count towards the required bump.

Policy for special versions:

- 0.x versions follow the Cargo convention: bumping 0.y covers breaking
  changes, and bumping 0.y.z covers everything else.
- Pre-releases and development versions are judged by their base release,
  and only stable releases are used as the baseline.
- Without an earlier stable release on PyPI the package counts as an initial
  release and passes.

False positives can be ignored via semver-exceptions.toml.
"""

from __future__ import annotations

import argparse
import configparser
import enum
import fnmatch
import json
import logging
import re
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.request
import warnings
import zipfile
from dataclasses import dataclass, field
from pathlib import Path

import griffe
from packaging.requirements import Requirement
from packaging.specifiers import SpecifierSet
from packaging.utils import canonicalize_name
from packaging.version import InvalidVersion, Version

try:
    import tomllib
except ImportError:
    import tomli as tomllib

HERE = Path(__file__).resolve().parent
EXCEPTIONS_FILE = HERE / "semver-exceptions.toml"
ENTRY_POINT_GROUPS = ("console_scripts", "gui_scripts")

logging.getLogger("griffe").setLevel(logging.ERROR)
# Older releases contain invalid escape sequences that warn when parsed.
warnings.filterwarnings("ignore", category=SyntaxWarning)

# Reads the metadata that a setup.py passes to setup() by stubbing setuptools.
METADATA_SCRIPT = """
import fnmatch, json, os, runpy, sys, types

def find_packages(where=".", exclude=(), include=("*",)):
    packages = []
    for root, dirs, files in os.walk(where):
        dirs[:] = [d for d in dirs if not d.startswith(".") and d != "__pycache__"]
        if root != where and "__init__.py" in files:
            name = os.path.relpath(root, where).replace(os.sep, ".")
            if any(fnmatch.fnmatch(name, p) for p in include) and not any(
                fnmatch.fnmatch(name, p) for p in exclude
            ):
                packages.append(name)
    return sorted(packages)

captured = {}
stub = types.ModuleType("setuptools")
stub.setup = lambda **kwargs: captured.update(kwargs)
stub.find_packages = find_packages
sys.modules["setuptools"] = stub
sys.argv = ["setup.py"]
runpy.run_path("setup.py", run_name="__main__")
print(json.dumps({
    "name": captured["name"],
    "version": captured["version"],
    "packages": list(captured.get("packages") or []),
    "py_modules": list(captured.get("py_modules") or []),
    "install_requires": list(captured.get("install_requires") or []),
    "extras_require": dict(captured.get("extras_require") or {}),
    "python_requires": captured.get("python_requires"),
    "entry_points": captured.get("entry_points") or {},
}))
"""


class Level(enum.IntEnum):
    NONE = 0
    PATCH = 1
    MINOR = 2
    MAJOR = 3

    def __str__(self):
        return self.name.lower()


# Griffe breakages that are reliably incompatible. All others need a review.
MAJOR_BREAKAGES = {
    "OBJECT_REMOVED",
    "OBJECT_CHANGED_KIND",
    "PARAMETER_MOVED",
    "PARAMETER_REMOVED",
    "PARAMETER_CHANGED_KIND",
    "PARAMETER_CHANGED_REQUIRED",
    "PARAMETER_ADDED_REQUIRED",
    "CLASS_REMOVED_BASE",
}


@dataclass
class Change:
    """A difference between two releases.

    `level` is None for changes that need a manual review.
    """

    level: Level | None
    kind: str
    path: str
    message: str


@dataclass
class Metadata:
    """The compatibility relevant metadata of a release."""

    top_level: set[str]
    requires_dist: list[str]
    requires_python: str | None
    entry_points: dict[str, dict[str, str]] = field(default_factory=dict)


@dataclass
class Result:
    name: str
    proposed: Version
    previous: Version | None = None
    changes: list[Change] = field(default_factory=list)
    ignored: list[tuple[Change, str]] = field(default_factory=list)
    error: str | None = None
    note: str | None = None

    @property
    def required(self):
        return max(
            (c.level for c in self.changes if c.level is not None),
            default=Level.NONE,
        )

    @property
    def bump(self):
        return bump_level(self.previous, self.proposed) if self.previous else None

    @property
    def ok(self):
        if self.error:
            return False
        if self.previous is None:
            return True
        return self.bump is not None and self.bump >= self.required


def fetch(url, retries=3):
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(url, timeout=60) as response:
                return response.read()
        except urllib.error.HTTPError:
            raise
        except urllib.error.URLError:
            if attempt == retries - 1:
                raise
            time.sleep(5)
    return None


def fetch_project(name):
    """Returns the PyPI JSON data of a project, or None if it doesn't exist."""
    try:
        return json.loads(fetch(f"https://pypi.org/pypi/{name}/json"))
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise


def read_setup_metadata(source_dir):
    """Returns the arguments that the package's setup.py passes to setup()."""
    output = subprocess.run(
        [sys.executable, "-c", METADATA_SCRIPT],
        cwd=source_dir,
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    return json.loads(output.strip().splitlines()[-1])


def parse_entry_points(entry_points):
    if isinstance(entry_points, str):
        parser = configparser.ConfigParser(delimiters=("=",))
        parser.optionxform = str
        parser.read_string(entry_points)
        entry_points = {
            group: [f"{k} = {v}" for k, v in parser.items(group)]
            for group in parser.sections()
        }
    result = {}
    for group in ENTRY_POINT_GROUPS:
        lines = entry_points.get(group) or []
        if isinstance(lines, str):
            lines = lines.splitlines()
        for line in lines:
            if "=" in line:
                name, target = line.split("=", 1)
                result.setdefault(group, {})[name.strip()] = target.strip()
    return result


def metadata_from_setup(metadata):
    requires = list(metadata["install_requires"])
    for extra, requirements in metadata["extras_require"].items():
        for requirement in requirements:
            parsed = Requirement(requirement)
            marker = f'extra == "{extra}"'
            if parsed.marker:
                marker = f"({parsed.marker}) and {marker}"
            parsed.marker = None
            requires.append(f"{parsed}; {marker}")
    top_level = {p.split(".")[0] for p in metadata["packages"]}
    top_level |= set(metadata["py_modules"])
    return Metadata(
        top_level=top_level,
        requires_dist=requires,
        requires_python=metadata["python_requires"] or None,
        entry_points=parse_entry_points(metadata["entry_points"]),
    )


def bump_level(old, new):
    """Returns the level of the bump from old to new, or None if it's no bump."""
    o = (old.release + (0, 0, 0))[:3]
    n = (new.release + (0, 0, 0))[:3]
    if n <= o:
        return None
    if o[0] == 0:
        return Level.MAJOR if n[0] > 0 or n[1] > o[1] else Level.MINOR
    if n[0] > o[0]:
        return Level.MAJOR
    if n[1] > o[1]:
        return Level.MINOR
    return Level.PATCH


def next_version(old, level):
    major, minor, micro = (old.release + (0, 0, 0))[:3]
    if major == 0:
        level = {Level.MAJOR: Level.MINOR, Level.MINOR: Level.PATCH}.get(level, level)
    if level == Level.MAJOR:
        return f"{major + 1}.0.0"
    if level == Level.MINOR:
        return f"{major}.{minor + 1}.0"
    return f"{major}.{minor}.{micro + 1}"


def find_baseline(project, proposed):
    """Returns the latest stable, non-yanked release before proposed."""
    candidates = []
    for version, files in (project or {}).get("releases", {}).items():
        if not files or all(f.get("yanked") for f in files):
            continue
        try:
            parsed = Version(version)
        except InvalidVersion:
            continue
        if not parsed.is_prerelease and not parsed.is_devrelease and parsed < proposed:
            candidates.append((parsed, version))
    return max(candidates)[1] if candidates else None


def download_release(project, version, destination):
    """Extracts the sdist (or wheel) of a release, and returns its metadata."""
    files = [f for f in project["releases"][version] if not f.get("yanked")]
    files.sort(key=lambda f: f["packagetype"] != "sdist")
    release_file = files[0]
    archive = destination / release_file["filename"]
    archive.write_bytes(fetch(release_file["url"]))
    extracted = destination / "extracted"
    if release_file["packagetype"] == "sdist":
        with tarfile.open(archive) as tar:
            tar.extractall(extracted, filter="data")
        (root,) = [p for p in extracted.iterdir() if p.is_dir()]
        info_dirs = list(root.glob("*.egg-info"))
    else:
        with zipfile.ZipFile(archive) as wheel:
            wheel.extractall(extracted)
        root = extracted
        info_dirs = list(root.glob("*.dist-info"))

    top_level, entry_points = set(), {}
    for info_dir in info_dirs:
        if (info_dir / "top_level.txt").exists():
            top_level |= set((info_dir / "top_level.txt").read_text().split())
        if (info_dir / "entry_points.txt").exists():
            entry_points = parse_entry_points(
                (info_dir / "entry_points.txt").read_text()
            )
    if not top_level:
        top_level = {
            p.stem
            for p in root.iterdir()
            if (p.is_dir() and (p / "__init__.py").exists()) or p.suffix == ".py"
        } - {"setup"}

    info = json.loads(
        fetch(f"https://pypi.org/pypi/{project['info']['name']}/{version}/json")
    )["info"]
    return root, Metadata(
        top_level=top_level,
        requires_dist=info.get("requires_dist") or [],
        requires_python=info.get("requires_python") or None,
        entry_points=entry_points,
    )


def public_api(obj, api=None):
    """Returns the public objects of a module by path, following __all__."""
    api = {} if api is None else api
    for member in obj.members.values():
        try:
            public = member.is_public
        except Exception:
            continue
        if not public:
            continue
        api[member.path] = member
        if not member.is_alias and (member.is_module or member.is_class):
            public_api(member, api)
    return api


def describe_value(value):
    if isinstance(value, (list, tuple)):
        return "[" + ", ".join(describe_value(v) for v in value) + "]"
    if isinstance(value, (griffe.Parameter, griffe.Object, griffe.Alias)):
        return value.name
    return str(value)


def describe_breakage(breakage):
    message = breakage.kind.value
    if breakage.kind.name.startswith("PARAMETER_"):
        message += f" ({describe_value(breakage.old_value or breakage.new_value)})"
    if breakage.kind.name in (
        "PARAMETER_CHANGED_DEFAULT",
        "PARAMETER_CHANGED_KIND",
        "RETURN_CHANGED_TYPE",
        "ATTRIBUTE_CHANGED_TYPE",
        "ATTRIBUTE_CHANGED_VALUE",
        "CLASS_REMOVED_BASE",
        "OBJECT_CHANGED_KIND",
    ):
        old, new = breakage.old_value, breakage.new_value
        if breakage.kind.name == "PARAMETER_CHANGED_DEFAULT":
            old, new = old.default, new.default
        elif breakage.kind.name == "PARAMETER_CHANGED_KIND":
            old, new = old.kind.value, new.kind.value
        message += f": {shorten(describe_value(old))} -> {shorten(describe_value(new))}"
    return message


def shorten(text, width=60):
    return text if len(text) <= width else text[: width - 3] + "..."


def describe_parameter(parameter):
    return (
        f"{parameter.name}={parameter.default}" if parameter.default else parameter.name
    )


def api_changes(old_dir, new_dir, old_modules, new_modules):
    changes = []
    for module in sorted(old_modules - new_modules):
        changes.append(Change(Level.MAJOR, "OBJECT_REMOVED", module, "module removed"))
    for module in sorted(new_modules - old_modules):
        changes.append(Change(Level.MINOR, "OBJECT_ADDED", module, "module added"))

    for module in sorted(old_modules & new_modules):
        options = {"allow_inspection": False, "resolve_external": False}
        old = griffe.load(module, search_paths=[str(old_dir)], **options)
        new = griffe.load(module, search_paths=[str(new_dir)], **options)

        for breakage in griffe.find_breaking_changes(old, new):
            kind = breakage.kind.name
            if kind == "CLASS_REMOVED_BASE" and {str(b) for b in breakage.old_value} - {
                str(b) for b in breakage.new_value
            } <= {"object"}:
                continue
            level = Level.MAJOR if kind in MAJOR_BREAKAGES else None
            changes.append(
                Change(level, kind, breakage.obj.path, describe_breakage(breakage))
            )

        old_api, new_api = public_api(old), public_api(new)
        for path in sorted(new_api.keys() - old_api.keys()):
            try:
                kind = new_api[path].kind.value
            except griffe.AliasResolutionError:
                kind = "object"
            changes.append(Change(Level.MINOR, "OBJECT_ADDED", path, f"{kind} added"))
        for path in sorted(new_api.keys() & old_api.keys()):
            old_obj, new_obj = old_api[path], new_api[path]
            if old_obj.is_alias or new_obj.is_alias:
                continue
            if not (old_obj.is_function and new_obj.is_function):
                continue
            old_names = {p.name for p in old_obj.parameters}
            for parameter in new_obj.parameters:
                if parameter.name in old_names:
                    continue
                if parameter.default is None and parameter.kind.value not in (
                    "variadic positional",
                    "variadic keyword",
                ):
                    continue
                changes.append(
                    Change(
                        Level.MINOR,
                        "PARAMETER_ADDED_OPTIONAL",
                        f"{path}({parameter.name})",
                        f"optional parameter {describe_parameter(parameter)} added",
                    )
                )
    return changes


def python_files(directory, modules):
    files = {}
    for module in modules:
        if (directory / f"{module}.py").exists():
            files[f"{module}.py"] = (directory / f"{module}.py").read_bytes()
        for path in (directory / module).rglob("*.py"):
            if "__pycache__" not in path.parts:
                files[path.relative_to(directory).as_posix()] = path.read_bytes()
    return files


def implementation_changes(old_dir, new_dir, modules):
    old_files = python_files(old_dir, modules)
    new_files = python_files(new_dir, modules)
    changed = sorted(
        path
        for path in old_files.keys() | new_files.keys()
        if old_files.get(path) != new_files.get(path)
    )
    if not changed:
        return []
    listed = ", ".join(changed[:5]) + (", ..." if len(changed) > 5 else "")
    return [
        Change(
            Level.PATCH,
            "IMPLEMENTATION_CHANGED",
            changed[0] if len(changed) == 1 else "",
            f"{len(changed)} file(s) changed: {listed}",
        )
    ]


ARGUMENT_CALL_RE = re.compile(r"\.add_argument\(\s*((?:[\"']-[^\"']*[\"']\s*,?\s*)+)")
OPTION_RE = re.compile(r"[\"'](-[^\"']*)[\"']")


def cli_options(directory, modules):
    options = set()
    for content in python_files(directory, modules).values():
        text = content.decode("utf-8", errors="replace")
        for call in ARGUMENT_CALL_RE.finditer(text):
            options.update(OPTION_RE.findall(call.group(1)))
    return options


def cli_changes(old_dir, new_dir, modules):
    old_options = cli_options(old_dir, modules)
    new_options = cli_options(new_dir, modules)
    changes = [
        Change(None, "CLI_OPTION_REMOVED", option, "command line option removed")
        for option in sorted(old_options - new_options)
    ]
    changes += [
        Change(Level.MINOR, "CLI_OPTION_ADDED", option, "command line option added")
        for option in sorted(new_options - old_options)
    ]
    return changes


def bounds(specifiers):
    """Returns the (lower, upper) bound of a specifier set, or None if unsupported."""
    lower = upper = None
    for spec in SpecifierSet(specifiers or ""):
        if spec.operator in ("!=", "===") or "*" in spec.version:
            return None
        version = Version(spec.version)
        if spec.operator in (">=", ">", "==", "~="):
            lower = max(lower, version) if lower else version
        if spec.operator in ("<", "<=", "=="):
            upper = min(upper, version) if upper else version
        if spec.operator == "~=":
            release = version.release[:-1]
            compatible = Version(".".join(map(str, release[:-1] + (release[-1] + 1,))))
            upper = min(upper, compatible) if upper else compatible
    return lower, upper


def specifier_change(kind, path, subject, old, new):
    old_bounds, new_bounds = bounds(old), bounds(new)
    description = f"{subject} changed from {old or 'any'!r} to {new or 'any'!r}"
    if old_bounds is None or new_bounds is None:
        return Change(None, kind, path, description)
    (old_lower, old_upper), (new_lower, new_upper) = old_bounds, new_bounds
    reasons = []
    if new_lower and (old_lower is None or new_lower > old_lower):
        reasons.append("raises the minimum version")
    if new_upper and (old_upper is None or new_upper < old_upper):
        reasons.append("adds or lowers an upper bound, which excludes newer versions")
    if reasons:
        return Change(Level.MINOR, kind, path, f"{description} ({', '.join(reasons)})")
    return Change(Level.PATCH, kind, path, f"{description} (relaxed)")


def requirements_by_name(requires_dist):
    result = {}
    for requirement in requires_dist:
        parsed = Requirement(requirement)
        result.setdefault(canonicalize_name(parsed.name), []).append(parsed)
    return result


def metadata_changes(old, new):
    changes = []
    if (old.requires_python or "") != (new.requires_python or ""):
        changes.append(
            specifier_change(
                "PYTHON_REQUIRES_CHANGED",
                "python_requires",
                "supported Python versions",
                old.requires_python,
                new.requires_python,
            )
        )

    old_requires = requirements_by_name(old.requires_dist)
    new_requires = requirements_by_name(new.requires_dist)
    for name in sorted(old_requires.keys() - new_requires.keys()):
        changes.append(
            Change(Level.PATCH, "DEPENDENCY_REMOVED", name, "dependency removed")
        )
    for name in sorted(new_requires.keys() - old_requires.keys()):
        requirement = new_requires[name][0]
        optional = requirement.marker and "extra" in str(requirement.marker)
        changes.append(
            Change(
                Level.MINOR,
                "DEPENDENCY_ADDED",
                name,
                f"{'optional' if optional else 'runtime'} dependency {requirement} added",
            )
        )
    for name in sorted(old_requires.keys() & new_requires.keys()):
        old_list, new_list = old_requires[name], new_requires[name]
        if len(old_list) > 1 or len(new_list) > 1:
            if sorted(map(str, old_list)) != sorted(map(str, new_list)):
                changes.append(
                    Change(None, "DEPENDENCY_CHANGED", name, "dependency changed")
                )
            continue
        (old_req,), (new_req,) = old_list, new_list
        if str(old_req.marker or "") != str(new_req.marker or ""):
            changes.append(
                Change(
                    None,
                    "DEPENDENCY_CHANGED",
                    name,
                    f"environment marker changed from {old_req} to {new_req}",
                )
            )
        if str(old_req.specifier) != str(new_req.specifier):
            changes.append(
                specifier_change(
                    "DEPENDENCY_CHANGED",
                    name,
                    f"dependency {name}",
                    str(old_req.specifier),
                    str(new_req.specifier),
                )
            )

    for group in ENTRY_POINT_GROUPS:
        old_scripts = old.entry_points.get(group, {})
        new_scripts = new.entry_points.get(group, {})
        for script in sorted(old_scripts.keys() - new_scripts.keys()):
            changes.append(
                Change(Level.MAJOR, "SCRIPT_REMOVED", script, f"{group} entry removed")
            )
        for script in sorted(new_scripts.keys() - old_scripts.keys()):
            changes.append(
                Change(Level.MINOR, "SCRIPT_ADDED", script, f"{group} entry added")
            )
        for script in sorted(old_scripts.keys() & new_scripts.keys()):
            if old_scripts[script] != new_scripts[script]:
                changes.append(
                    Change(
                        None,
                        "SCRIPT_CHANGED",
                        script,
                        f"target changed from {old_scripts[script]} "
                        f"to {new_scripts[script]}",
                    )
                )
    return changes


def load_exceptions(path=EXCEPTIONS_FILE):
    if not Path(path).exists():
        return []
    with open(path, "rb") as f:
        exceptions = tomllib.load(f).get("exception", [])
    for exception in exceptions:
        missing = {"package", "version", "reason"} - exception.keys()
        if missing or not str(exception.get("reason", "")).strip():
            raise ValueError(
                f"Invalid exception {exception} in {path}: "
                f"needs package, version and a non-empty reason"
            )
    return exceptions


def matching_exception(name, version, change, exceptions):
    for exception in exceptions:
        if canonicalize_name(exception["package"]) != canonicalize_name(name):
            continue
        if Version(str(exception["version"])) != version:
            continue
        if "kind" in exception and exception["kind"] != change.kind:
            continue
        if "path" in exception and not fnmatch.fnmatch(change.path, exception["path"]):
            continue
        return exception
    return None


def compare(
    name, proposed, previous, old_dir, old_meta, new_dir, new_meta, exceptions=()
):
    """Compares two releases of a package that are available locally."""
    result = Result(name=name, proposed=proposed, previous=previous)
    if proposed <= previous:
        result.error = f"{proposed} is not greater than the previous release {previous}"
        return result
    if bump_level(previous, proposed) is None:
        result.error = (
            f"{proposed} doesn't bump the release number of {previous}. "
            f"Post-releases are not supported"
        )
        return result

    common = old_meta.top_level & new_meta.top_level
    changes = api_changes(old_dir, new_dir, old_meta.top_level, new_meta.top_level)
    changes += cli_changes(old_dir, new_dir, common)
    changes += metadata_changes(old_meta, new_meta)
    changes += implementation_changes(old_dir, new_dir, common)

    for change in changes:
        exception = matching_exception(name, proposed, change, exceptions)
        if exception:
            result.ignored.append((change, exception["reason"]))
        else:
            result.changes.append(change)
    return result


def check_package(source_dir, project=None, exceptions=(), metadata=None):
    """Checks the package in source_dir against its latest release on PyPI."""
    metadata = metadata or read_setup_metadata(source_dir)
    name = metadata["name"]
    proposed = Version(metadata["version"])
    previous = find_baseline(project, proposed)
    if previous is None:
        return Result(
            name=name,
            proposed=proposed,
            note="no earlier stable release on PyPI, treating it as initial release",
        )

    with tempfile.TemporaryDirectory(prefix=f"semver-{name}-") as tmp:
        old_dir, old_meta = download_release(project, previous, Path(tmp))
        return compare(
            name,
            proposed,
            Version(previous),
            old_dir,
            old_meta,
            Path(source_dir),
            metadata_from_setup(metadata),
            exceptions,
        )


def format_result(result):
    status = "OK" if result.ok else "FAIL"
    lines = [f"{result.name} {result.proposed}: {status}"]
    if result.note:
        lines.append(f"  Note: {result.note}")
    if result.previous is None:
        return "\n".join(lines)

    lines.append(f"  Previous release: {result.previous}")
    if result.error:
        lines.append(f"  Error: {result.error}")
        return "\n".join(lines)

    required, bump = result.required, result.bump
    lines.append(f"  Proposed version: {result.proposed} ({bump} bump)")
    if required == Level.NONE:
        lines.append("  Minimum required bump: none (no changes detected)")
    else:
        lines.append(
            f"  Minimum required bump: {required} "
            f"(next version: {next_version(result.previous, required)})"
        )
    if not result.ok:
        lines.append(
            f"  Why: the changes below need a {required} bump, but "
            f"{result.previous} -> {result.proposed} is only a {bump} bump"
        )

    for level in (Level.MAJOR, Level.MINOR, Level.PATCH):
        changes = [c for c in result.changes if c.level == level]
        if changes:
            lines.append(f"  Changes requiring a {level} bump:")
            lines += [f"    - {format_change(c)}" for c in changes]
    review = [c for c in result.changes if c.level is None]
    if review:
        lines.append("  Needs manual review (not counted):")
        lines += [f"    - {format_change(c)}" for c in review]
    if result.ignored:
        lines.append("  Ignored by semver-exceptions.toml:")
        lines += [
            f"    - {format_change(c)} (reason: {reason})"
            for c, reason in result.ignored
        ]
    return "\n".join(lines)


def format_change(change):
    prefix = f"{change.path}: " if change.path else ""
    return f"[{change.kind}] {prefix}{change.message}"


def package_directories():
    return sorted(p.parent for p in HERE.glob("*/setup.py"))


def main():
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument(
        "packages",
        nargs="*",
        metavar="PACKAGE",
        help="Directory names of the packages to check. [default: all]",
    )
    parser.add_argument(
        "--exceptions",
        default=EXCEPTIONS_FILE,
        help="File with exceptions for false positives. [default: %(default)s]",
    )
    args = parser.parse_args()

    exceptions = load_exceptions(args.exceptions)
    directories = package_directories()
    if args.packages:
        unknown = set(args.packages) - {d.name for d in directories}
        if unknown:
            parser.error(f"unknown package(s): {', '.join(sorted(unknown))}")
        directories = [d for d in directories if d.name in args.packages]

    failed = False
    for directory in directories:
        metadata = read_setup_metadata(directory)
        project = fetch_project(metadata["name"])
        releases = (project or {}).get("releases", {})
        for exception in exceptions:
            if canonicalize_name(exception["package"]) == canonicalize_name(
                metadata["name"]
            ) and releases.get(str(exception["version"])):
                print(
                    f"warning: the exception for {exception['package']} "
                    f"{exception['version']} is outdated because that version "
                    f"is released, and can be removed"
                )
        if releases.get(metadata["version"]):
            print(
                f"{metadata['name']} {metadata['version']}: already released, skipping"
            )
            continue

        result = check_package(directory, project, exceptions, metadata)
        print(format_result(result))
        failed |= not result.ok

    if failed:
        print(
            "\nAt least one version bump is insufficient. Bump the versions as "
            "listed above, or add an exception with a reason to "
            f"{EXCEPTIONS_FILE.relative_to(HERE.parent.parent)} for false positives."
        )
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
