/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "mozilla/ProcInfo.h"

#include "mozilla/CpuInfo.h"
#include "mozilla/ipc/GeckoChildProcessHost.h"
#include "mozilla/SSE.h"
#include "gfxWindowsPlatform.h"
#include "nsMemoryReporterManager.h"
#include "nsWindowsHelpers.h"
#include <windows.h>
#include <psapi.h>
#include <winternl.h>
#include <xpcpublic.h>

#ifndef STATUS_INFO_LENGTH_MISMATCH
#  define STATUS_INFO_LENGTH_MISMATCH ((NTSTATUS)0xC0000004L)
#endif

#define PR_USEC_PER_NSEC 1000L

typedef HRESULT(WINAPI* GETTHREADDESCRIPTION)(HANDLE hThread,
                                              PWSTR* threadDescription);

namespace mozilla {

static uint64_t ToNanoSeconds(const FILETIME& aFileTime) {
  // FILETIME values are 100-nanoseconds units, converting
  ULARGE_INTEGER usec = {{aFileTime.dwLowDateTime, aFileTime.dwHighDateTime}};
  return usec.QuadPart * 100;
}

nsresult GetCurrentProcessMemoryUsage(uint64_t* aResult) {
  if (!aResult) {
    return NS_ERROR_INVALID_ARG;
  }

  PROCESS_MEMORY_COUNTERS_EX pmc;
  if (!GetProcessMemoryInfo(GetCurrentProcess(),
                            reinterpret_cast<PPROCESS_MEMORY_COUNTERS>(&pmc),
                            sizeof(pmc))) {
    return NS_ERROR_FAILURE;
  }

  *aResult = static_cast<uint64_t>(pmc.PrivateUsage);
  return NS_OK;
}

int GetCycleTimeFrequencyMHz() {
  // Having a constant TSC is required to convert cycle time to actual time.
  // In automation, having short CPU times reported as 0 is more of a problem
  // than having an imprecise value. The fallback method can't report CPU
  // times < 1/64s.
  // Not cached: a process profiled from startup queries this before
  // IsInAutomation() becomes true, which would pin it to the fallback for life.
  if (!mozilla::has_constant_tsc() && !xpc::IsInAutomation()) {
    return 0;
  }

  return GetCpuFrequencyMHz();
}

nsresult GetCpuTimeSinceProcessStartInMs(uint64_t* aResult) {
  int frequencyInMHz = GetCycleTimeFrequencyMHz();
  if (frequencyInMHz) {
    uint64_t cpuCycleCount;
    if (!QueryProcessCycleTime(::GetCurrentProcess(), &cpuCycleCount)) {
      return NS_ERROR_FAILURE;
    }
    constexpr int HZ_PER_MHZ = 1000000;
    *aResult =
        cpuCycleCount / (frequencyInMHz * (HZ_PER_MHZ / PR_MSEC_PER_SEC));
    return NS_OK;
  }

  FILETIME createTime, exitTime, kernelTime, userTime;
  if (!GetProcessTimes(::GetCurrentProcess(), &createTime, &exitTime,
                       &kernelTime, &userTime)) {
    return NS_ERROR_FAILURE;
  }
  *aResult =
      (ToNanoSeconds(kernelTime) + ToNanoSeconds(userTime)) / PR_NSEC_PER_MSEC;
  return NS_OK;
}

nsresult GetGpuTimeSinceProcessStartInMs(uint64_t* aResult) {
  return gfxWindowsPlatform::GetGpuTimeSinceProcessStartInMs(aResult);
}

// Snapshot all processes and invoke aCallback once per process with its
// PSYSTEM_PROCESS_INFORMATION, valid only for that call. aCallback returns
// false to stop early (e.g. on OOM). Shared by GetProcInfoSync and
// GetThreadCountsSync.
template <typename Callback>
static nsresult ForEachSystemProcess(Callback&& aCallback) {
  NTSTATUS ntStatus;
  ULONG bufLen = 512u * 1024u;
  UniquePtr<char[]> buf;

  // We must query for information in a loop, since we are effectively asking
  // the kernel to take a snapshot of all the processes on the system; the size
  // of the required buffer may fluctuate between successive calls.
  while (true) {
    // These allocations can be hundreds of megabytes on some computers, so
    // we should use fallible new here.
    buf = MakeUniqueFallible<char[]>(bufLen);
    if (!buf) {
      return NS_ERROR_OUT_OF_MEMORY;
    }

    ntStatus = ::NtQuerySystemInformation(SystemProcessInformation, buf.get(),
                                          bufLen, &bufLen);
    if (ntStatus != STATUS_INFO_LENGTH_MISMATCH) {
      break;
    }

    // If we need another NtQuerySystemInformation call, allocate a
    // slightly larger buffer than what would have been needed this time,
    // to account for possible process or thread creations that might
    // happen between our calls.
    bufLen += 8u * 1024u;
  }
  if (!NT_SUCCESS(ntStatus)) {
    return NS_ERROR_UNEXPECTED;
  }

  PSYSTEM_PROCESS_INFORMATION processInfo;
  for (ULONG offset = 0;; offset += processInfo->NextEntryOffset) {
    MOZ_RELEASE_ASSERT(offset < bufLen);
    processInfo =
        reinterpret_cast<PSYSTEM_PROCESS_INFORMATION>(buf.get() + offset);

    if (!aCallback(processInfo)) {
      break;
    }

    if (processInfo->NextEntryOffset == 0) {
      break;
    }
  }

  return NS_OK;
}

ProcInfoPromise::ResolveOrRejectValue GetProcInfoSync(
    nsTArray<ProcInfoRequest>&& aRequests) {
  ProcInfoPromise::ResolveOrRejectValue result;

  HashMap<base::ProcessId, ProcInfo> gathered;
  if (!gathered.reserve(aRequests.Length())) {
    result.SetReject(NS_ERROR_OUT_OF_MEMORY);
    return result;
  }

  int frequencyInMHz = GetCycleTimeFrequencyMHz();

  // ---- Copying data on processes (minus threads).

  for (const auto& request : aRequests) {
    nsAutoHandle handle(OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ,
                                    FALSE, request.pid));

    if (!handle) {
      // Ignore process, it may have died.
      continue;
    }

    uint64_t cpuCycleTime;
    if (!QueryProcessCycleTime(handle.get(), &cpuCycleTime)) {
      // Ignore process, it may have died.
      continue;
    }

    uint64_t cpuTime;
    if (frequencyInMHz) {
      cpuTime = cpuCycleTime * PR_USEC_PER_NSEC / frequencyInMHz;
    } else {
      FILETIME createTime, exitTime, kernelTime, userTime;
      if (!GetProcessTimes(handle.get(), &createTime, &exitTime, &kernelTime,
                           &userTime)) {
        // Ignore process, it may have died.
        continue;
      }
      cpuTime = ToNanoSeconds(kernelTime) + ToNanoSeconds(userTime);
    }

    PROCESS_MEMORY_COUNTERS_EX memoryCounters;
    if (!GetProcessMemoryInfo(handle.get(),
                              (PPROCESS_MEMORY_COUNTERS)&memoryCounters,
                              sizeof(memoryCounters))) {
      // Ignore process, it may have died.
      continue;
    }

    // Assumption: values of `pid` are distinct between processes,
    // regardless of any race condition we might have stumbled upon. Even
    // if it somehow could happen, in the worst case scenario, we might
    // end up overwriting one process info and we might end up with too
    // many threads attached to a process, as the data is not crucial, we
    // do not need to defend against that (unlikely) scenario.
    ProcInfo info;
    info.pid = request.pid;
    info.childId = request.childId;
    info.type = request.processType;
    info.origin = request.origin;
    info.windows = std::move(request.windowInfo);
    info.utilityActors = std::move(request.utilityInfo);
    info.cpuTime = cpuTime;
    info.cpuCycleCount = cpuCycleTime;
    info.memory = memoryCounters.PrivateUsage;

    if (!gathered.put(request.pid, std::move(info))) {
      result.SetReject(NS_ERROR_OUT_OF_MEMORY);
      return result;
    }
  }

