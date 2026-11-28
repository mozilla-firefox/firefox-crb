# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

import mozunit
from conftest import build
from mozlint.result import ResultSummary

LINTER = "android-lint"


def test_only_error_severities_fail(config, tmp_path, monkeypatch):
    import android.lints

    monkeypatch.setattr(android.lints, "gradle", lambda *args, **kwargs: 0)
    issues = "".join(
        f'<issue id="{s}" severity="{s}" message="m"><location file="{build.topsrcdir}/F.java" line="1"/></issue>'
        for s in ("Fatal", "Error", "Warning", "Hint")
    )
    (tmp_path / "lint.xml").write_text(f"<issues>{issues}</issues>")
    ResultSummary.root = build.topsrcdir

    results = android.lints.lint(
        [],
        config,
        log=None,
        root=build.topsrcdir,
        topobjdir=str(tmp_path),
        substs={
            "GRADLE_ANDROID_LINT_TASKS": [],
            "GRADLE_ANDROID_LINT_REPORTS": ["lint.xml"],
        },
    )
    assert [(r.rule, r.level) for r in results] == [
        ("Fatal", "error"),
        ("Error", "error"),
        ("Warning", "warning"),
        ("Hint", "warning"),
    ]


if __name__ == "__main__":
    mozunit.main()
