# Any copyright is dedicated to the Public Domain.
# http://creativecommons.org/publicdomain/zero/1.0/

import fluent.syntax.ast as FTL
from fluent.migrate import CONCAT, COPY, REPLACE
from fluent.migrate.helpers import VARIABLE_REFERENCE, transforms_from


def NUMBER(name, **options):
    return FTL.FunctionReference(
        id=FTL.Identifier("NUMBER"),
        arguments=FTL.CallArguments(
            positional=[VARIABLE_REFERENCE(name)],
            named=[
                FTL.NamedArgument(
                    name=FTL.Identifier(key), value=FTL.NumberLiteral(value)
                )
                for key, value in options.items()
            ],
        ),
    )


def migrate(ctx):
    """Bug 2098231 - Migrate devtools animation inspector strings to Fluent, part {index}."""

    source = "devtools/client/animationinspector.properties"
    target = "devtools/client/animation-inspector.ftl"
    ctx.add_transforms(
        target,
        target,
        transforms_from(
            """
animation-inspector-no-animation = { COPY(from_path, "panel.noAnimation") }
animation-inspector-running-on-compositor = { COPY(from_path, "player.runningOnCompositorTooltip") }
animation-inspector-all-properties-on-compositor = { COPY(from_path, "player.allPropertiesOnCompositorTooltip") }
animation-inspector-some-properties-on-compositor = { COPY(from_path, "player.somePropertiesOnCompositorTooltip") }
animation-inspector-script-animation-unnamed = { COPY(from_path, "timeline.scriptanimation.unnamedLabel") }
animation-inspector-infinity = { COPY(from_path, "player.infiniteDurationText") }
animation-inspector-resume-button-title = { COPY(from_path, "timeline.pausedButtonTooltip") }
animation-inspector-pause-button-title = { COPY(from_path, "timeline.resumedButtonTooltip") }
animation-inspector-rewind-button-title = { COPY(from_path, "timeline.rewindButtonTooltip") }
""",
            from_path=source,
        ),
    )

    def message(message_id, value):
        return FTL.Message(id=FTL.Identifier(message_id), value=value)

    # The code used to join these labels and their values with a space.
    def label(message_id, key, variable):
        return message(
            message_id,
            CONCAT(
                COPY(source, key),
                FTL.TextElement(" "),
                FTL.Placeable(VARIABLE_REFERENCE(variable)),
            ),
        )

    def replace(message_id, key, replacements):
        return message(message_id, REPLACE(source, key, replacements))

    ctx.add_transforms(
        target,
        target,
        [
            label(
                "animation-inspector-tooltip-duration",
                "player.animationDurationLabel",
                "duration",
            ),
            label(
                "animation-inspector-tooltip-delay",
                "player.animationDelayLabel",
                "delay",
            ),
            label(
                "animation-inspector-tooltip-end-delay",
                "player.animationEndDelayLabel",
                "endDelay",
            ),
            label(
                "animation-inspector-tooltip-playback-rate",
                "player.animationRateLabel",
                "rate",
            ),
            label(
                "animation-inspector-tooltip-iteration-count",
                "player.animationIterationCountLabel",
                "count",
            ),
            label(
                "animation-inspector-tooltip-overall-easing",
                "player.animationOverallEasingLabel",
                "easing",
            ),
            label(
                "animation-inspector-tooltip-timing-function",
                "player.animationTimingFunctionLabel",
                "timingFunction",
            ),
            label(
                "animation-inspector-tooltip-fill",
                "player.animationFillLabel",
                "fill",
            ),
            label(
                "animation-inspector-tooltip-direction",
                "player.animationDirectionLabel",
                "direction",
            ),
            replace(
                "animation-inspector-tooltip-iteration-start",
                "player.animationIterationStartLabel2",
                {
                    "%1$S": VARIABLE_REFERENCE("iterationStart"),
                    "%2$S": VARIABLE_REFERENCE("time"),
                },
            ),
            replace(
                "animation-inspector-css-animation-name",
                "timeline.cssanimation.nameLabel",
                {"%1$S": VARIABLE_REFERENCE("name")},
            ),
            replace(
                "animation-inspector-css-transition-name",
                "timeline.csstransition.nameLabel",
                {"%1$S": VARIABLE_REFERENCE("name")},
            ),
            replace(
                "animation-inspector-script-animation-name",
                "timeline.scriptanimation.nameLabel",
                {"%1$S": VARIABLE_REFERENCE("name")},
            ),
            replace(
                "animation-inspector-time-seconds",
                "player.timeLabel",
                {"%1$S": NUMBER("time", maximumFractionDigits="2")},
            ),
            replace(
                "animation-inspector-timeline-seconds",
                "player.timeLabel",
                {
                    "%1$S": NUMBER(
                        "time", minimumFractionDigits="1", maximumFractionDigits="1"
                    )
                },
            ),
            replace(
                "animation-inspector-timeline-milliseconds",
                "timeline.timeGraduationLabel",
                {"%1$S": NUMBER("time", maximumFractionDigits="0")},
            ),
            replace(
                "animation-inspector-playback-rate",
                "player.playbackRateLabel",
                {"%1$S": VARIABLE_REFERENCE("rate")},
            ),
            replace(
                "animation-inspector-percentage",
                "detail.propertiesHeader.percentage",
                {"%1$S": VARIABLE_REFERENCE("percentage")},
            ),
        ],
    )
