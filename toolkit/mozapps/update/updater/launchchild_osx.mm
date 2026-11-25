/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include <Cocoa/Cocoa.h>
#include <CoreServices/CoreServices.h>
#include <Security/Security.h>
#include <crt_externs.h>
#include <fcntl.h>
#include <signal.h>
#include <stdlib.h>
#include <stdio.h>
#include <spawn.h>
#include <string.h>
#include <SystemConfiguration/SystemConfiguration.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/sysctl.h>
#include <unistd.h>
#include "readstrings.h"
#include "updatecommon.h"
#include "updatererrors.h"
#include "updaterfileutils_osx.h"
#include "UpdaterCodeSigningRequirements.h"
#import "UpdaterHelperProtocol.h"

// NSXPCConnection exposes the peer's audit token through this property, which
// is not declared in the public SDK headers. The listener delegate checks at
// runtime that the connection responds to it before using it.
@interface NSXPCConnection (PrivateAuditToken)
@property(nonatomic, readonly) audit_token_t auditToken;
@end

#define ARCH_PATH "/usr/bin/arch"
#if defined(__x86_64__)
// Work around the fact that this constant is not available in the macOS SDK
#  define kCFBundleExecutableArchitectureARM64 0x0100000c
#endif

class MacAutoreleasePool {
 public:
  MacAutoreleasePool() { mPool = [[NSAutoreleasePool alloc] init]; }
  ~MacAutoreleasePool() { [mPool release]; }

 private:
  NSAutoreleasePool* mPool;
};

/**
 * Helper to launch macOS tasks via NSTask and wait for the launched task to
 * terminate.
 */
static void LaunchTask(NSString* aPath, NSArray* aArguments) {
  MacAutoreleasePool pool;

  NSTask* task = [[NSTask alloc] init];
  [task setExecutableURL:[NSURL fileURLWithPath:aPath]];
  if (aArguments) {
    [task setArguments:aArguments];
  }
  [task launchAndReturnError:nil];
  [task waitUntilExit];
  [task release];
}

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

static void StripQuarantineBit(NSString* aBundlePath) {
  MacAutoreleasePool pool;

  NSArray* arguments = @[ @"-dr", @"com.apple.quarantine", aBundlePath ];
  LaunchTask(@"/usr/bin/xattr", arguments);
}

// How long to wait for the process we are replacing to go away before we give
// up and launch anyway.
static const NSTimeInterval kWaitForExitSeconds = 10.0;

// How often to ask Launch Services whether the process is gone yet.
static const useconds_t kWaitForExitPollMicroseconds = 50000;

/**
 * Wait for the process we are replacing to go away.
 *
 * We ask Launch Services rather than looking at the process table because the
 * dock follows the Launch Services registration, which can outlive the process
 * itself for a moment. Re-querying on every pass avoids relying on a run loop
 * to deliver property updates.
 */
static void WaitForAppToTerminate(pid_t aPid, NSTimeInterval aTimeout) {
  NSDate* deadline = [NSDate dateWithTimeIntervalSinceNow:aTimeout];
  while (true) {
    {
      MacAutoreleasePool pool;
      NSRunningApplication* app =
          [NSRunningApplication runningApplicationWithProcessIdentifier:aPid];
      if (!app || [app isTerminated]) {
        return;
      }
      if ([deadline timeIntervalSinceNow] <= 0) {
        NSLog(@"Timed out waiting for pid %d to exit before relaunching.",
              (int)aPid);
        return;
      }
    }
    usleep(kWaitForExitPollMicroseconds);
  }
}

/**
 * While two processes of the same app bundle are registered with macOS at the
 * same time, the second one counts as another instance of the app and is given
 * its own dock tile, which then sticks around in the dock's list of recently
 * used applications. So only ask for a new instance when we have to.
 *
 * We have to whenever any process of this bundle identifier is running, even
 * one running from a different copy of the application. macOS resolves the
 * open by bundle identifier rather than by the path we pass: without the
 * request it hands us that other process, drops the arguments, and the
 * application we were asked to launch never comes up.
 */
