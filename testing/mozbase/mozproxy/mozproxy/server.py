# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

from mozproxy.backends.mitm.android import MitmproxyAndroidSetup
from mozproxy.backends.mitm.desktop import MitmproxyDesktopSetup
from mozproxy.backends.mitm.mitm import Mitmproxy
from mozproxy.utils import LOG

_BACKENDS = {
    "mitmproxy": MitmproxyDesktopSetup,
    "mitmproxy-android": MitmproxyAndroidSetup,
}


def get_backend(name, config):
    """Returns the class that implements the backend.

    Raises KeyError in case the backend does not exists.
    """
    backend_config = dict(config)

    # Backward compatibility: derive proxy_mode from the old record flag
    if "proxy_mode" not in backend_config:
        if backend_config.get("record", False):
            LOG.info("Setting proxy mode to record.")
            backend_config["proxy_mode"] = "record"
        else:
            LOG.info("Setting proxy mode to playback.")
            backend_config["proxy_mode"] = "playback"

    environment_setup = _BACKENDS[name](backend_config)
    return Mitmproxy(backend_config, environment_setup)
