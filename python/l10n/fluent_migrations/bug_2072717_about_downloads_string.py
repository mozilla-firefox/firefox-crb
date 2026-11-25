# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

from fluent.migrate import COPY_PATTERN
from fluent.migrate.helpers import transforms_from


def migrate(ctx):
    """Bug 2072717 - Move about:downloads string to be compatible with the HTML implementation, part {index}."""

    path = "browser/browser/downloads.ftl"

    ctx.add_transforms(
        path,
        path,
        transforms_from(
            """
about-downloads-title = {COPY_PATTERN(from_path, "downloads-window.title")}
""",
            from_path=path,
        ),
    )
