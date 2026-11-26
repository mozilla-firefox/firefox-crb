# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

"""Prepare a staged application tree for archiving."""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import zipfile
from typing import Optional, Sequence

import mozpack.path as mozpath

from mozbuild.action import find_dupes, package_libmegazord_artifacts
from mozbuild.action import zip as zip_action
from mozbuild.codecoverage import packager as coverage_packager
from mozbuild.packaging import echo_command

_REWRITE_SANITIZER_DYLIB = "build/unix/rewrite_sanitizer_dylib.py"
_DIST_INCLUDE_MANIFEST = "_build_manifests/install/dist_include"
_MOZSEARCH_INDEX_DIR = "mozsearch_index"
_MOZSEARCH_JAVA_INDEX_DIR = "mozsearch_java_index"
_RUST_ANALYZER_CONFIG = "rust-analyzer.json"
_SCIP_INDEX = "index.scip"
_INDEX_COMPRESSION_LEVEL = 5


def check_symbol_archives(symbol_archives: Sequence[str]) -> int:
    for archive in symbol_archives:
        if not os.path.exists(archive):
            print(
                f"Expected symbol archive {archive} not found. This should have "
                "been created by artifacts.py during artifact installation. "
                "Check that UPLOAD_DIR is set correctly and that symbols were "
                "downloaded.",
                file=sys.stderr,
            )
            return 1
    return 0


def _mach(topsrcdir: str, *args: str, cwd: Optional[str] = None) -> int:
    argv = [sys.executable, mozpath.join(topsrcdir, "mach"), *args]
    echo_command(argv)
    return subprocess.call(argv, cwd=cwd)


def _index_archive(source: str, output: str, names: Sequence[str] = (".",)) -> int:
    paths = []
    for name in names:
        top = mozpath.join(source, name)
        if os.path.isfile(top):
            paths.append(mozpath.normpath(name))
            continue
        for root, dirs, files in os.walk(top, followlinks=True):
            dirs.sort()
            relative = mozpath.relpath(root, source)
            paths += [
                mozpath.normpath(mozpath.join(relative, f)) for f in sorted(files)
            ]
    if not paths:
        print(f"No files added to {output}", file=sys.stderr)
        return 1

    temp = f"{output}.tmp"
    try:
        with zipfile.ZipFile(
            temp,
            "w",
            zipfile.ZIP_DEFLATED,
            compresslevel=_INDEX_COMPRESSION_LEVEL,
            allowZip64=True,
        ) as archive:
            for path in paths:
                archive.write(mozpath.join(source, path), path)
    except BaseException:
        if os.path.exists(temp):
            os.remove(temp)
        raise
    os.replace(temp, output)
    return 0


def _scip_index(
    *, topsrcdir: str, topobjdir: str, moz_fetches_dir: str, output: str
) -> int:
    config = mozpath.join(topobjdir, _RUST_ANALYZER_CONFIG)
    try:
        if rc := _mach(topsrcdir, "rust-analyzer-config", "-o", config, cwd=topsrcdir):
            return rc

        env = dict(os.environ)
        env["CARGO"] = mozpath.join(moz_fetches_dir, "rustc/bin/cargo")
        env["RUSTC"] = mozpath.join(moz_fetches_dir, "rustc/bin/rustc")
        argv = [
            mozpath.join(moz_fetches_dir, "rust-analyzer/bin/rust-analyzer"),
            "scip",
            ".",
            "--config-path",
            config,
        ]
        echo_command(argv)
        if rc := subprocess.call(argv, cwd=topsrcdir, env=env):
            return rc

        return _index_archive(topsrcdir, output, [_SCIP_INDEX])
    finally:
        if os.path.exists(config):
            os.remove(config)


