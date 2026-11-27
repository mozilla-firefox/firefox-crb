# Any copyright is dedicated to the Public Domain.
# http://creativecommons.org/publicdomain/zero/1.0/

from fluent.migrate.helpers import transforms_from


def migrate(ctx):
    """Bug 2098612 - Migrate taskbar.properties to Fluent, part {index}."""

    source = "browser/chrome/browser/taskbar.properties"
    target = "browser/browser/jumpLists.ftl"
    ctx.add_transforms(
        target,
        target,
        transforms_from(
            """
jump-list-task-new-tab =
    .label = {COPY(from_path, "taskbar.tasks.newTab.label")}
    .description = {COPY(from_path, "taskbar.tasks.newTab.description")}
jump-list-task-new-window =
    .label = {COPY(from_path, "taskbar.tasks.newWindow.label")}
    .description = {COPY(from_path, "taskbar.tasks.newWindow.description")}
jump-list-task-new-private-window =
    .label = {COPY(from_path, "taskbar.tasks.newPrivateWindow.label")}
    .description = {COPY(from_path, "taskbar.tasks.newPrivateWindow.description")}
jump-list-frequent = {COPY(from_path, "taskbar.frequent.label")}
""",
            from_path=source,
        ),
    )
