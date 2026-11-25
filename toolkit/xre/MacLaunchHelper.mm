/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "MacLaunchHelper.h"

#include "MacAutoreleasePool.h"
#include "updaterfileutils_osx.h"

#include <Cocoa/Cocoa.h>
#include <crt_externs.h>
#include <ServiceManagement/ServiceManagement.h>
#include <Security/Authorization.h>
#include <spawn.h>

using namespace mozilla;
using namespace mozilla::MacLaunchHelper;

static void RegisterAppWithLaunchServices(NSString* aBundlePath) {
  MacAutoreleasePool pool;

  @try {
    OSStatus status =
        LSRegisterURL((CFURLRef)[NSURL fileURLWithPath:aBundlePath], YES);
    if (status != noErr) {
      NSLog(@"We failed to register the app in the Launch Services database, "
            @"which may lead to a failure to launch the app. Launch path: %@",
            aBundlePath);
    }
  } @catch (NSException* e) {
    NSLog(@"%@: %@", e.name, e.reason);
  }
}

/**
 * Helper to launch macOS tasks via NSTask and wait for the launched task to
 * terminate.
 */
void LaunchTask(NSString* aPath, NSArray* aArguments) {
  MacAutoreleasePool pool;

  @try {
    NSTask* task = [[NSTask alloc] init];
    [task setExecutableURL:[NSURL fileURLWithPath:aPath]];
    if (aArguments) {
      [task setArguments:aArguments];
    }
    [task launchAndReturnError:nil];
    [task waitUntilExit];
    [task release];
  } @catch (NSException* e) {
    NSLog(@"%@: %@", e.name, e.reason);
  }
}

static void StripQuarantineBit(NSString* aBundlePath) {
  MacAutoreleasePool pool;

  NSArray* arguments = @[ @"-dr", @"com.apple.quarantine", aBundlePath ];
  LaunchTask(@"/usr/bin/xattr", arguments);
}

namespace mozilla::MacLaunchHelper {

void LaunchMacAppWithBundle(NSString* aBundlePath, NSArray* aArguments) {
  MacAutoreleasePool pool;

  @try {
    NSString* launchPath = aBundlePath;
    if (![launchPath hasSuffix:@".app"]) {
      // We only support launching applications inside .app bundles.
      NSLog(@"An attempt was made to launch an app that was not in a .app "
            @"bundle. Please verify launch path: %@",
            launchPath);
      return;
    }

    StripQuarantineBit(launchPath);
    RegisterAppWithLaunchServices(launchPath);

    // We use NSWorkspace to register the application into the
    // `TALAppsToRelaunchAtLogin` list and allow for macOS session resume.
    // This API only works with `.app`s.
    __block dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
    NSWorkspaceOpenConfiguration* config =
        [NSWorkspaceOpenConfiguration configuration];
    [config setArguments:aArguments];
    [config setCreatesNewApplicationInstance:YES];
    [config setEnvironment:[[NSProcessInfo processInfo] environment]];

    [[NSWorkspace sharedWorkspace]
        openApplicationAtURL:[NSURL fileURLWithPath:launchPath]
               configuration:config
           completionHandler:^(NSRunningApplication* aChild, NSError* aError) {
             if (aError) {
               NSLog(@"LaunchMacApp: Failed to run application. Error: %@",
                     aError);
             }
             dispatch_semaphore_signal(semaphore);
           }];

    // We use a semaphore to wait for the application to launch.
    dispatch_semaphore_wait(semaphore, DISPATCH_TIME_FOREVER);
  } @catch (NSException* e) {
    NSLog(@"%@: %@", e.name, e.reason);
  }
}

}  // namespace mozilla::MacLaunchHelper

static void LaunchChildMacWithEnvironment(int aArgc, char** aArgv, pid_t* aPid,
                                          NSDictionary* aEnvironment) {
  MacAutoreleasePool pool;

  @try {
    NSString* launchPath = [NSString stringWithUTF8String:aArgv[0]];
    NSMutableArray* arguments = [NSMutableArray arrayWithCapacity:aArgc - 1];
    for (int i = 1; i < aArgc; i++) {
      [arguments addObject:[NSString stringWithUTF8String:aArgv[i]]];
    }
    NSTask* task = [[NSTask alloc] init];
    [task setExecutableURL:[NSURL fileURLWithPath:launchPath]];
    [task setArguments:arguments];
    if (aEnvironment) {
      [task setEnvironment:aEnvironment];
    }
    NSError* error = nil;
    [task launchAndReturnError:&error];
    if (!error && aPid) {
      *aPid = [task processIdentifier];
      [task waitUntilExit];
    }
    [task release];
  } @catch (NSException* e) {
    NSLog(@"%@: %@", e.name, e.reason);
  }
}