  // ---- Add thread data to already-copied processes.

  // `GetThreadDescription` is available as of Windows 10.
  // We attempt to import it dynamically, knowing that it
  // may be `nullptr`.
  auto getThreadDescription =
      reinterpret_cast<GETTHREADDESCRIPTION>(::GetProcAddress(
          ::GetModuleHandleW(L"Kernel32.dll"), "GetThreadDescription"));

  bool outOfMemory = false;
  nsresult rv =
      ForEachSystemProcess([&](PSYSTEM_PROCESS_INFORMATION processInfo) {
        ULONG pid = HandleToUlong(processInfo->UniqueProcessId);
        auto processLookup = gathered.lookup(pid);
        if (!processLookup) {
          return true;
        }

        // The thread information structs are stored in the buffer right after
        // the SYSTEM_PROCESS_INFORMATION struct.
        PSYSTEM_THREAD_INFORMATION threadInfos =
            reinterpret_cast<PSYSTEM_THREAD_INFORMATION>(processInfo + 1);
        for (ULONG i = 0; i < processInfo->NumberOfThreads; ++i) {
          PSYSTEM_THREAD_INFORMATION thread = &threadInfos[i];
          ULONG tid = HandleToUlong(thread->ClientId.UniqueThread);

          ThreadInfo* threadInfo =
              processLookup->value().threads.AppendElement(fallible);
          if (!threadInfo) {
            outOfMemory = true;
            return false;
          }

          nsAutoHandle hThread(
              OpenThread(/* dwDesiredAccess = */ THREAD_QUERY_INFORMATION,
                         /* bInheritHandle = */ FALSE,
                         /* dwThreadId = */ tid));
          if (!hThread) {
            // Cannot open thread. Not sure why, but let's erase this thread
            // and attempt to find data on other threads.
            processLookup->value().threads.RemoveLastElement();
            continue;
          }

          threadInfo->tid = tid;

          // Attempt to get thread times.
          // If we fail, continue without this piece of information.
          if (QueryThreadCycleTime(hThread.get(), &threadInfo->cpuCycleCount) &&
              frequencyInMHz) {
            threadInfo->cpuTime =
                threadInfo->cpuCycleCount * PR_USEC_PER_NSEC / frequencyInMHz;
          } else {
            FILETIME createTime, exitTime, kernelTime, userTime;
            if (GetThreadTimes(hThread.get(), &createTime, &exitTime,
                               &kernelTime, &userTime)) {
              threadInfo->cpuTime =
                  ToNanoSeconds(kernelTime) + ToNanoSeconds(userTime);
            }
          }

          // Attempt to get thread name.
          // If we fail, continue without this piece of information.
          if (getThreadDescription) {
            PWSTR threadName = nullptr;
            if (getThreadDescription(hThread.get(), &threadName) &&
                threadName) {
              threadInfo->name = threadName;
            }
            if (threadName) {
              LocalFree(threadName);
            }
          }
        }
        return true;
      });

