/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef POST_UPDATE_ENVIRONMENT_H_
#define POST_UPDATE_ENVIRONMENT_H_

#include <windows.h>

#include <string>

#include "elevation_type.h"

/**
 * The environment of the post-update process.
 *
 * Unelevated launches receive only SystemDrive and SystemRoot, taken from the
 * system Windows directory, and TEMP, TMP and USERPROFILE from the user's
 * default environment. The values aren't inherited from the updater, so that
 * relaunch variables don't affect post-update background tasks (bug 1903615).
 * Every other elevation type gets an empty environment.
 */
class PostUpdateEnvironment final {
 public:
  explicit PostUpdateEnvironment(ElevationType aElevationType);

  // Non-copyable and non-movable
  PostUpdateEnvironment(const PostUpdateEnvironment&) = delete;
  PostUpdateEnvironment(PostUpdateEnvironment&&) = delete;
  PostUpdateEnvironment& operator=(const PostUpdateEnvironment&) = delete;
  PostUpdateEnvironment& operator=(PostUpdateEnvironment&&) = delete;

  LPVOID get() const;

 private:
  std::wstring mEnvironmentBlock;
};

#endif  // POST_UPDATE_ENVIRONMENT_H_
