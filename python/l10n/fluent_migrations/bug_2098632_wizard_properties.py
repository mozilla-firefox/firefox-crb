# Any copyright is dedicated to the Public Domain.
# http://creativecommons.org/publicdomain/zero/1.0/

import fluent.syntax.ast as FTL
from fluent.migrate.helpers import VARIABLE_REFERENCE, transforms_from
from fluent.migrate.transforms import REPLACE


def migrate(ctx):
    """Bug 2098632 - Migrate wizard.properties to Fluent, part {index}."""

    source = "toolkit/chrome/global/wizard.properties"
    target = "toolkit/toolkit/global/wizard.ftl"
    ctx.add_transforms(
        target,
        target,
        [
            FTL.Message(
                id=FTL.Identifier("wizard-default-first-title"),
                value=REPLACE(
                    source,
                    "default-first-title",
                    {"%1$S": VARIABLE_REFERENCE("title")},
                ),
            ),
            FTL.Message(
                id=FTL.Identifier("wizard-default-last-title"),
                value=REPLACE(
                    source,
                    "default-last-title",
                    {"%1$S": VARIABLE_REFERENCE("title")},
                ),
            ),
        ]
        + transforms_from(
            """
wizard-macos-default-first-title = { COPY(from_path, "default-first-title-mac") }
wizard-macos-default-last-title = { COPY(from_path, "default-last-title-mac") }
""",
            from_path=source,
        ),
    )
