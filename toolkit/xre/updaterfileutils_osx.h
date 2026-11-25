/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef updaterfileutils_osx_h_
#define updaterfileutils_osx_h_

// Where the privileged updater helper records its process ID while it handles
// an update.
#define UPDATER_HELPER_PID_FILE_PATH "/private/var/run/org.mozilla.updater.pid"

extern "C" {
bool IsRecursivelyWritable(const char* aPath);

// Returns whether the privileged updater helper is handling an update.
bool IsUpdaterHelperBusy();

// Returns whether aFd is on a volume that root mounted with ownership enabled.
// The privileged updater helper refuses to update an install on any other
// volume, where ownership doesn't protect it.
bool IsOnVolumeHonoringOwnership(int aFd);
}

#endif
