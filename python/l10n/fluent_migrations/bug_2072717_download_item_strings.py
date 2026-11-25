# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

from fluent.migrate import COPY_PATTERN
from fluent.migrate.helpers import transforms_from


def migrate(ctx):
    """Bug 2072717 - Move download item strings to be compatible with the HTML implementation, part {index}."""

    path = "browser/browser/downloads.ftl"

    ctx.add_transforms(
        path,
        path,
        transforms_from(
            """
downloads-cmd-show-description-3 = {COPY_PATTERN(from_path, "downloads-cmd-show-description-2.value")}

downloads-show-more-information-2 = {COPY_PATTERN(from_path, "downloads-show-more-information.value")}

downloads-open-file-2 = {COPY_PATTERN(from_path, "downloads-open-file.value")}

downloading-file-opens-in-hours-and-minutes-3 = {COPY_PATTERN(from_path, "downloading-file-opens-in-hours-and-minutes-2.value")}
downloading-file-opens-in-minutes-3 = {COPY_PATTERN(from_path, "downloading-file-opens-in-minutes-2.value")}
downloading-file-opens-in-minutes-and-seconds-3 = {COPY_PATTERN(from_path, "downloading-file-opens-in-minutes-and-seconds-2.value")}
downloading-file-opens-in-seconds-3 = {COPY_PATTERN(from_path, "downloading-file-opens-in-seconds-2.value")}
downloading-file-opens-in-some-time-3 = {COPY_PATTERN(from_path, "downloading-file-opens-in-some-time-2.value")}
downloading-file-click-to-open-2 = {COPY_PATTERN(from_path, "downloading-file-click-to-open.value")}

downloads-retry-download-2 = {COPY_PATTERN(from_path, "downloads-retry-download.value")}
downloads-cancel-download-2 = {COPY_PATTERN(from_path, "downloads-cancel-download.value")}
""",
            from_path=path,
        ),
    )
