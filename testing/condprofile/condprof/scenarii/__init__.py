# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

import sys

from condprof.scenarii.full import full
from condprof.scenarii.quota_usage import quota_usage
from condprof.scenarii.settled import settled
from condprof.scenarii.settled2 import settled2
from condprof.scenarii.settled_youtube import settled_youtube

scenarii = {
    "full": full,
    "qm_use": quota_usage,
    "settled": settled,
    "settled-youtube": settled_youtube,
    "settled2": settled2,
}


def get_scenario_module(name):
    """Module that implements the scenario registered under `name`.

    Names are registry keys, which may be aliases, so the module is found
    through the registered function rather than from the name.
    """
    return sys.modules[scenarii[name].__module__]
