# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

## Actions provided to accessibility clients such as screen readers. They are
## exposed as the localized names of the actions that can be performed on an
## element.

a11y-action-jump = Jump
a11y-action-press = Press
a11y-action-check = Check
a11y-action-uncheck = Uncheck
a11y-action-select = Select
a11y-action-open = Open
a11y-action-close = Close
a11y-action-switch = Switch
a11y-action-click = Click
a11y-action-collapse = Collapse
a11y-action-expand = Expand
a11y-action-activate = Activate
a11y-action-cycle = Cycle
# An action provided to accessibility clients such as screen readers to allow
# them to click an element when the click will be handled by a container
# (ancestor) element. This is not normally reported to users.
a11y-action-click-ancestor = Click ancestor

## These messages are reported by accessibility clients such as screen readers to
## indicate landmarks, which are significant sections of a document to which
## users might want to navigate quickly. See this page for more information:
## https://www.w3.org/WAI/ARIA/apg/patterns/landmarks/examples/general-principles.html

a11y-landmark-banner = banner
a11y-landmark-complementary = complementary
a11y-landmark-content-info =
    { PLATFORM() ->
        [macos] content
       *[other] content information
    }
a11y-landmark-region = region
a11y-landmark-main = main
a11y-landmark-navigation = navigation
a11y-landmark-search = search
# The role description for a section footer.
a11y-role-section-footer = section footer
# The role description for a section header.
a11y-role-section-header = section header

## Role descriptions spoken by screen readers on macOS (VoiceOver).

# The role description for the web content area.
a11y-role-html-content = HTML Content
# The role description for a web application, or for the WAI-ARIA application landmark.
a11y-role-application = application
a11y-role-tab = tab
# The role description for a term in a definition list (HTML dt element).
a11y-role-term = term
# The role description for a definition in a definition list (HTML dd element).
a11y-role-definition = definition
# The role description for a search text field (HTML input type="search").
a11y-role-search-text-field = search text field
a11y-role-date-field = date field
a11y-role-alert = alert
a11y-role-alert-dialog = alert dialog
a11y-role-dialog = dialog
a11y-role-article = article
a11y-role-document = document
# https://w3c.github.io/aria/core-aam/core-aam.html#role-map-figure
a11y-role-figure = figure
# https://w3c.github.io/aria/core-aam/core-aam.html#role-map-heading
a11y-role-heading = heading
a11y-role-log = log
a11y-role-marquee = marquee
a11y-role-math = math
a11y-role-note = note
a11y-role-status = application status
a11y-role-timer = timer
a11y-role-tooltip = tooltip
a11y-role-separator = separator
a11y-role-tab-panel = tab panel
# The role description for the HTML mark element.
a11y-role-highlight = highlight
# The role description for the HTML details element.
a11y-role-details = details
# The role description for the HTML summary element.
a11y-role-summary = summary

## Values reported to accessibility clients.

# Variables:
#   $red (Number) - Red component of the color, as a percentage.
#   $green (Number) - Green component of the color, as a percentage.
#   $blue (Number) - Blue component of the color, as a percentage.
a11y-input-color-value = { $red }% red { $green }% green { $blue }% blue
