#!/usr/bin/env python3

# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this file,
# You can obtain one at http://mozilla.org/MPL/2.0/.

"""
Release mozbase packages to PyPI.

Only packages whose in-tree version is not yet on PyPI get released. They are
uploaded in dependency order, and each one is built from the revision that
bumped its version, so changes that landed after the bump are not shipped.

Before a package gets uploaded, semver_check.py verifies that its version
bump is sufficient for the changes since its previous release.

PyPI is the only state, so after a failure simply run the script again.
Without --upload only the planned steps are shown.

Run it with the python-test virtualenv, which provides Griffe:

    ./mach python --virtualenv python-test testing/mozbase/release.py
"""

import argparse
import json
import re
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

import semver_check
from packaging.requirements import Requirement
from packaging.utils import canonicalize_name
from packaging.version import InvalidVersion

HERE = Path(__file__).resolve().parent
TOPSRCDIR = HERE.parent.parent
MOZBASE = HERE.relative_to(TOPSRCDIR).as_posix()

VERSION_RE = re.compile(r"^PACKAGE_VERSION\s*=\s*[\"']([^\"']+)[\"']", re.MULTILINE)


def git(*args):
    return subprocess.run(
        ["git", *args],
        cwd=TOPSRCDIR,
        check=True,
        capture_output=True,
        text=True,
    ).stdout


def parse_requirement(requirement):
    parsed = Requirement(requirement)
    return canonicalize_name(parsed.name), parsed.specifier


class PyPI:
    def __init__(self):
        self._cache = {}

    def project(self, name, refresh=False):
        if refresh or name not in self._cache:
            try:
                with urllib.request.urlopen(
                    f"https://pypi.org/pypi/{name}/json", timeout=30
                ) as response:
                    self._cache[name] = json.load(response)
            except urllib.error.HTTPError as e:
                if e.code != 404:
                    raise
                self._cache[name] = None
        return self._cache[name]

    def release(self, name, version):
        try:
            with urllib.request.urlopen(
                f"https://pypi.org/pypi/{name}/{version}/json", timeout=30
            ) as response:
                return json.load(response)
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            raise

    def files(self, name, version, refresh=False):
        project = self.project(name, refresh=refresh)
        if not project:
            return None
        return project["releases"].get(version)

    def available_versions(self, name):
        project = self.project(name)
        if not project:
            return []
        return [
            version
            for version, files in project["releases"].items()
            if files and not all(f.get("yanked") for f in files)
        ]


def setup_py_history(rev):
    """Returns the commits that modified each package's setup.py, newest first."""
    history = {}
    commit = None
    for line in git(
        "log", "--format=commit %H", "--name-only", rev, "--", f"{MOZBASE}/*/setup.py"
    ).splitlines():
        if line.startswith("commit "):
            commit = line.split()[1]
        elif match := re.fullmatch(rf"{MOZBASE}/([^/]+)/setup\.py", line):
            history.setdefault(match.group(1), []).append(commit)
    return history


class Package:
    def __init__(self, directory, rev, commits):
        self.directory = directory
        self.path = f"{MOZBASE}/{directory}"
        self.rev = rev
        self.version = self._version_at(rev)
        self.bump_rev = self._find_bump_rev(commits)
        self.metadata = None

    def _version_at(self, rev):
        try:
            content = git("show", f"{rev}:{self.path}/setup.py")
        except subprocess.CalledProcessError:
            return None
        match = VERSION_RE.search(content)
        return match.group(1) if match else None

    def _find_bump_rev(self, commits):
        # The oldest commit of the most recent run of commits with the current
        # version, so that a relanding after a backout is picked up as well.
        bump_rev = None
        for commit in commits:
            if self._version_at(commit) != self.version:
                break
            bump_rev = commit
        return bump_rev

    def export(self, destination):
        """Extract the package from its bump revision into destination."""
        destination.mkdir(parents=True)
        archive = destination / "package.tar"
        with archive.open("wb") as f:
            subprocess.run(
                ["git", "archive", "--format=tar", self.bump_rev, self.path],
                cwd=TOPSRCDIR,
                check=True,
                stdout=f,
            )
        with tarfile.open(archive) as tar:
            tar.extractall(destination, filter="data")
        archive.unlink()
        return destination / self.path

    def load_metadata(self, workdir):
        source = self.export(workdir)
        self.metadata = semver_check.read_setup_metadata(source)
        self.name = self.metadata["name"]
        self.requirements = [
            parse_requirement(r) for r in self.metadata["install_requires"]
        ]
        return source

    def unreleased_commits(self):
        return git(
            "log", "--format=%h %s", f"{self.bump_rev}..{self.rev}", "--", self.path
        ).splitlines()


