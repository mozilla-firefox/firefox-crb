# macOS Elevated Update

When an Admin user installs Firefox, it will be installed with privileges that
allow the Firefox updater to write to the installation files as that user. When
we use elevation to update, we change the permissions on the install directory
such that any Admin user can also do this. This means that the macOS elevated
update flow is:

- Never needed when updating as the installing user.
- Needed once to update from Admin users other than the installing user.
- Needed every time for non-Admin users.

## Which installs the privileged helper updates

The privileged helper only applies an update directly to the installation, and refuses staged and replace requests. It resolves the installation's path once and keeps it open, and the working directory has to be the installation itself. It refuses an installation on a volume that root didn't mount or that ignores ownership, and records `ELEVATED_UPDATE_UNSUPPORTED_VOLUME_ERROR`.

It also refuses an installation that the user who asked for the update can change, or that anyone else it doesn't accept can change. It accepts root, the installation's owner and, when that user isn't in the `admin` group, members of that group, which the helper gives write access after an update. Group write access is only accepted for the `wheel` group and, under the same condition, for the `admin` group. An entry with an ACL that lets anyone change it, a tree deeper than 128 levels, and a directory that root can't read are refused too. The helper records `ELEVATED_UPDATE_CHANGEABLE_INSTALL_ERROR` for these.

## Concurrent elevated updates

Installing the helper with `SMJobBless` stops a helper that is already running, even one with the same version. Once the helper has taken a request, it ignores the SIGTERM that this sends, and launchd only kills it after the `ExitTimeOut` of 60 seconds in its plist, so an update in progress usually gets to finish. Without that key, launchd killed the helper 5 seconds after SIGTERM on macOS 27. While the helper handles an update, it records its process ID in `/private/var/run/org.mozilla.updater.pid`, and Firefox doesn't install the helper again while that process runs. The updater then gets a busy result from the running helper and records `ELEVATED_UPDATE_IN_PROGRESS_ERROR`, so that Firefox tries again later. Firefox versions that don't check that file still install the helper over a running one, and then wait in `SMJobBless` until it has exited.

Firefox never counts a busy result as a cancellation, however often it happens, so it doesn't give up an update because another one was in the way. When the busy request comes from the same user for the same update directory, it's for the update that the helper is handling, and the updater leaves the status file to the helper. When the helper goes away before it replies, for example because it crashed, the updater records `ELEVATED_UPDATE_HELPER_LOST_ERROR`, which Firefox handles like a dismissed authentication dialog.

## UI Flowchart

This flow is what the user experiences in order to initiate an elevated update:

![UI Flowchart](macElevatedUpdateUI.png)

## Algorithm Flowchart

![Algorithm Flowchart](macElevatedUpdateFlowDiagram.svg)

## Testing

Firefox needs to be built with a few extra options to enable the elevated updater to be tested as it needs to be signed correctly.

By default, the elevated updater will only work if it is signed by the Mozilla release signing certificate, which most people don't have access to. Follow the guide in [Signing Your Build Like Production](../../../../contributing/signing/signing_macos_build.md) to request and configure your Developer signing certificate.

Once you have a developer certificate add `ac_add_options --enable-mac-elevated-updates-with-generic-certs` and `ac_add_options --enable-unverified-updates` to `mozconfig` which will allow the elevated updater to run with the developer certificates instead of the Mozilla production one, and will allow it to install unsigned updates from a local update server, as explained in [Setting Up An Update Server](SettingUpAnUpdateServer.md).

With `--enable-mac-elevated-updates-with-generic-certs`, the privileged helper accepts a client and an install directory signed by any Apple developer certificate rather than Mozilla's. Don't leave such a helper installed on a shared machine, and remove it (from `/Library/PrivilegedHelperTools` and `/Library/LaunchDaemons`) when you are done testing.

The OS will need to ask for permission to install the elevated updater when you try to update, and authorization step may fail if you don't run the updater from the UI/terminal - something like tmux over SSH may cause it to fail.
