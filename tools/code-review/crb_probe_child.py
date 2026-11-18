# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

# Temporary probe for the code review bot production rollout (bug 2048352):
# child revision of a two-revision stack. Abandoned once the bot has reported.


def code_review_bot_probe_child():
    unused_child_value = 2
    return "git-probe-child-2"
