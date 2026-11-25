# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

### These strings are used in the context menus of the Debugger.

## Breakpoints pane breakpoint context menu

# Remove the breakpoint.
debugger-breakpoint-remove =
    .label = Remove
    .accesskey = R

# Remove all breakpoints.
debugger-breakpoint-remove-all =
    .label = Remove all
    .accesskey = a

# Remove all breakpoints except this one.
debugger-breakpoint-remove-others =
    .label = Remove others
    .accesskey = h

# Enable the breakpoint.
debugger-breakpoint-enable =
    .label = Enable
    .accesskey = E

# Enable all breakpoints.
debugger-breakpoint-enable-all =
    .label = Enable all
    .accesskey = b

# Enable all breakpoints except this one.
debugger-breakpoint-enable-others =
    .label = Enable others
    .accesskey = o

# Disable the breakpoint.
debugger-breakpoint-disable =
    .label = Disable
    .accesskey = D

# Disable all breakpoints.
debugger-breakpoint-disable-all =
    .label = Disable all
    .accesskey = k

# Disable all breakpoints except this one.
debugger-breakpoint-disable-others =
    .label = Disable others
    .accesskey = s

# Remove the condition of the breakpoint.
debugger-breakpoint-remove-condition =
    .label = Remove condition
    .accesskey = c

# Add a condition to the breakpoint.
debugger-breakpoint-add-condition =
    .label = Add condition
    .accesskey = A

# Edit the condition of the breakpoint.
debugger-breakpoint-edit-condition =
    .label = Edit condition
    .accesskey = n

## Breakpoint context menus of the Breakpoints pane and the editor gutter

# Make a breakpoint that never pauses pause again.
debugger-pause-here =
    .label = Pause here

# Make the breakpoint, or a debugger statement on the line, never pause.
debugger-never-pause-here =
    .label = Never pause here

# Add a log point to the line.
debugger-add-log-point =
    .label = Add log
    .accesskey = l

# Edit the log point set on the line.
debugger-edit-log-point =
    .label = Edit log
    .accesskey = E

# Remove the log point set on the line.
debugger-remove-log-point =
    .label = Remove log
    .accesskey = V

## Editor gutter context menu

# Add a breakpoint to the line.
debugger-editor-add-breakpoint =
    .label = Add breakpoint
    .accesskey = B

# Remove the breakpoint on the line.
debugger-editor-remove-breakpoint =
    .label = Remove breakpoint
    .accesskey = B

# Add a conditional breakpoint to the line.
debugger-editor-add-condition =
    .label = Add condition
    .accesskey = c

# Edit the condition of the breakpoint on the line.
debugger-editor-edit-condition =
    .label = Edit condition
    .accesskey = c

# Enable the breakpoint on the line.
debugger-editor-enable-breakpoint =
    .label = Enable breakpoint
    .accesskey = D

# Disable the breakpoint on the line.
debugger-editor-disable-breakpoint =
    .label = Disable breakpoint
    .accesskey = D

# Remove every breakpoint on the line.
debugger-editor-remove-breakpoints-on-line =
    .label = Remove breakpoints on line
    .accesskey = X

# Enable every breakpoint on the line.
debugger-editor-enable-breakpoints-on-line =
    .label = Enable breakpoints on line
    .accesskey = L

# Disable every breakpoint on the line.
debugger-editor-disable-breakpoints-on-line =
    .label = Disable breakpoints on line
    .accesskey = K

# Resume execution up to the line.
debugger-editor-continue-to-here =
    .label = Continue to here
    .accesskey = H

# Make the debugger skip the line.
debugger-editor-ignore-line =
    .label = Ignore line
    .accesskey = l

# Stop skipping the line.
debugger-editor-unignore-line =
    .label = Unignore line
    .accesskey = n

## Editor context menu

# Copy the selected text.
debugger-editor-copy-to-clipboard =
    .label = Copy to clipboard
    .accesskey = C

# Make the debugger skip the selected lines.
debugger-editor-ignore-lines =
    .label = Ignore lines
    .accesskey = i

# Stop skipping the selected lines.
debugger-editor-unignore-lines =
    .label = Unignore lines
    .accesskey = u

# Go to the generated location the selected line maps to.
debugger-editor-jump-to-generated-location =
    .label = Jump to generated location
    .accesskey = m

# Go to the original location the selected line maps to.
debugger-editor-jump-to-original-location =
    .label = Jump to original location
    .accesskey = m

# Add the selected text as a watch expression.
debugger-editor-add-watch-expression =
    .label = Add watch expression
    .accesskey = e

# Evaluate the selected text in the console.
debugger-editor-evaluate-in-console =
    .label = Evaluate in console

debugger-editor-show-inline-preview =
    .label = Show inline preview

debugger-editor-hide-inline-preview =
    .label = Hide inline preview

debugger-editor-wrap-lines =
    .label = Wrap lines

debugger-editor-unwrap-lines =
    .label = Unwrap lines

## Source context menus of the editor, the source tabs and the Sources pane

# Copy the text of the source.
debugger-copy-source =
    .label = Copy source text
    .accesskey = y

# Copy the URI of the source.
debugger-copy-source-uri =
    .label = Copy source URI
    .accesskey = u

# Select the source in the Sources pane.
debugger-reveal-in-tree =
    .label = Reveal in tree
    .accesskey = r

# Make the debugger skip the source.
debugger-ignore-source =
    .label = Ignore source
    .accesskey = I

# Stop skipping the source.
debugger-unignore-source =
    .label = Unignore source
    .accesskey = U

# Save the source to a file.
debugger-download-file =
    .label = Download file
    .accesskey = d

## Source tab context menu

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

# Stop skipping the source.
debugger-tab-unignore-source =
    .label = Unignore source
    .accesskey = I

# Open a pretty-printed copy of the source.
debugger-tab-pretty-print =
    .label = Pretty print source
    .accesskey = p

## Sources pane context menu

# Replace the source with a local file.
debugger-source-tree-add-override =
    .label = Add script override
    .accesskey = o

# Stop replacing the source with a local file.
debugger-source-tree-remove-override =
    .label = Remove script override
    .accesskey = o

# Collapse a directory and all of its subdirectories.
debugger-source-tree-collapse-all =
    .label = Collapse all

# Expand a directory and all of its subdirectories.
debugger-source-tree-expand-all =
    .label = Expand all

# Show only the directory and its contents in the Sources pane.
debugger-source-tree-set-directory-root =
    .label = Set directory root
    .accesskey = r

# Show all sources in the Sources pane again.
debugger-source-tree-remove-directory-root =
    .label = Remove directory root

# Submenu with items that make the debugger skip groups of files.
debugger-source-tree-ignore =
    .label = Ignore

debugger-source-tree-ignore-in-group =
    .label = Ignore files in this group

debugger-source-tree-unignore-in-group =
    .label = Unignore files in this group

debugger-source-tree-ignore-outside-group =
    .label = Ignore files outside this group

debugger-source-tree-unignore-outside-group =
    .label = Unignore files outside this group

debugger-source-tree-ignore-in-directory =
    .label = Ignore files in this directory

debugger-source-tree-unignore-in-directory =
    .label = Unignore files in this directory

debugger-source-tree-ignore-outside-directory =
    .label = Ignore files outside this directory

debugger-source-tree-unignore-outside-directory =
    .label = Unignore files outside this directory
