# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

"""
Sphinx extension that adds a ``js:autotypedef`` directive, which shows the
properties of one or more JSDoc typedefs as a single table. A typedef that
intersects other typedefs, such as ``A & B``, lists the properties of each.
"""

import re
from os.path import join, relpath

from docutils import nodes
from docutils.parsers.rst import Directive
from sphinx_js.parsers import PathVisitor, path_and_formal_params
from sphinx_js.suffix_tree import SuffixAmbiguous, SuffixNotFound

HEADERS = ("Property", "Type", "Required", "Description")
COLUMN_WIDTHS = (2, 2, 1, 5)


def lookup_typedef(analyzer, name):
    """Returns the jsdoc doclet for the typedef with the given name."""
    if not re.fullmatch(r"[\w.]+", name):
        raise SuffixNotFound([name])
    path = PathVisitor().visit(path_and_formal_params["path"].parse(name))
    doclet = analyzer._doclets_by_path.get(path)
    if doclet.get("kind") != "typedef":
        raise SuffixNotFound(path)
    return doclet


def typedef_doclets(analyzer, name):
    """Returns the doclets whose properties make up the named typedef.

    An intersection typedef has no properties of its own, so the doclets of
    the typedefs it intersects are returned in its place.
    """
    doclet = lookup_typedef(analyzer, name)
    names = doclet.get("type", {}).get("names", [])
    if doclet.get("properties") or len(names) != 1 or "&" not in names[0]:
        return [doclet]
    doclets = []
    for part in names[0].split("&"):
        doclets.extend(typedef_doclets(analyzer, part.strip()))
    return doclets


def merge_property(props, prop):
    """Adds the property to the dict keyed by name.

    A repeated name keeps the first type and description and is required if
    any of its typedefs requires it.
    """
    existing = props.get(prop["name"])
    if existing is None:
        props[prop["name"]] = dict(prop)
    elif not prop.get("optional"):
        existing["optional"] = False


def format_type(prop):
    """Returns the property's type as text, such as ``string[]``."""
    names = prop.get("type", {}).get("names", [])
    return " | ".join(
        re.sub(r"^Array\.<(.+)>$", r"\1[]", n).replace(".<", "<") for n in names
    )


def make_row(cells):
    """Returns a table row with one entry per list of inline nodes."""
    row = nodes.row()
    for cell in cells:
        row += nodes.entry("", nodes.paragraph("", "", *cell))
    return row


class AutoTypedefDirective(Directive):
    required_arguments = 1
    optional_arguments = 10

    def run(self):
        env = self.state.document.settings.env
        analyzer = env.app._sphinxjs_analyzer

        props = {}
        for name in self.arguments:
            try:
                doclets = typedef_doclets(analyzer, name)
            except (SuffixNotFound, SuffixAmbiguous):
                raise self.error(f"No unique JSDoc typedef named {name!r} was found.")
            for doclet in doclets:
                meta = doclet["meta"]
                env.note_dependency(
                    relpath(join(meta["path"], meta["filename"]), env.app.srcdir)
                )
                for prop in doclet.get("properties") or []:
                    merge_property(props, prop)

        tgroup = nodes.tgroup(cols=len(HEADERS))
        for width in COLUMN_WIDTHS:
            tgroup += nodes.colspec(colwidth=width)
        tgroup += nodes.thead("", make_row([[nodes.Text(h)] for h in HEADERS]))
        tbody = nodes.tbody()
        messages = []
        for prop in props.values():
            type_text = format_type(prop)
            description = " ".join(prop.get("description", "").split())
            description_nodes, description_messages = self.state.inline_text(
                description, self.lineno
            )
            messages.extend(description_messages)
            tbody += make_row([
                [nodes.literal(prop["name"], prop["name"])],
                [nodes.literal(type_text, type_text)],
                [nodes.Text("no" if prop.get("optional") else "yes")],
                description_nodes,
            ])
        tgroup += tbody
        return [nodes.table("", tgroup), *messages]


def setup(app):
    app.add_directive_to_domain("js", "autotypedef", AutoTypedefDirective)
    return {"parallel_read_safe": True}
