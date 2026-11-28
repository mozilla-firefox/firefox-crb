# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

"""List the sha256 of the Rust intermediate artifacts (rlibs, rmeta files and
proc-macro libraries) cargo left in the objdir.

Two builds of the same tree must produce the same list; a difference names a
crate whose compilation is not deterministic, which breaks sccache sharing even
when the final binaries are identical.
"""

import argparse
import glob
import hashlib
import os
import sys

import buildconfig
import mozpack.path as mozpath

EXTENSIONS = (".rlib", ".rmeta", ".so", ".dylib", ".dll")


def deps_dirs(topobjdir):
    # Cargo writes to <objdir>/<profile>/deps for the host and to
    # <objdir>/<target>/<profile>/deps for the target.
    for pattern in ("*", "*/*"):
        for profile in sorted(glob.glob(os.path.join(topobjdir, pattern))):
            if os.path.isdir(os.path.join(profile, ".fingerprint")) and os.path.isdir(
                os.path.join(profile, "deps")
            ):
                yield os.path.join(profile, "deps")


def main(argv):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", help="File to write the list to")
    args = parser.parse_args(argv)

    topobjdir = buildconfig.topobjdir
    entries = []
    for deps in deps_dirs(topobjdir):
        for name in os.listdir(deps):
            if not name.endswith(EXTENSIONS):
                continue
            path = os.path.join(deps, name)
            h = hashlib.sha256()
            with open(path, "rb") as fh:
                for chunk in iter(lambda: fh.read(1 << 20), b""):
                    h.update(chunk)
            entries.append((mozpath.relpath(path, topobjdir), h.hexdigest()))

    with open(args.output, "w") as fh:
        for path, digest in sorted(entries):
            fh.write(f"{digest}  {path}\n")
    print(f"Hashed {len(entries)} Rust artifacts into {args.output}")


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
