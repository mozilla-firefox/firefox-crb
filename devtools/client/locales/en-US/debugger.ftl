# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

### These strings are used in the context menus of the Debugger.
### A condition is an expression that must be true for a breakpoint to pause.
### A log is a log point, a breakpoint that logs a message to the console
### instead of pausing.
### “Ignore” makes the Debugger skip a source or some lines, so that it never
### pauses in them.

## Context menu of a breakpoint in the Breakpoints pane.
## “Others” refers to all breakpoints except the selected one.

debugger-breakpoint-remove =
    .label = Remove
    .accesskey = R
debugger-breakpoint-remove-all =
    .label = Remove all
    .accesskey = a
debugger-breakpoint-remove-others =
    .label = Remove others
    .accesskey = h
debugger-breakpoint-enable =
    .label = Enable
    .accesskey = E
debugger-breakpoint-enable-all =
    .label = Enable all
    .accesskey = b
debugger-breakpoint-enable-others =
    .label = Enable others
    .accesskey = o
debugger-breakpoint-disable =
    .label = Disable
    .accesskey = D
debugger-breakpoint-disable-all =
    .label = Disable all
    .accesskey = k
debugger-breakpoint-disable-others =
    .label = Disable others
    .accesskey = s
debugger-breakpoint-remove-condition =
    .label = Remove condition
    .accesskey = c
debugger-breakpoint-add-condition =
    .label = Add condition
    .accesskey = c
debugger-breakpoint-edit-condition =
    .label = Edit condition
    .accesskey = n

## Shared by the breakpoint context menus of the Breakpoints pane and the
## editor gutter.
## “Never pause here” is shown for a debugger statement, and makes it stop
## pausing. “Pause here” makes it pause again.

debugger-pause-here =
    .label = Pause here
    .accesskey = P
debugger-never-pause-here =
    .label = Never pause here
    .accesskey = p
debugger-add-log-point =
    .label = Add log
    .accesskey = l
debugger-edit-log-point =
    .label = Edit log
    .accesskey = t
debugger-remove-log-point =
    .label = Remove log
    .accesskey = V

## Context menu of the editor gutter, for the clicked line.

debugger-editor-add-breakpoint =
    .label = Add breakpoint
    .accesskey = B
debugger-editor-remove-breakpoint =
    .label = Remove breakpoint
    .accesskey = B
debugger-editor-add-condition =
    .label = Add condition
    .accesskey = c
debugger-editor-edit-condition =
    .label = Edit condition
    .accesskey = c
debugger-editor-enable-breakpoint =
    .label = Enable breakpoint
    .accesskey = D
debugger-editor-disable-breakpoint =
    .label = Disable breakpoint
    .accesskey = D
debugger-editor-remove-breakpoints-on-line =
    .label = Remove breakpoints on line
    .accesskey = X
debugger-editor-enable-breakpoints-on-line =
    .label = Enable breakpoints on line
    .accesskey = o
debugger-editor-disable-breakpoints-on-line =
    .label = Disable breakpoints on line
    .accesskey = K
# Resume execution until it reaches the line.
debugger-editor-continue-to-here =
    .label = Continue to here
    .accesskey = H
debugger-editor-ignore-line =
    .label = Ignore line
    .accesskey = g
debugger-editor-unignore-line =
    .label = Unignore line
    .accesskey = n

## Context menu of the editor, for the selected text or lines.
## For sources with a source map, “original” is the source code as written,
## and “generated” is the code that actually runs in the browser, for example
## after compiling or minifying it.
## The inline preview shows the values of variables next to the code while
## execution is paused.

debugger-editor-copy-to-clipboard =
    .label = Copy to clipboard
    .accesskey = C
debugger-editor-ignore-lines =
    .label = Ignore lines
    .accesskey = g
debugger-editor-unignore-lines =
    .label = Unignore lines
    .accesskey = n
debugger-editor-jump-to-generated-location =
    .label = Jump to generated location
    .accesskey = m
debugger-editor-jump-to-original-location =
    .label = Jump to original location
    .accesskey = m
debugger-editor-add-watch-expression =
    .label = Add watch expression
    .accesskey = e
debugger-editor-evaluate-in-console =
    .label = Evaluate in console
    .accesskey = v
debugger-editor-show-inline-preview =
    .label = Show inline preview
    .accesskey = p
debugger-editor-hide-inline-preview =
    .label = Hide inline preview
    .accesskey = p
debugger-editor-wrap-lines =
    .label = Wrap lines
    .accesskey = W
debugger-editor-unwrap-lines =
    .label = Unwrap lines
    .accesskey = w

## Shared by the context menus of the editor, the source tabs and the Sources
## pane.

debugger-copy-source =
    .label = Copy source text
    .accesskey = y
debugger-copy-source-uri =
    .label = Copy source URI
    .accesskey = s
# Select the source in the Sources pane.
debugger-reveal-in-tree =
    .label = Reveal in tree
    .accesskey = r
debugger-ignore-source =
    .label = Ignore source
    .accesskey = I
debugger-unignore-source =
    .label = Unignore source
    .accesskey = U
debugger-download-file =
    .label = Download file
    .accesskey = d

## Context menu of a source tab.

debugger-tab-close =
    .label = Close tab
    .accesskey = c
debugger-tab-close-others =
    .label = Close other tabs
    .accesskey = o
debugger-tab-close-to-end =
    .label = Close tabs to the right
    .accesskey = e
debugger-tab-close-all =
    .label = Close all tabs
    .accesskey = a
debugger-tab-unignore-source =
    .label = Unignore source
    .accesskey = I
# Pretty printing reformats minified code to make it readable.
debugger-tab-pretty-print =
    .label = Pretty print source
    .accesskey = p

## Context menu of an item in the Sources pane.
## A script override replaces the source with a local file.
## “Collapse all” and “Expand all” apply to the directory and all of its
## subdirectories.
## Setting a directory as root makes the Sources pane show only that directory
## and its contents.

debugger-source-tree-add-override =
    .label = Add script override
    .accesskey = o
debugger-source-tree-remove-override =
    .label = Remove script override
    .accesskey = o
debugger-source-tree-collapse-all =
    .label = Collapse all
    .accesskey = c
debugger-source-tree-expand-all =
    .label = Expand all
    .accesskey = e
debugger-source-tree-set-directory-root =
    .label = Set directory root
    .accesskey = r
debugger-source-tree-remove-directory-root =
    .label = Remove directory root
    .accesskey = R

## “Ignore” submenu of the Sources pane context menu.
## A group is a top-level item of the Sources pane, like a thread or a domain.

debugger-source-tree-ignore =
    .label = Ignore
    .accesskey = I
debugger-source-tree-ignore-in-group =
    .label = Ignore files in this group
    .accesskey = i
debugger-source-tree-unignore-in-group =
    .label = Unignore files in this group
    .accesskey = u
debugger-source-tree-ignore-outside-group =
    .label = Ignore files outside this group
    .accesskey = o
debugger-source-tree-unignore-outside-group =
    .label = Unignore files outside this group
    .accesskey = o
debugger-source-tree-ignore-in-directory =
    .label = Ignore files in this directory
    .accesskey = i
debugger-source-tree-unignore-in-directory =
    .label = Unignore files in this directory
    .accesskey = u
debugger-source-tree-ignore-outside-directory =
    .label = Ignore files outside this directory
    .accesskey = o
debugger-source-tree-unignore-outside-directory =
    .label = Unignore files outside this directory
    .accesskey = o
