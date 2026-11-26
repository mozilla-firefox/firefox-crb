# Releasing mozbase packages

Mozbase packages are released to [PyPI] manually. To release a package, bump
its `PACKAGE_VERSION` in `setup.py`, land the change, and run the release
script once the change is on `main`.

## Checking version bumps

`testing/mozbase/semver_check.py` compares each package whose in-tree version
is not on PyPI yet against its latest stable release on PyPI, and fails when
the version bump is too small for the changes, following [Semantic Versioning]:

| Change | Required bump |
|---|---|
| Removed public module, class, function, method or attribute | major |
| Removed, moved or renamed parameter, or new required parameter | major |
| Removed console script | major |
| New public module, class, function, method, attribute or optional parameter | minor |
| New console script or command line option | minor |
| New runtime dependency, or raised minimum version of a dependency | minor |
| Raised minimum Python version, or new or lowered upper bound | minor |
| Changed implementation, removed dependency, or relaxed requirements | patch |

The public API is analysed statically with [Griffe]. A name is public when it
is listed in the module's `__all__`, or, without `__all__`, when it doesn't
start with an underscore. Changes that can't be classified reliably, like
changed default values, attribute values or type annotations, removed command
line options, or changed environment markers, are listed for a manual review
and don't count towards the required bump. Behavior changes in existing
functions can't be detected at all.

Raising the minimum Python version only requires a minor bump, because pip
keeps installing the latest compatible release on older Python versions.

For 0.x versions bumping `0.y` covers breaking changes, and bumping `0.y.z`
covers everything else. Pre-releases and development versions are judged by
their base release, and only stable releases are used for the comparison. A
package without an earlier stable release counts as an initial release.

Run the check locally with:

```shell
./mach python --virtualenv python-test testing/mozbase/semver_check.py [PACKAGE ...]
```

It also runs in CI as the `mb-semver` job whenever files in `testing/mozbase`
change. Packages whose version is already released are skipped, so ordinary
changes don't need a version bump.

### Exceptions

To ignore a false positive, add an entry with a reason to
`testing/mozbase/semver-exceptions.toml`. An exception only applies to the
given version of the package, and gets reported as outdated once that version
is released:

```toml
[[exception]]
package = "mozlog"
version = "9.0.2"
kind = "OBJECT_REMOVED"
path = "mozlog.formatters.*"
reason = "Only used internally by mozharness, see bug NNNNNN."
```

`kind` and `path` are optional. Use the kind shown in brackets in the check's
output, and `path` supports wildcards.

## Uploading packages

`testing/mozbase/release.py` releases all packages whose in-tree version is not
on PyPI yet:

- Packages are uploaded in dependency order, and a package whose dependencies
  can't be satisfied by PyPI gets skipped.
- Each package is built from the commit that bumped its version, so changes
  that landed afterwards are not shipped. The script lists those changes, and
  they need another version bump.
- The version bump of each package is verified with `semver_check.py` before
  the upload.

PyPI is the only state, so after a failure the script can simply be run again.
Without `--upload` it only shows what it would do:

```shell
./mach python --virtualenv python-test testing/mozbase/release.py
./mach python --virtualenv python-test testing/mozbase/release.py --upload
```

Uploading needs [uv] and [twine] in the `PATH`, and an API token for PyPI in
`~/.pypirc`.

[griffe]: https://mkdocstrings.github.io/griffe/
[pypi]: https://pypi.org/
[semantic versioning]: https://semver.org/
[twine]: https://twine.readthedocs.io/
[uv]: https://docs.astral.sh/uv/