  if (outOfMemory) {
    result.SetReject(NS_ERROR_OUT_OF_MEMORY);
    return result;
  }
  if (NS_FAILED(rv)) {
    result.SetReject(rv);
    return result;
  }

  // ----- We're ready to return.
  result.SetResolve(std::move(gathered));
  return result;
}

ThreadCountPromise::ResolveOrRejectValue GetThreadCountsSync(
    nsTArray<ThreadCountRequest>&& aRequests) {
  ThreadCountPromise::ResolveOrRejectValue result;

  // Index requests by pid for the snapshot lookup below.
  HashMap<ULONG, uint64_t> requestedPids;
  if (!requestedPids.reserve(aRequests.Length())) {
    result.SetReject(NS_ERROR_OUT_OF_MEMORY);
    return result;
  }
  for (const auto& request : aRequests) {
    if (!requestedPids.put(static_cast<ULONG>(request.pid),
                           request.requestId)) {
      result.SetReject(NS_ERROR_OUT_OF_MEMORY);
      return result;
    }
  }

  CopyableTArray<ThreadCountResult> counts;
  counts.SetCapacity(aRequests.Length());

  // The count is already in the snapshot; no per-thread work.
  nsresult rv =
      ForEachSystemProcess([&](PSYSTEM_PROCESS_INFORMATION processInfo) {
        ULONG pid = HandleToUlong(processInfo->UniqueProcessId);
        if (auto lookup = requestedPids.lookup(pid)) {
          counts.AppendElement(ThreadCountResult{
              lookup->value(),
              static_cast<uint32_t>(processInfo->NumberOfThreads)});
        }
        return true;
      });
  if (NS_FAILED(rv)) {
    result.SetReject(rv);
    return result;
  }

  result.SetResolve(std::move(counts));
  return result;
}

}  // namespace mozilla
