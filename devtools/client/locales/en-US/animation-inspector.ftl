# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

### These strings are used in the Animation Inspector, a panel accessible in
### the Inspector sidebar.

# Displayed in the panel when there are no animations to display (e.g. when the
# selected node is not an element, or is not animated).
animation-inspector-no-animation = No animations were found for the current element.
    Pick another element from the page.

## Lines of the tooltip displayed when hovering over an animation in the
## timeline. Durations are formatted with animation-inspector-time-seconds
## (e.g. 1.5s), or animation-inspector-infinity.

# Variables:
#   $duration (String) - The duration of the animation.
animation-inspector-tooltip-duration = Duration: { $duration }
# Variables:
#   $delay (String) - The delay of the animation.
animation-inspector-tooltip-delay = Delay: { $delay }
# Variables:
#   $endDelay (String) - The end delay of the animation.
animation-inspector-tooltip-end-delay = End delay: { $endDelay }
# Variables:
#   $rate (Number) - The playback rate of the animation (e.g. 2).
animation-inspector-tooltip-playback-rate = Playback rate: { $rate }
# Variables:
#   $count (Number|String) - The number of times the animation is set to
#   repeat, or animation-inspector-infinity.
animation-inspector-tooltip-iteration-count = Repeats: { $count }
# The easing that applies to a whole iteration of the animation, as opposed to
# the easing that applies between keyframes.
# Variables:
#   $easing (String) - A CSS easing function (e.g. steps(2)).
animation-inspector-tooltip-overall-easing = Overall easing: { $easing }
# Variables:
#   $timingFunction (String) - The animation-timing-function of a CSS
#   Animation (e.g. linear).
animation-inspector-tooltip-timing-function = Animation timing function: { $timingFunction }
# Variables:
#   $fill (String) - The CSS fill mode of the animation (e.g. forwards).
animation-inspector-tooltip-fill = Fill: { $fill }
# Variables:
#   $direction (String) - The CSS direction of the animation (e.g. alternate).
animation-inspector-tooltip-direction = Direction: { $direction }

##

# Displayed in the tooltip when hovering over an animation in the timeline.
# Variables:
#   $iterationStart (Number) - The original iteration start value (e.g. 0.5).
#   $time (String) - The time of the iteration start, formatted with
#   animation-inspector-time-seconds (e.g. 0.5s), or animation-inspector-infinity.
animation-inspector-tooltip-iteration-start = Iteration start: { $iterationStart } ({ $time })

## Notes displayed at the end of the tooltip, when the animation is running on
## the compositor thread.

animation-inspector-running-on-compositor = This animation is running on compositor thread
animation-inspector-all-properties-on-compositor = All animation properties are optimized
animation-inspector-some-properties-on-compositor = Some animation properties are optimized

## Names of animations, displayed in the timeline and in the header of the
## animation details.
## Variables:
##   $name (String) - The name of the animation or transition.

animation-inspector-css-animation-name = { $name } — CSS Animation
animation-inspector-css-transition-name = { $name } — CSS Transition
animation-inspector-script-animation-name = { $name } — Script Animation
animation-inspector-script-animation-unnamed = Script Animation

##

# Displayed instead of a duration or a number of repeats when the value is
# infinite.
animation-inspector-infinity = ∞

# Duration in seconds, displayed in the tooltip of an animation.
# Variables:
#   $time (Number) - The duration in seconds (e.g. 1.5).
animation-inspector-time-seconds = { NUMBER($time, maximumFractionDigits: 2) }s

## Labels displayed next to each graduation of the timeline.
## Variables:
##   $time (Number) - The time at the graduation.

animation-inspector-timeline-seconds = { NUMBER($time, minimumFractionDigits: 1, maximumFractionDigits: 1, useGrouping: "false") }s
animation-inspector-timeline-milliseconds = { NUMBER($time, maximumFractionDigits: 0, useGrouping: "false") }ms

##

# Label of the items in the dropdown used to change the playback rate of the
# animations (1× being the default, 2× being twice as fast).
# Variables:
#   $rate (Number) - The playback rate multiplier.
animation-inspector-playback-rate = { $rate }×

# Displayed in the header of the list of animated properties, as a progress
# indicator for the animation.
# Variables:
#   $percentage (Number) - A percentage (e.g. 50).
animation-inspector-percentage = { $percentage }%

## Tooltips for the buttons in the timeline toolbar.

animation-inspector-resume-button-title = Resume the animations
animation-inspector-pause-button-title = Pause the animations
animation-inspector-rewind-button-title = Rewind the animations