static BOOL ShouldCreateNewAppInstance(NSString* aBundlePath) {
  MacAutoreleasePool pool;

  NSString* bundleId = [[NSBundle bundleWithPath:aBundlePath] bundleIdentifier];
  if (!bundleId) {
    return YES;
  }

  return [[NSRunningApplication
             runningApplicationsWithBundleIdentifier:bundleId] count] > 0;
}

void LaunchMacApp(int argc, const char** argv, pid_t aWaitForPid) {
  MacAutoreleasePool pool;

  @try {
    NSString* launchPath = [NSString stringWithUTF8String:argv[0]];
    NSMutableArray* arguments = [NSMutableArray arrayWithCapacity:argc - 1];
    for (int i = 1; i < argc; i++) {
      [arguments addObject:[NSString stringWithUTF8String:argv[i]]];
    }
    if (![launchPath hasSuffix:@".app"]) {
      // We only support launching applications inside .app bundles.
      NSLog(@"The updater attempted to launch an app that was not a .app "
            @"bundle. Please verify launch path: %@",
            launchPath);
      return;
    }

    StripQuarantineBit(launchPath);
    RegisterAppWithLaunchServices(launchPath);

    if (aWaitForPid > 0) {
      WaitForAppToTerminate(aWaitForPid, kWaitForExitSeconds);
    }

    // We use NSWorkspace to register the application into the
    // `TALAppsToRelaunchAtLogin` list and allow for macOS session resume.
    // This API only works with `.app`s.
    __block dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
    NSWorkspaceOpenConfiguration* config =
        [NSWorkspaceOpenConfiguration configuration];
    [config setArguments:arguments];
    [config setActivates:NO];
    [config setCreatesNewApplicationInstance:ShouldCreateNewAppInstance(
                                                 launchPath)];
    [config setEnvironment:[[NSProcessInfo processInfo] environment]];

    [[NSWorkspace sharedWorkspace]
        openApplicationAtURL:[NSURL fileURLWithPath:launchPath]
               configuration:config
           completionHandler:^(NSRunningApplication* aChild, NSError* aError) {
             if (aError) {
               NSLog(@"launchchild_osx: Failed to run application. Error: %@",
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

void LaunchMacPostProcess(const char* aAppBundle) {
  MacAutoreleasePool pool;

  // Launch helper to perform post processing for the update; this is the Mac
  // analogue of LaunchWinPostProcess (PostUpdateWin).
  NSString* iniPath = [NSString stringWithUTF8String:aAppBundle];
  iniPath = [iniPath
      stringByAppendingPathComponent:@"Contents/Resources/updater.ini"];

  NSFileManager* fileManager = [NSFileManager defaultManager];
  if (![fileManager fileExistsAtPath:iniPath]) {
    // the file does not exist; there is nothing to run
    return;
  }

  int readResult;
  mozilla::UniquePtr<char[]> values[2];
  readResult = ReadStrings([iniPath UTF8String], "ExeRelPath\0ExeArg\0", 2,
                           values, "PostUpdateMac");
  if (readResult) {
    return;
  }

  NSString* exeRelPath = [NSString stringWithUTF8String:values[0].get()];
  NSString* exeArg = [NSString stringWithUTF8String:values[1].get()];
  if (!exeArg || !exeRelPath) {
    return;
  }

  // The path must not traverse directories and it must be a relative path.
  if ([exeRelPath isEqualToString:@".."] || [exeRelPath hasPrefix:@"/"] ||
      [exeRelPath hasPrefix:@"../"] || [exeRelPath hasSuffix:@"/.."] ||
      [exeRelPath containsString:@"/../"]) {
    return;
  }

  NSString* exeFullPath = [NSString stringWithUTF8String:aAppBundle];
  exeFullPath = [exeFullPath stringByAppendingPathComponent:exeRelPath];

  mozilla::UniquePtr<char[]> optVal;
  readResult = ReadStrings([iniPath UTF8String], "ExeAsync\0", 1, &optVal,
                           "PostUpdateMac");

  NSTask* task = [[NSTask alloc] init];
  [task setLaunchPath:exeFullPath];
  [task setArguments:[NSArray arrayWithObject:exeArg]];

  // Invoke post-update with a minimal environment to avoid environment
  // variables intended to relaunch Firefox impacting post-update operations, in
  // particular background tasks.  The updater will invoke the callback
  // application with the current (non-minimal) environment.
  //
  // Unlike on Windows, where the run without elevation gets the user's default
  // environment (bug 2078262), this always uses an empty environment.
  [task setEnvironment:@{}];

  [task launch];
  if (!readResult) {
    NSString* exeAsync = [NSString stringWithUTF8String:optVal.get()];
    if ([exeAsync isEqualToString:@"false"]) {
      [task waitUntilExit];
    }
  }
  // ignore the return value of the task, there's nothing we can do with it
  [task release];
}

// State shared between the listener delegate (running on the listener's
// dispatch queue) and the helper's main thread (which blocks in
// ObtainUpdaterArguments until applyUpdate arrives).
static dispatch_semaphore_t gApplyUpdateSemaphore = nullptr;
static NSXPCListener* gUpdaterHelperListener = nil;
// The state below is guarded by gConnectionLock. The helper handles a single
// request and then removes itself. It takes the first applyUpdate it receives,
// or the disconnect of a client that didn't send applyUpdate, whichever comes
// first, and answers every later applyUpdate with
// UpdaterHelperApplyResultBusy.
static bool gHasTakenRequest = false;
// The connection whose applyUpdate the helper took, until it invalidates. The
// main thread uses it to tell whether it has to wait for the client to
// disconnect before exiting.
static NSXPCConnection* gRequestConnection = nil;
// Signaled when gRequestConnection invalidates.
static dispatch_semaphore_t gClientDisconnectedSemaphore = nullptr;
static NSObject* gConnectionLock = nil;
static NSArray<NSString*>* gPendingUpdaterArguments = nil;
static NSString* gPendingMARChannelID = nil;
// The effective user ID of the client whose applyUpdate the helper took.
static uid_t gClientUid = (uid_t)-1;
static void (^gApplyUpdateReplyBlock)(NSInteger) = nil;

// How long the helper waits for a request after it has started.
static const int64_t kApplyUpdateWaitSeconds = 60;

// Set in the unelevated updater from the helper's applyUpdate reply.
static NSInteger gApplyUpdateResult = UpdaterHelperApplyResultNotRecorded;
static bool gDidHelperReply = false;

bool WasHelperBusy() {
  return gApplyUpdateResult == UpdaterHelperApplyResultBusy ||
         gApplyUpdateResult == UpdaterHelperApplyResultBusyWithSameUpdate;
}

bool WasHelperBusyWithSameUpdate() {
  return gApplyUpdateResult == UpdaterHelperApplyResultBusyWithSameUpdate;
}

bool DidHelperReply() { return gDidHelperReply; }

bool DidHelperRecordStatus() {
  return gApplyUpdateResult == UpdaterHelperApplyResultSucceeded ||
         gApplyUpdateResult == UpdaterHelperApplyResultFailed;
}

// Defined in updater.cpp.
bool DidWriteStatusFile();
int GetPatchDirArgIndex();

// Validates that the audit token represents a process that matches the given
// code-signing requirement string and that has the hard and kill code-signing
// status flags.
static bool ValidatePeerWithRequirement(audit_token_t aToken,
                                        NSString* aRequirementStr) {
  if (!aRequirementStr.length) {
    return false;
  }
  NSData* tokenData = [NSData dataWithBytes:&aToken length:sizeof(aToken)];
  NSDictionary* attrs =
      @{(__bridge NSString*)kSecGuestAttributeAudit : tokenData};
  SecCodeRef code = nullptr;
  if (SecCodeCopyGuestWithAttributes(nullptr, (__bridge CFDictionaryRef)attrs,
                                     kSecCSDefaultFlags,
                                     &code) != errSecSuccess ||
      !code) {
    return false;
  }
  SecRequirementRef req = nullptr;
  bool ok = false;
  if (SecRequirementCreateWithString((__bridge CFStringRef)aRequirementStr,
                                     kSecCSDefaultFlags,
                                     &req) == errSecSuccess &&
      req) {
    ok = (SecCodeCheckValidityWithErrors(code, kSecCSDefaultFlags, req,
                                         nullptr) == errSecSuccess);
    CFRelease(req);
  }
  if (ok) {
    // Refuse a client whose code could be changed while it runs.
    ok = false;
    CFDictionaryRef info = nullptr;
    if (SecCodeCopySigningInformation(code, kSecCSDynamicInformation, &info) ==
            errSecSuccess &&
        info) {
      NSNumber* status = ((
          __bridge NSDictionary*)info)[(__bridge NSString*)kSecCodeInfoStatus];
      ok = (status.unsignedIntValue &
            (kSecCodeStatusHard | kSecCodeStatusKill)) ==
           (kSecCodeStatusHard | kSecCodeStatusKill);
      CFRelease(info);
    }
  }
  CFRelease(code);
  return ok;
}

// The install directory that ValidateAndPinInstallDir resolved and opened, and
// its resolved path.
static int gInstallDirFd = -1;
static char gPinnedInstallDirPath[PATH_MAX];

bool GetPinnedInstallDirPath(char* aPath, size_t aLength) {
  if (gInstallDirFd < 0 || strlen(gPinnedInstallDirPath) >= aLength) {
    return false;
  }
  strlcpy(aPath, gPinnedInstallDirPath, aLength);
  return true;
}

int ValidateAndPinInstallDir(const char* aInstallDir) {
  MacAutoreleasePool pool;

  if (gClientUid == (uid_t)-1) {
    LogToOS(NS_T("Updater helper: the client is unknown."));
    return INVALID_INSTALL_DIR_PATH_ERROR;
  }

  // Resolve the path once and keep the directory open.
  char resolved[PATH_MAX];
  if (!realpath(aInstallDir, resolved)) {
    LogToOS(NS_T("Updater helper: can't resolve the install directory."));
    return INVALID_INSTALL_DIR_PATH_ERROR;
  }
  NSString* resolvedPath = [NSString stringWithUTF8String:resolved];
  if (![resolvedPath hasSuffix:@".app"]) {
    LogToOS(NS_T("Updater helper: the install directory isn't an app bundle."));
    return INVALID_INSTALL_DIR_PATH_ERROR;
  }
  int fd = open(resolved, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) {
    LogToOS(NS_T("Updater helper: can't open the install directory."));
    return INVALID_INSTALL_DIR_PATH_ERROR;
  }
  if (!IsOnVolumeHonoringOwnership(fd)) {
    LogToOS(NS_T("Updater helper: the install directory isn't on a volume "
                 "that root mounted with ownership enabled."));
    close(fd);
    return ELEVATED_UPDATE_UNSUPPORTED_VOLUME_ERROR;
  }
  // The helper only updates installs that neither the client nor anyone it
  // doesn't accept can change.
  if (!IsInstallTreeProtected(fd, gClientUid,
                              /* aIsUncheckableRefused = */ true)) {
    LogToOS(NS_T("Updater helper: the client can change the install "
                 "directory."));
    close(fd);
    return ELEVATED_UPDATE_CHANGEABLE_INSTALL_ERROR;
  }
  // Make sure the path still leads to the directory that was opened.
  struct stat fdStat;
  struct stat pathStat;
  if (fstat(fd, &fdStat) != 0 || lstat(resolved, &pathStat) != 0 ||
      fdStat.st_dev != pathStat.st_dev || fdStat.st_ino != pathStat.st_ino) {
    LogToOS(NS_T("Updater helper: the install directory changed while it was "
                 "opened."));
    close(fd);
    return INVALID_INSTALL_DIR_PATH_ERROR;
  }
  gInstallDirFd = fd;
  strlcpy(gPinnedInstallDirPath, resolved, sizeof(gPinnedInstallDirPath));
  return OK;
}

@interface UpdaterHelperListenerDelegate
    : NSObject <NSXPCListenerDelegate, UpdaterHelperProtocol>
@end

@implementation UpdaterHelperListenerDelegate

- (BOOL)listener:(NSXPCListener*)listener
    shouldAcceptNewConnection:(NSXPCConnection*)conn {
  // The unelevated updater that connects is the same signed binary as this
  // privileged helper, so authenticate the peer against the updater's own
  // (SMPrivilegedExecutables) code-signing identity. SMAuthorizedClients
  // identifies the browser for SMJobBless installation, not this XPC peer.
  // On macOS 13 and later, setCodeSigningRequirement: below makes the
  // framework enforce the same requirement on every message. Before that
  // the audit token check is the only peer validation, so refuse the
  // connection if the private property is unavailable.
  bool hasAuditToken = [conn respondsToSelector:@selector(auditToken)];
  if (hasAuditToken &&
      !ValidatePeerWithRequirement(
          conn.auditToken,
          @MOZ_UPDATER_SMPRIVILEGEDEXECUTABLE_REQUIREMENT_STR)) {
    LogToOS(NS_T("Updater helper rejecting connection from unauthorized "
                 "client."));
    return NO;
  }
  if (@available(macOS 13.0, *)) {
    [conn setCodeSigningRequirement:
              @MOZ_UPDATER_SMPRIVILEGEDEXECUTABLE_REQUIREMENT_STR];
  } else if (!hasAuditToken) {
    LogToOS(NS_T("Updater helper rejecting connection: unable to identify "
                 "the connecting process."));
    return NO;
  }
  // Every validated client is accepted, so that a client arriving while the
  // helper handles another request gets UpdaterHelperApplyResultBusy from
  // applyUpdate instead of a failed connection. Connections arrive on parallel
  // queues, so the helper decides which request it takes under
  // gConnectionLock.
  conn.invalidationHandler = ^{
    bool isRequestConnection = false;
    bool shouldRemoveHelper = false;
    @synchronized(gConnectionLock) {
      if (gRequestConnection == conn) {
        gRequestConnection = nil;
        isRequestConnection = true;
      } else if (!gHasTakenRequest) {
        // A client that disconnects without having sent applyUpdate asks an
        // idle helper to remove itself.
        gHasTakenRequest = true;
        shouldRemoveHelper = true;
      }
    }
    if (isRequestConnection) {
      dispatch_semaphore_signal(gClientDisconnectedSemaphore);
    }
    if (shouldRemoveHelper) {
      dispatch_semaphore_signal(gApplyUpdateSemaphore);
    }
  };
  conn.exportedInterface =
      [NSXPCInterface interfaceWithProtocol:@protocol(UpdaterHelperProtocol)];
  conn.exportedObject = self;
  [conn resume];
  return YES;
}

- (void)applyUpdate:(NSArray<NSString*>*)aArguments
       marChannelID:(NSString*)aMARChannelID
              reply:(void (^)(NSInteger))aReply {
  bool isBusy;
  bool isSameUpdate = false;
  @synchronized(gConnectionLock) {
    isBusy = gHasTakenRequest;
    if (isBusy) {
      // The patch directory is per user and per installation, so a request
      // for the same one is for the update that the helper is handling.
      NSXPCConnection* conn = [NSXPCConnection currentConnection];
      NSUInteger patchDirIndex = (NSUInteger)GetPatchDirArgIndex();
      isSameUpdate = conn && conn.effectiveUserIdentifier == gClientUid &&
                     gPendingUpdaterArguments.count > patchDirIndex &&
                     aArguments.count > patchDirIndex &&
                     [gPendingUpdaterArguments[patchDirIndex]
                         isEqualToString:aArguments[patchDirIndex]];
    } else {
      gHasTakenRequest = true;
      gRequestConnection = [NSXPCConnection currentConnection];
      if (gRequestConnection) {
        gClientUid = gRequestConnection.effectiveUserIdentifier;
      }
      gPendingUpdaterArguments = [aArguments copy];
      gPendingMARChannelID = [aMARChannelID copy];
      gApplyUpdateReplyBlock = [aReply copy];
    }
  }
  if (isBusy) {
    aReply(isSameUpdate ? UpdaterHelperApplyResultBusyWithSameUpdate
                        : UpdaterHelperApplyResultBusy);
    return;
  }
  dispatch_semaphore_signal(gApplyUpdateSemaphore);
}

- (void)removeHelperWithReply:(void (^)(void))aReply {
  // Nothing to do here: when this client disconnects without having sent
  // applyUpdate, the connection's invalidation handler wakes the main thread,
  // which then removes the helper.
  aReply();
}

@end

// Forward declarations.
[[noreturn]] void CleanupElevatedMacUpdate(bool aFailureOccurred);

// Note: Caller is responsible for freeing aArgv.
bool ObtainUpdaterArguments(int* aArgc, char*** aArgv,
                            MARChannelStringTable* aMARStrings) {
  MacAutoreleasePool pool;

  gApplyUpdateSemaphore = dispatch_semaphore_create(0);
  gClientDisconnectedSemaphore = dispatch_semaphore_create(0);
  gConnectionLock = [[NSObject alloc] init];
  UpdaterHelperListenerDelegate* delegate =
      [[UpdaterHelperListenerDelegate alloc] init];
  gUpdaterHelperListener = [[NSXPCListener alloc]
      initWithMachServiceName:kUpdaterHelperMachServiceName];
  gUpdaterHelperListener.delegate = delegate;
  [gUpdaterHelperListener resume];

  // Wait for the unelevated updater to send applyUpdate. launchd also starts
  // the helper when it is installed and at startup while it is still
  // installed, so remove the helper if no request arrives in time.
  if (dispatch_semaphore_wait(
          gApplyUpdateSemaphore,
          dispatch_time(DISPATCH_TIME_NOW,
                        kApplyUpdateWaitSeconds * NSEC_PER_SEC)) != 0) {
    @synchronized(gConnectionLock) {
      // From here on, applyUpdate replies UpdaterHelperApplyResultBusy.
      gHasTakenRequest = true;
    }
  }

  NSArray<NSString*>* arguments;
  @synchronized(gConnectionLock) {
    arguments = gPendingUpdaterArguments;
  }
  if (!arguments) {
    CleanupElevatedMacUpdate(true);
  }

  *aArgc = (int)arguments.count;
  char** tempArgv = (char**)malloc(sizeof(char*) * (*aArgc));
  for (int i = 0; i < *aArgc; i++) {
    const char* utf8Arg = arguments[i].UTF8String;
    size_t argLen = strlen(utf8Arg) + 1;
    tempArgv[i] = (char*)malloc(argLen);
    memcpy(tempArgv[i], utf8Arg, argLen);
  }
  *aArgv = tempArgv;

  NSString* channelID;
  @synchronized(gConnectionLock) {
    channelID = gPendingMARChannelID;
  }
  const char* channelIDStr = channelID ? channelID.UTF8String : "";
  aMARStrings->MARChannelID =
      std::make_unique<char[]>(strlen(channelIDStr) + 1);
  strcpy(aMARStrings->MARChannelID.get(), channelIDStr);

  // Installing the helper again sends this process SIGTERM, followed by SIGKILL
  // after the plist's ExitTimeOut. Ignore SIGTERM from here on, so that an
  // update in progress gets that long to finish instead of stopping halfway.
  signal(SIGTERM, SIG_IGN);
  // Firefox checks this file before it installs the helper again, because
  // installing it stops the running helper.
  int pidFd = open(UPDATER_HELPER_PID_FILE_PATH,
                   O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW | O_CLOEXEC, 0644);
  if (pidFd >= 0) {
    dprintf(pidFd, "%d\n", getpid());
    close(pidFd);
  }
  return true;
}

void CleanupElevatedMacUpdate(bool aFailureOccurred) {
  MacAutoreleasePool pool;

  void (^reply)(NSInteger) = nil;
  @synchronized(gConnectionLock) {
    reply = gApplyUpdateReplyBlock;
    gApplyUpdateReplyBlock = nil;
  }
  if (reply) {
    // A request that stops before this process wrote a status leaves the
    // client to record ELEVATION_CANCELED.
    if (!DidWriteStatusFile()) {
      reply(UpdaterHelperApplyResultNotRecorded);
    } else if (aFailureOccurred) {
      reply(UpdaterHelperApplyResultFailed);
    } else {
      reply(UpdaterHelperApplyResultSucceeded);
    }
    [reply release];
  }

  // Wait for the client to disconnect before removing the helper. On macOS 13
  // and later the client checks the code signature of the process that sent
  // the reply, and that check fails once this process has exited. The client
  // invalidates the connection after its synchronous applyUpdate call has
  // returned. The wait is bounded so a client that dies without invalidating
  // cannot keep the helper around.
  bool clientConnected;
  @synchronized(gConnectionLock) {
    clientConnected = (gRequestConnection != nil);
  }
  if (clientConnected &&
      dispatch_semaphore_wait(
          gClientDisconnectedSemaphore,
          dispatch_time(DISPATCH_TIME_NOW, 10 * NSEC_PER_SEC)) != 0) {
    LogToOS(NS_T("Updater helper: timed out waiting for the client to "
                 "disconnect after the applyUpdate reply."));
  }

  NSString* helperPath = [@"/Library/PrivilegedHelperTools/"
      stringByAppendingString:kUpdaterHelperMachServiceName];
  NSString* daemonPath =
      [NSString stringWithFormat:@"/Library/LaunchDaemons/%@.plist",
                                 kUpdaterHelperMachServiceName];
  NSFileManager* manager = [NSFileManager defaultManager];
  [manager removeItemAtPath:helperPath error:nil];
  [manager removeItemAtPath:daemonPath error:nil];

  signal(SIGTERM, SIG_DFL);
  unlink(UPDATER_HELPER_PID_FILE_PATH);
  // The following call will terminate the current process.
  LaunchTask(@"/bin/launchctl", @[ @"remove", kUpdaterHelperMachServiceName ]);
  exit(aFailureOccurred ? 1 : 0);
}

// Returns a resumed connection to the privileged helper, or nil. The caller
// owns the returned connection.
static NSXPCConnection* CreateHelperConnection() {
  NSXPCConnection* connection = [[NSXPCConnection alloc]
      initWithMachServiceName:kUpdaterHelperMachServiceName
                      options:NSXPCConnectionPrivileged];
  if (!connection) {
    return nil;
  }
  // On macOS 13 and later the framework itself rejects messages whose peer
  // doesn't satisfy this requirement, every message included. Before macOS 13
  // we rely on launchd's system-domain mach service exclusivity: only a daemon
  // loaded by `launchctl bootstrap system` (which SMJobBless does, after
  // kernel-validated code-signing) can claim this mach service name, so a
  // non-admin attacker cannot impersonate the helper.
  if (@available(macOS 13.0, *)) {
    [connection setCodeSigningRequirement:
                    @MOZ_UPDATER_SMPRIVILEGEDEXECUTABLE_REQUIREMENT_STR];
  }
  connection.remoteObjectInterface =
      [NSXPCInterface interfaceWithProtocol:@protocol(UpdaterHelperProtocol)];
  [connection resume];
  return connection;
}

bool ServeElevatedUpdate(int aArgc, const char** aArgv,
                         const char* aMARChannelID) {
  MacAutoreleasePool pool;

  NSMutableArray<NSString*>* updaterArguments =
      [NSMutableArray arrayWithCapacity:aArgc];
  for (int i = 0; i < aArgc; i++) {
    [updaterArguments addObject:[NSString stringWithUTF8String:aArgv[i]]];
  }
  NSString* channelID =
      aMARChannelID ? [NSString stringWithUTF8String:aMARChannelID] : @"";

  NSXPCConnection* connection = CreateHelperConnection();
  if (!connection) {
    return false;
  }

  __block bool didSucceed = false;
  // A synchronous proxy blocks this thread until either the reply block or the
  // error handler has run, and exactly one of the two always runs, so the
  // applyUpdate result is readable as soon as the send returns.
  id<UpdaterHelperProtocol> proxy = [connection
      synchronousRemoteObjectProxyWithErrorHandler:^(NSError* error) {
        LogToOS([NSString stringWithFormat:@"Updater client XPC error: %@ %ld",
                                           error.domain, (long)error.code]
                    .UTF8String);
      }];

  [proxy applyUpdate:updaterArguments
        marChannelID:channelID
               reply:^(NSInteger aResult) {
                 gDidHelperReply = true;
                 gApplyUpdateResult = aResult;
                 didSucceed = (aResult == UpdaterHelperApplyResultSucceeded);
               }];

  [connection invalidate];
  [connection release];
  return didSucceed;
}

void RemoveLeftoverHelper() {
  MacAutoreleasePool pool;

  NSXPCConnection* connection = CreateHelperConnection();
  if (!connection) {
    return;
  }
  // Usually no helper is registered, and the connection fails right away. The
  // wait is bounded so that a helper that never replies can't keep Firefox
  // from being relaunched.
  // The blocks can still run after this function returns.
  dispatch_semaphore_t done = dispatch_semaphore_create(0);
  id<UpdaterHelperProtocol> proxy =
      [connection remoteObjectProxyWithErrorHandler:^(NSError*) {
        dispatch_semaphore_signal(done);
      }];
  [proxy removeHelperWithReply:^{
    LogToOS(NS_T("A leftover helper acknowledged the removal request"));
    dispatch_semaphore_signal(done);
  }];
  if (dispatch_semaphore_wait(
          done, dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC)) != 0) {
    LogToOS(NS_T("Timed out waiting for a leftover helper"));
  }
  [connection invalidate];
  [connection release];
  dispatch_release(done);
}

bool IsOwnedByGroupAdmin(const char* aAppBundle) {
  MacAutoreleasePool pool;

  NSString* appDir = [NSString stringWithUTF8String:aAppBundle];
  NSFileManager* fileManager = [NSFileManager defaultManager];

  NSDictionary* attributes = [fileManager attributesOfItemAtPath:appDir
                                                           error:nil];
  bool isOwnedByAdmin = false;
  if (attributes &&
      [[attributes valueForKey:NSFileGroupOwnerAccountID] intValue] == 80) {
    isOwnedByAdmin = true;
  }
  return isOwnedByAdmin;
}

void SetGroupOwnershipAndPermissions(const char* aAppBundle) {
  MacAutoreleasePool pool;

  NSString* appDir = [NSString stringWithUTF8String:aAppBundle];
  NSFileManager* fileManager = [NSFileManager defaultManager];
  NSError* error = nil;
  NSArray* paths = [fileManager subpathsOfDirectoryAtPath:appDir error:&error];
  if (error) {
    return;
  }

  // Set group ownership of Firefox.app to 80 ("admin") and permissions to
  // 0775.
  if (![fileManager setAttributes:@{
        NSFileGroupOwnerAccountID : @(80),
        NSFilePosixPermissions : @(0775)
      }
                     ofItemAtPath:appDir
                            error:&error] ||
      error) {
    return;
  }

  NSArray* permKeys = [NSArray
      arrayWithObjects:NSFileGroupOwnerAccountID, NSFilePosixPermissions, nil];
  // For all descendants of Firefox.app, set group ownership to 80 ("admin") and
  // ensure write permission for the group.
  for (NSString* currPath in paths) {
    NSString* child = [appDir stringByAppendingPathComponent:currPath];
    NSDictionary* oldAttributes = [fileManager attributesOfItemAtPath:child
                                                                error:&error];
    if (error) {
      return;
    }
    // Skip symlinks, since they could be pointing to files outside of the .app
    // bundle.
    if ([oldAttributes fileType] == NSFileTypeSymbolicLink) {
      continue;
    }
    NSNumber* oldPerms =
        (NSNumber*)[oldAttributes valueForKey:NSFilePosixPermissions];
    NSArray* permObjects = [NSArray
        arrayWithObjects:[NSNumber numberWithUnsignedLong:80],
                         [NSNumber
                             numberWithUnsignedLong:[oldPerms shortValue] |
                                                    020],
                         nil];
    NSDictionary* attributes = [NSDictionary dictionaryWithObjects:permObjects
                                                           forKeys:permKeys];
    if (![fileManager setAttributes:attributes
                       ofItemAtPath:child
                              error:&error] ||
        error) {
      return;
    }
  }
}