def sort_by_dependencies(packages):
    by_name = {canonicalize_name(p.name): p for p in packages}
    ordered, visiting, done = [], set(), set()

    def visit(package):
        key = canonicalize_name(package.name)
        if key in done:
            return
        if key in visiting:
            raise RuntimeError(f"Dependency cycle involving {package.name}")
        visiting.add(key)
        for name, _ in package.requirements:
            if name in by_name and name != key:
                visit(by_name[name])
        visiting.discard(key)
        done.add(key)
        ordered.append(package)

    for package in sorted(packages, key=lambda p: p.name.lower()):
        visit(package)
    return ordered


def has_wheel_and_sdist(files):
    types = {f["packagetype"] for f in files or []}
    return {"bdist_wheel", "sdist"} <= types


def check_requirements(package, pypi, planned):
    """Returns the requirements that no PyPI release (or planned upload) satisfies."""
    missing = []
    for name, specifier in package.requirements:
        versions = pypi.available_versions(name)
        if name in planned:
            versions.append(planned[name])
        if not any(satisfies(specifier, v) for v in versions):
            missing.append(f"{name}{specifier}")
    return missing


def satisfies(specifier, version):
    try:
        return specifier.contains(version, prereleases=True)
    except InvalidVersion:
        return False


def metadata_differences(package, release):
    info = release["info"]
    differences = []
    if (info.get("requires_python") or None) != package.metadata["python_requires"]:
        differences.append(
            f"requires_python: PyPI {info.get('requires_python')!r}, "
            f"tree {package.metadata['python_requires']!r}"
        )
    pypi_deps = sorted(parse_requirement(r)[0] for r in info.get("requires_dist") or [])
    tree_deps = sorted(name for name, _ in package.requirements)
    if pypi_deps != tree_deps:
        differences.append(f"dependencies: PyPI {pypi_deps}, tree {tree_deps}")
    return differences


def build_and_upload(source):
    dist = source / "dist"
    subprocess.run(
        ["uv", "build", "--out-dir", str(dist)],
        cwd=source,
        check=True,
    )
    files = sorted(str(f) for f in dist.iterdir())
    subprocess.run(["twine", "upload", "--skip-existing", *files], check=True)


def wait_for_release(package, pypi, timeout=120):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        files = pypi.files(package.name, package.version, refresh=True)
        if has_wheel_and_sdist(files):
            return True
        time.sleep(10)
    return False


def main():
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument(
        "--upload",
        action="store_true",
        help="Build and upload the packages. Without it only the plan is shown.",
    )
    parser.add_argument(
        "--rev",
        default="HEAD",
        help="Revision to take the package versions from. [default: HEAD]",
    )
    parser.add_argument(
        "--only",
        action="append",
        default=[],
        metavar="PACKAGE",
        help="Only release the given package. Can be passed multiple times.",
    )
    parser.add_argument(
        "--skip",
        action="append",
        default=[],
        metavar="PACKAGE",
        help="Don't release the given package. Can be passed multiple times.",
    )
    args = parser.parse_args()

    with tempfile.TemporaryDirectory(prefix="mozbase-release-") as workdir:
        return release(args, Path(workdir))