void LaunchChildMac(int aArgc, char** aArgv, pid_t* aPid) {
  LaunchChildMacWithEnvironment(aArgc, aArgv, aPid, nil);
}

void LaunchMacApp(int aArgc, char** aArgv) {
  MacAutoreleasePool pool;

  NSString* launchPath = [NSString stringWithUTF8String:aArgv[0]];
  if (![launchPath hasSuffix:@".app"]) {
    LaunchChildMac(aArgc, aArgv, nullptr);
    return;
  }
  NSMutableArray* arguments = [NSMutableArray arrayWithCapacity:aArgc - 1];
  for (int i = 1; i < aArgc; i++) {
    [arguments addObject:[NSString stringWithUTF8String:aArgv[i]]];
  }
  LaunchMacAppWithBundle(launchPath, arguments);
}

bool InstallPrivilegedHelperWithId(const char* helperId, os_log_t logger,
                                   bool* aIsCanceled) {
  AuthorizationRef authRef = nullptr;
  OSStatus status = AuthorizationCreate(
      nullptr, kAuthorizationEmptyEnvironment,
      kAuthorizationFlagDefaults | kAuthorizationFlagInteractionAllowed,
      &authRef);
  if (status != errAuthorizationSuccess) {
    // AuthorizationCreate really shouldn't fail.
    os_log_error(
        logger,
        "AuthorizationCreate failed! NSOSStatusErrorDomain / %{public}d",
        (int)status);
    return NO;
  }

  BOOL result = NO;
  AuthorizationItem authItem = {kSMRightBlessPrivilegedHelper, 0, nullptr, 0};
  AuthorizationRights authRights = {1, &authItem};
  AuthorizationFlags flags =
      kAuthorizationFlagDefaults | kAuthorizationFlagInteractionAllowed |
      kAuthorizationFlagPreAuthorize | kAuthorizationFlagExtendRights;

  // Obtain the right to install our privileged helper tool.
  status = AuthorizationCopyRights(
      authRef, &authRights, kAuthorizationEmptyEnvironment, flags, nullptr);
  if (status == errAuthorizationCanceled && aIsCanceled) {
    *aIsCanceled = true;
  }
  if (status != errAuthorizationSuccess) {
    os_log_error(
        logger,
        "AuthorizationCopyRights failed! NSOSStatusErrorDomain / %{public}d",
        (int)status);
  } else {
    CFErrorRef cfError;
    NSString* helperIdString = [NSString stringWithUTF8String:helperId];
    // This does all the work of verifying the helper tool against the
    // application and vice-versa. Once verification has passed, the embedded
    // launchd.plist is extracted and placed in /Library/LaunchDaemons and
    // then loaded. The executable is placed in
    // /Library/PrivilegedHelperTools.
    result = (BOOL)SMJobBless(kSMDomainSystemLaunchd,
                              (CFStringRef)helperIdString, authRef, &cfError);
    if (!result) {
      os_log_error(logger, "Unable to install helper: %ld",
                   CFErrorGetCode(cfError));
      CFRelease(cfError);
    }
  }

  AuthorizationFree(authRef, kAuthorizationFlagDefaults);

  return result;
}

bool InstallElevatedUpdater(bool* aIsCanceled) {
  return InstallPrivilegedHelperWithId("org.mozilla.updater", OS_LOG_DEFAULT,
                                       aIsCanceled);
}

bool LaunchElevatedUpdate(int aArgc, char** aArgv, pid_t* aPid) {
  // Install the helper before launching the unelevated updater. The updater
  // connects to the helper's mach service as soon as it starts, and a
  // privileged connection to a name that launchd does not know fails at once
  // instead of waiting for the service to appear, so the service has to be
  // registered first. Installing the helper stops a running one, so don't
  // install it while it handles another update. The updater then gets a busy
  // result from the running helper.
  MacAutoreleasePool pool;
  bool isCanceled = false;
  bool didSucceed =
      IsUpdaterHelperBusy() || InstallElevatedUpdater(&isCanceled);
  NSMutableDictionary* environment =
      [[[NSProcessInfo processInfo] environment] mutableCopy];
  if (didSucceed) {
    [environment removeObjectForKey:@"MOZ_UPDATER_HELPER_NOT_INSTALLED"];
  } else {
    environment[@"MOZ_UPDATER_HELPER_NOT_INSTALLED"] =
        isCanceled ? @"canceled" : @"failed";
  }
  // Launch the updater even when installation fails, so that it records the
  // failure and relaunches the callback application, which is what brings
  // Firefox back after a dismissed authentication dialog.
  // MOZ_UPDATER_HELPER_NOT_INSTALLED tells it that installation failed: a
  // helper left installed by an earlier update would otherwise still accept
  // the connection and apply the update.
  LaunchChildMacWithEnvironment(aArgc, aArgv, aPid, environment);
  [environment release];
  return didSucceed;
}