def package_prepare(
    *,
    staged_dir: str,
    topsrcdir: Optional[str] = None,
    topobjdir: Optional[str] = None,
    moz_fetches_dir: Optional[str] = None,
    symbol_archives: Sequence[str] = (),
    check_dupes: bool = False,
    defines: Sequence[str] = (),
    warn_dupes: bool = False,
    allowed_dupes: Sequence[str] = (),
    mozharness_zip: Optional[str] = None,
    jsshell: Optional[Sequence[str]] = None,
    chrome_map: bool = False,
    code_coverage_archive: Optional[str] = None,
    mozsearch_index: Optional[str] = None,
    mozsearch_includemap: Optional[str] = None,
    mozsearch_scip_index: Optional[str] = None,
    mozsearch_java_index: Optional[str] = None,
    rewrite_sanitizer_dylib: Optional[str] = None,
    archives: Sequence[Sequence[str]] = (),
    libmegazord_artifacts: Optional[Sequence[str]] = None,
) -> int:
    if rc := check_symbol_archives(symbol_archives):
        return rc

    if check_dupes:
        argv = [f"-D{define}" for define in defines]
        if warn_dupes:
            argv.append("-w")
        for allowlist in allowed_dupes:
            argv += ["-f", allowlist]
        argv.append(staged_dir)
        echo_command(["find_dupes", *argv])
        if rc := find_dupes.main(argv):
            return rc

    if mozharness_zip:
        from mozbuild.action import test_archive

        argv = ["mozharness", mozharness_zip]
        echo_command(["test_archive", *argv])
        test_archive.main(argv)

    if jsshell:
        source, output, files_from = jsshell
        if os.path.exists(output):
            os.remove(output)
        argv = [
            "-C",
            source,
            "--strip",
            os.path.abspath(output),
            "--files-from",
            files_from,
        ]
        echo_command(["zip", *argv])
        zip_action.main(argv)

    if chrome_map:
        if rc := _mach(topsrcdir, "build-backend", "-b", "ChromeMap"):
            return rc

    if code_coverage_archive:
        argv = ["--output-file", code_coverage_archive]
        echo_command(["codecoverage.packager", *argv])
        coverage_packager.cli(argv)

    if mozsearch_index:
        if rc := _index_archive(
            mozpath.join(topobjdir, _MOZSEARCH_INDEX_DIR), mozsearch_index
        ):
            return rc

    if mozsearch_includemap:
        shutil.copyfile(
            mozpath.join(topobjdir, _DIST_INCLUDE_MANIFEST), mozsearch_includemap
        )

    if mozsearch_scip_index:
        if rc := _scip_index(
            topsrcdir=topsrcdir,
            topobjdir=topobjdir,
            moz_fetches_dir=moz_fetches_dir,
            output=mozsearch_scip_index,
        ):
            return rc

    if mozsearch_java_index:
        if rc := _mach(topsrcdir, "android", "compile-all", cwd=topsrcdir):
            return rc
        if rc := _index_archive(
            mozpath.join(topobjdir, _MOZSEARCH_JAVA_INDEX_DIR), mozsearch_java_index
        ):
            return rc

    if rewrite_sanitizer_dylib:
        argv = [
            sys.executable,
            mozpath.join(topsrcdir, _REWRITE_SANITIZER_DYLIB),
            rewrite_sanitizer_dylib,
        ]
        echo_command(argv)
        if rc := subprocess.call(argv):
            return rc

    for source, output, pattern in archives:
        argv = [
            "--error-if-empty",
            "-C",
            source,
            os.path.abspath(output),
            pattern,
        ]
        echo_command(["zip", *argv])
        zip_action.main(argv)

    if libmegazord_artifacts:
        dist_bin, output = libmegazord_artifacts
        argv = ["--dist-bin", dist_bin, output]
        echo_command(["package_libmegazord_artifacts", *argv])
        if rc := package_libmegazord_artifacts.main(argv):
            return rc

    return 0


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Prepare a staged application tree for archiving."
    )
    parser.add_argument(
        "--staged-dir", required=True, help="Staged application tree to prepare"
    )
    parser.add_argument("--topsrcdir", required=True, help="Top source directory")
    parser.add_argument("--topobjdir", required=True, help="Top object directory")
    parser.add_argument(
        "--moz-fetches-dir", metavar="DIR", help="Directory holding fetched toolchains"
    )
    parser.add_argument(
        "--symbol-archive",
        action="append",
        default=[],
        dest="symbol_archives",
        metavar="PATH",
        help="Archive an artifact build must have downloaded. Repeatable.",
    )
    parser.add_argument(
        "--find-dupes",
        dest="check_dupes",
        action="store_true",
        help="Check the staged tree for duplicated files",
    )
    parser.add_argument(
        "-D",
        dest="defines",
        action="append",
        default=[],
        metavar="VAR[=VAL]",
        help="Define a variable for the duplicate allowlist preprocessor. Repeatable.",
    )
    parser.add_argument(
        "--warn-dupes",
        action="store_true",
        help="Warn about unexpected duplicated files instead of failing",
    )
    parser.add_argument(
        "--allowed-dupes",
        action="append",
        default=[],
        metavar="PATH",
        help="File listing duplicates that are allowed. Repeatable.",
    )
    parser.add_argument(
        "--mozharness-zip", metavar="PATH", help="mozharness archive to write"
    )
    parser.add_argument(
        "--jsshell",
        nargs=3,
        metavar=("SOURCE", "OUTPUT", "FILES_FROM"),
        help="Archive the JavaScript shell files under SOURCE into OUTPUT. "
        "FILES_FROM lists the files, one path per line.",
    )
    parser.add_argument(
        "--chrome-map",
        action="store_true",
        help="Generate the ChromeMap build backend",
    )
    parser.add_argument(
        "--code-coverage-archive", metavar="PATH", help="Coverage archive to write"
    )
    parser.add_argument(
        "--mozsearch-index", metavar="PATH", help="mozsearch index archive to write"
    )
    parser.add_argument(
        "--mozsearch-includemap",
        metavar="PATH",
        help="mozsearch distinclude map to write",
    )
    parser.add_argument(
        "--mozsearch-scip-index", metavar="PATH", help="mozsearch scip index to write"
    )
    parser.add_argument(
        "--mozsearch-java-index",
        metavar="PATH",
        help="mozsearch Java and Kotlin semanticdb archive to write",
    )
    parser.add_argument(
        "--rewrite-sanitizer-dylib",
        metavar="DIR",
        help="Rewrite sanitizer runtime dylib paths for the binaries in DIR",
    )
    parser.add_argument(
        "--archive",
        action="append",
        nargs=3,
        default=[],
        dest="archives",
        metavar=("SOURCE", "OUTPUT", "PATTERN"),
        help="Archive the files matching PATTERN under SOURCE into OUTPUT, "
        "which must not come out empty. Repeatable.",
    )
    parser.add_argument(
        "--libmegazord-artifacts",
        nargs=2,
        metavar=("DIST_BIN", "OUTPUT"),
        help="Archive the libmegazord artifacts in DIST_BIN into OUTPUT",
    )
    return parser


def main(argv: list[str]) -> int:
    parser = _parser()
    args = parser.parse_args(argv)
    if args.mozsearch_scip_index and not args.moz_fetches_dir:
        parser.error("--mozsearch-scip-index requires --moz-fetches-dir")
    return package_prepare(**vars(args))


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