def release(args, workdir):
    rev = git("rev-parse", args.rev).strip()
    print(f"Taking package versions from {rev[:12]}\n")

    directories = sorted(
        Path(p).parent.name
        for p in git("ls-tree", "-r", "--name-only", rev, MOZBASE).split()
        if re.fullmatch(rf"{MOZBASE}/[^/]+/setup\.py", p)
    )

    history = setup_py_history(rev)
    exceptions = semver_check.load_exceptions()
    pypi = PyPI()
    packages, sources = [], {}
    for directory in directories:
        package = Package(directory, rev, history.get(directory, []))
        if not package.version or not package.bump_rev:
            print(f"warning: no PACKAGE_VERSION found for {directory}, skipping")
            continue
        sources[directory] = package.load_metadata(workdir / directory)
        packages.append(package)

    planned = {}
    results = []
    failed = set()
    for package in sort_by_dependencies(packages):
        key = canonicalize_name(package.name)
        label = f"{package.name} {package.version}"
        files = pypi.files(package.name, package.version)
        selected = (not args.only or package.directory in args.only) and (
            package.directory not in args.skip
        )

        unreleased = package.unreleased_commits()
        if unreleased:
            print(
                f"warning: {package.name} has {len(unreleased)} commit(s) after "
                f"the {package.version} bump that won't be released:"
            )
            for line in unreleased[:5]:
                print(f"    {line[:100]}")
            if len(unreleased) > 5:
                print("    ...")

        if files and all(f.get("yanked") for f in files):
            print(f"error: {label} is yanked on PyPI, a version bump is needed")
            results.append((package, "yanked"))
            failed.add(key)
            continue

        if has_wheel_and_sdist(files):
            release = pypi.release(package.name, package.version)
            for difference in metadata_differences(package, release):
                print(f"warning: {label} on PyPI differs from the tree: {difference}")
            results.append((package, "on PyPI"))
            continue

        if not selected:
            results.append((package, "skipped"))
            continue

        blocked = [
            name for name, _ in package.requirements if name in failed and name != key
        ]
        if blocked:
            print(f"error: {label} depends on failed package(s): {', '.join(blocked)}")
            results.append((package, "blocked"))
            failed.add(key)
            continue

        missing = check_requirements(package, pypi, planned)
        if missing:
            print(f"error: {label} needs unreleased {', '.join(missing)}")
            results.append((package, "blocked"))
            failed.add(key)
            continue

        result = semver_check.check_package(
            sources[package.directory],
            pypi.project(package.name),
            exceptions,
            package.metadata,
        )
        if not result.ok:
            print(semver_check.format_result(result))
            results.append((package, "semver check failed"))
            failed.add(key)
            continue

        state = "partially on PyPI" if files else "not on PyPI"
        print(f"{label} ({state}): release from {package.bump_rev[:12]}")
        if not args.upload:
            planned[key] = package.version
            results.append((package, "would release"))
            continue

        try:
            build_and_upload(sources[package.directory])
        except subprocess.CalledProcessError as e:
            print(f"error: uploading {label} failed: {e}")
            results.append((package, "failed"))
            failed.add(key)
            continue

        if not wait_for_release(package, pypi):
            print(f"error: {label} doesn't show up on PyPI")
            results.append((package, "failed"))
            failed.add(key)
            continue

        pypi.project(package.name, refresh=True)
        for difference in metadata_differences(
            package, pypi.release(package.name, package.version)
        ):
            print(f"warning: {label} on PyPI differs from the tree: {difference}")
        results.append((package, "released"))

    print("\nSummary:")
    for package, status in results:
        print(
            f"  {package.name:<18} {package.version:<8} "
            f"{package.bump_rev[:12]}  {status}"
        )

    released = [p for p, status in results if status == "released"]
    if released:
        print("\nReleased to PyPI:\n")
        for package in released:
            print(
                f"- {package.name} {package.version}: "
                f"https://pypi.org/project/{package.name}/{package.version}/"
            )

    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
