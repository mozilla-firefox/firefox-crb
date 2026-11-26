# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

import os
import re
import shutil
import subprocess
import sys

ADVICE = """\
If you get failures above, please file a bug describing the error
and your environment (compiler and linker versions), and
provide the pre-elfhacked library as an attachment.
Use --disable-elf-hack until this is fixed."""


class ElfhackCheckError(Exception):
    pass


def _relocations(readelf, library):
    return len(
        subprocess.check_output([readelf, "-r", library], text=True).splitlines()
    )


def _elfhack(readelf, elfhack, library, dynamic_tag, workdir):
    # Fail if the library doesn't have the dynamic tag in its .dynamic info
    dynamic = subprocess.check_output([readelf, "-d", library], text=True)
    if not re.search(rf"\b{dynamic_tag}\b", dynamic):
        raise ElfhackCheckError(f"{library} has no {dynamic_tag} .dynamic entry")
    hacked = os.path.join(workdir, os.path.basename(library))
    shutil.copy(library, hacked)
    subprocess.check_call([elfhack, "-b", "-f", hacked])
    # Fail if the backup file doesn't exist
    backup = f"{hacked}.bak"
    if not os.path.exists(backup):
        raise ElfhackCheckError(f"elfhack did not write {backup}")
    # Fail if the new library doesn't contain less relocations
    if _relocations(readelf, backup) <= _relocations(readelf, hacked):
        raise ElfhackCheckError(f"elfhack did not remove relocations from {library}")
    return hacked


def main(output, array, ctors, elfhack, *args):
    *dummy, readelf = args
    workdir = f"{output.name}.libs"
    try:
        if os.path.exists(workdir):
            shutil.rmtree(workdir)
        os.makedirs(workdir)
        for library, dynamic_tag in ((array, "INIT_ARRAY"), (ctors, "INIT")):
            hacked = _elfhack(
                readelf, os.path.abspath(elfhack), library, dynamic_tag, workdir
            )
            # Will either crash or return exit code 1 if elfhack is broken
            preload = os.path.abspath(hacked)
            for program in dummy:
                try:
                    subprocess.check_call(
                        [os.path.abspath(program)],
                        env={**os.environ, "LD_PRELOAD": preload},
                    )
                except subprocess.CalledProcessError as e:
                    raise ElfhackCheckError(f"{e} with LD_PRELOAD={preload}") from e
    except (OSError, subprocess.CalledProcessError, ElfhackCheckError) as e:
        print(e, file=sys.stderr)
        print(ADVICE, file=sys.stderr)
        return 1
    return 0
