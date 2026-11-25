# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

"""Generate UpdaterCodeSigningRequirements.h with the macOS code-signing
requirement strings used by the privileged helper: the updater's own
requirement, which both ends of the XPC connection check their peer against,
the application's requirement, which the helper checks the install directory
against; and UpdateSettings.framework's requirement, which the helper checks
the framework it reads the accepted MAR channels from against.

The configure-time requirement strings already have the per-edition bundle id
substituted in, so emit them directly as escaped C string literals for use
from Objective-C++ source.
"""

import json


def create_header(output):
    import buildconfig

    app_req = buildconfig.substs["MOZ_SMAUTHORIZEDCLIENTS_REQUIREMENTS"]
    updater_req = buildconfig.substs["MOZ_UPDATER_SMPRIVILEGEDEXECUTABLE_REQUIREMENT"]
    settings_req = buildconfig.substs["MOZ_UPDATER_SMUPDATESETTINGS_REQUIREMENT"]

    output.write("/* Generated. Do not edit. */\n")
    output.write("#ifndef UpdaterCodeSigningRequirements_h\n")
    output.write("#define UpdaterCodeSigningRequirements_h\n\n")
    output.write(
        f"#define MOZ_SMAUTHORIZEDCLIENTS_REQUIREMENTS_STR {json.dumps(app_req)}\n"
    )
    output.write(
        "#define MOZ_UPDATER_SMPRIVILEGEDEXECUTABLE_REQUIREMENT_STR "
        f"{json.dumps(updater_req)}\n"
    )
    output.write(
        "#define MOZ_UPDATER_SMUPDATESETTINGS_REQUIREMENT_STR "
        f"{json.dumps(settings_req)}\n"
    )
    output.write("\n#endif\n")
