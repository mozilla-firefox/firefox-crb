/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef UpdaterHelperProtocol_h
#define UpdaterHelperProtocol_h

#import <Foundation/Foundation.h>

// Mach service name registered by the privileged helper tool's launchd plist
// and the bundle identifier of the helper itself. SMJobBless requires these
// to match.
#define kUpdaterHelperMachServiceName @"org.mozilla.updater"

// The result that the helper sends in its applyUpdate reply.
typedef NS_ENUM(NSInteger, UpdaterHelperApplyResult) {
  // The helper ran the update, which succeeded and recorded its result in the
  // status file.
  UpdaterHelperApplyResultSucceeded = 0,
  // The helper refused the request, or ran an update that failed, and recorded
  // an error in the status file.
  UpdaterHelperApplyResultFailed = 1,
  // The helper didn't record anything in the status file.
  UpdaterHelperApplyResultNotRecorded = 2,
  // The helper was already handling another request and didn't take this one.
  UpdaterHelperApplyResultBusy = 3,
};

// XPC interface exposed by the privileged helper tool to the unelevated
// updater. Both peers are the signed updater binary. The helper only accepts a
// client that satisfies the updater's code-signing requirement. On macOS 13
// and later the client checks the helper against the same requirement. Before
// that it relies on launchd, which only lets a daemon loaded into the system
// domain register kUpdaterHelperMachServiceName.
@protocol UpdaterHelperProtocol

// Apply a pending update with the supplied updater arguments. The helper takes
// the first request that it receives, and replies to any later applyUpdate
// with UpdaterHelperApplyResultBusy right away. After the request that it
// took, it waits for the client to disconnect and removes itself.
- (void)applyUpdate:(NSArray<NSString*>*)arguments
       marChannelID:(NSString*)marChannelID
              reply:(void (^)(NSInteger aResult))aReply;

// Lets a client reach a helper that is still installed from an earlier update
// without applying an update. Like any client that disconnects before sending
// applyUpdate, this makes the helper remove itself once the client has
// disconnected.
- (void)removeHelperWithReply:(void (^)(void))aReply;

@end

#endif  // UpdaterHelperProtocol_h
