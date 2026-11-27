# Any copyright is dedicated to the Public Domain.
# http://creativecommons.org/publicdomain/zero/1.0/

import fluent.syntax.ast as FTL
from fluent.migrate.helpers import VARIABLE_REFERENCE
from fluent.migrate.transforms import COPY, REPLACE


def platform_selector(mac_value, other_value):
    return FTL.Pattern(
        elements=[
            FTL.Placeable(
                expression=FTL.SelectExpression(
                    selector=FTL.FunctionReference(
                        id=FTL.Identifier("PLATFORM"), arguments=FTL.CallArguments()
                    ),
                    variants=[
                        FTL.Variant(key=FTL.Identifier("macos"), value=mac_value),
                        FTL.Variant(
                            key=FTL.Identifier("other"),
                            value=other_value,
                            default=True,
                        ),
                    ],
                )
            )
        ]
    )


def migrate(ctx):
    """Bug 2095010 - Migrate accessible.properties to Fluent, part {index}."""

    mac = "dom/chrome/accessibility/mac/accessible.properties"
    win = "dom/chrome/accessibility/win/accessible.properties"
    unix = "dom/chrome/accessibility/unix/accessible.properties"
    target = "dom/dom/accessible.ftl"

    def message(l10n_id, value):
        return FTL.Message(id=FTL.Identifier(l10n_id), value=value)

    actions = [
        ("a11y-action-jump", "jump"),
        ("a11y-action-press", "press"),
        ("a11y-action-check", "check"),
        ("a11y-action-uncheck", "uncheck"),
        ("a11y-action-select", "select"),
        ("a11y-action-open", "open"),
        ("a11y-action-close", "close"),
        ("a11y-action-switch", "switch"),
        ("a11y-action-click", "click"),
        ("a11y-action-collapse", "collapse"),
        ("a11y-action-expand", "expand"),
        ("a11y-action-activate", "activate"),
        ("a11y-action-cycle", "cycle"),
        ("a11y-action-click-ancestor", "clickAncestor"),
    ]

    mac_only = [
        ("a11y-landmark-main", "main"),
        ("a11y-landmark-navigation", "navigation"),
        ("a11y-landmark-search", "search"),
        ("a11y-role-html-content", "htmlContent"),
        ("a11y-role-application", "application"),
        ("a11y-role-tab", "tab"),
        ("a11y-role-term", "term"),
        ("a11y-role-definition", "definition"),
        ("a11y-role-search-text-field", "searchTextField"),
        ("a11y-role-date-field", "dateField"),
        ("a11y-role-alert", "alert"),
        ("a11y-role-alert-dialog", "alertDialog"),
        ("a11y-role-dialog", "dialog"),
        ("a11y-role-article", "article"),
        ("a11y-role-document", "document"),
        ("a11y-role-figure", "figure"),
        ("a11y-role-heading", "heading"),
        ("a11y-role-log", "log"),
        ("a11y-role-marquee", "marquee"),
        ("a11y-role-math", "math"),
        ("a11y-role-note", "note"),
        ("a11y-role-status", "status"),
        ("a11y-role-timer", "timer"),
        ("a11y-role-tooltip", "tooltip"),
        ("a11y-role-separator", "separator"),
        ("a11y-role-tab-panel", "tabPanel"),
        ("a11y-role-highlight", "highlight"),
        ("a11y-role-details", "details"),
        ("a11y-role-summary", "summary"),
    ]

    ctx.add_transforms(
        target,
        target,
        [message(l10n_id, COPY(win, key)) for l10n_id, key in actions]
        + [
            message("a11y-landmark-banner", COPY(win, "banner")),
            message("a11y-landmark-complementary", COPY(win, "complementary")),
            message(
                "a11y-landmark-content-info",
                platform_selector(COPY(mac, "content"), COPY(win, "contentinfo")),
            ),
            message("a11y-landmark-region", COPY(win, "region")),
            message("a11y-role-section-footer", COPY(win, "sectionfooter")),
            message("a11y-role-section-header", COPY(win, "sectionheader")),
        ]
        + [message(l10n_id, COPY(mac, key)) for l10n_id, key in mac_only]
        + [
            message(
                "a11y-input-color-value",
                REPLACE(
                    unix,
                    "inputColorValue",
                    {
                        "%1$S": VARIABLE_REFERENCE("red"),
                        "%2$S": VARIABLE_REFERENCE("green"),
                        "%3$S": VARIABLE_REFERENCE("blue"),
                    },
                ),
            ),
        ],
    )
