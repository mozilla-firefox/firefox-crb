# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

import os
import sys

import mozunit

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import token_resolve  # noqa: E402

LAYERS = "@layer tokens-foundation, tokens-foundation-nova;\n"


def write_sheets(directory, foundation, nova=""):
    shared = f"{LAYERS}:root {{\n  @layer tokens-foundation {{\n{foundation}\n  }}\n"
    if nova:
        shared += (
            '  @media -moz-pref("browser.nova.enabled") {\n'
            f"    @layer tokens-foundation-nova {{\n{nova}\n    }}\n  }}\n"
        )
    shared += "}\n"
    (directory / "tokens-shared.css").write_text(shared)
    for name in ("tokens-platform.css", "tokens-brand.css"):
        (directory / name).write_text(":root {\n}\n")
    return str(directory)


def test_resolving_tokens_pass(tmp_path, capsys):
    directory = write_sheets(tmp_path, "--a: #fff;\n--b: var(--a);")
    assert token_resolve.check(directory) == 0
    assert capsys.readouterr().out == "every token resolves\n"


def test_bare_keyword_passes(tmp_path):
    directory = write_sheets(tmp_path, "--a: unset;\n--b: var(--a);")
    assert token_resolve.check(directory) == 0


def test_cycle_fails(tmp_path, capsys):
    directory = write_sheets(tmp_path, "--a: var(--b);\n--b: var(--a);")
    assert token_resolve.check(directory) == 1
    assert "--a in chrome: a var() cycle\n" in capsys.readouterr().out


def test_depth_limit_fails(tmp_path, capsys):
    chain = "\n".join(f"--t{i}: var(--t{i + 1});" for i in range(40))
    directory = write_sheets(tmp_path, f"{chain}\n--t40: #fff;")
    assert token_resolve.check(directory) == 1
    assert (
        "--t0 in chrome: more than 32 nested var() references\n"
        in capsys.readouterr().out
    )


def test_undefined_reference_fails(tmp_path, capsys):
    directory = write_sheets(tmp_path, "--a: var(--fake-var);")
    assert token_resolve.check(directory) == 1
    assert "--a in chrome: `--fake-var` is undefined\n" in capsys.readouterr().out


def test_undefined_reference_with_fallback_passes(tmp_path):
    directory = write_sheets(tmp_path, "--a: var(--fake-var, #fff);")
    assert token_resolve.check(directory) == 0


def test_keyword_inside_function_fails(tmp_path, capsys):
    directory = write_sheets(
        tmp_path, "--ghost: inherit;\n--a: light-dark(var(--ghost), #fff);"
    )
    assert token_resolve.check(directory) == 1
    assert (
        "--a in chrome: `inherit` inside light-dark(), from --ghost: inherit\n"
        "  declared as: light-dark(var(--ghost), #fff)\n"
        "  resolves to: light-dark(inherit, #fff)\n"
    ) in capsys.readouterr().out


def test_nova_reference_to_inherit_token_fails(tmp_path, capsys):
    directory = write_sheets(
        tmp_path,
        "--button-text-color: currentColor;\n"
        "--button-text-color-hover: var(--button-text-color);\n"
        "--button-text-color-ghost-hover: inherit;\n"
        "--button-text-color-menu-hover: var(--button-text-color-ghost-hover);",
        "--button-text-color-menu-hover: light-dark("
        "var(--button-text-color-ghost-hover), var(--button-text-color-hover));",
    )
    assert token_resolve.check(directory) == 1
    out = capsys.readouterr().out
    assert (
        "--button-text-color-menu-hover in chrome: `inherit` inside light-dark(),"
        " from --button-text-color-ghost-hover: inherit\n"
        "  declared as: light-dark(var(--button-text-color-ghost-hover),"
        " var(--button-text-color-hover))\n"
        "  resolves to: light-dark(inherit, currentColor)\n"
        "  wins in: default\n"
    ) in out
    assert "browser.nova.enabled=false" not in out


def test_cycle_does_not_blame_a_keyword_token(tmp_path, capsys):
    directory = write_sheets(
        tmp_path, "--k: inherit;\n--a: var(--b) var(--k);\n--b: var(--a);"
    )
    assert token_resolve.check(directory) == 1
    assert "--a in chrome: a var() cycle\n" in capsys.readouterr().out


def test_important_declaration_reported_once(tmp_path, capsys):
    directory = write_sheets(
        tmp_path,
        "--ghost: inherit;\n--a: light-dark(var(--ghost), #fff) !important;",
    )
    assert token_resolve.check(directory) == 1
    out = capsys.readouterr().out
    assert out.count("--a in chrome:") == 1
    assert out.count("--a in in-content:") == 1


if __name__ == "__main__":
    mozunit.main()
