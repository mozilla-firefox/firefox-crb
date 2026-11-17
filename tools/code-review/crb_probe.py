# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

# Temporary probe for the code review bot production rollout (bug 2048352).
# The revision carrying this file is abandoned once the bot has reported.


def code_review_bot_probe():
    unused_probe_value = 3
    return "git-probe-3"
