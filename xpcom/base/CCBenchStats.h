/* -*- Mode: C++; tab-width: 8; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Local-only instrumentation for CC graph building benchmarks. Not for landing.
//
// MOZ_CC_BENCH=1: print one timing line per CC.
// MOZ_CC_BENCH=2: also collect and print traversal counters (slows the CC).

#ifndef xpcom_base_CCBenchStats_h
#define xpcom_base_CCBenchStats_h

#include <cstdint>
#include <cstring>
#include <cstdlib>
#include <fcntl.h>
#include <unistd.h>
#include <unordered_set>

#include "mozilla/TimeStamp.h"

namespace mozilla::ccbench {

inline int Level() {
  static const int sLevel = [] {
    const char* env = getenv("MOZ_CC_BENCH");
    return env ? atoi(env) : 0;
  }();
  return sLevel;
}

inline bool Counting() { return Level() >= 2; }

constexpr size_t kNumKinds = 16;

struct KindStats {
  uint64_t calls = 0;
  uint64_t filtered = 0;
  uint64_t noted = 0;
  uint64_t recursed = 0;
};

struct Stats {
  const char* reason = "";
  double fixGrayMs = 0;
  double rootsMs = 0;
  double buildMs = 0;
  double scanMs = 0;
  double collectWhiteMs = 0;
  uint32_t buildSlices = 0;
  uint32_t graphNodes = 0;
  uint32_t graphRoots = 0;

  uint64_t edges = 0;
  uint64_t edgesToJS = 0;
  uint64_t edgesToNative = 0;

  uint64_t traverseGCThing = 0;
  uint64_t traverseGCThingBlack = 0;
  uint64_t xpcomChildCalls = 0;
  uint64_t xpcomChildNone = 0;

  KindStats kinds[kNumKinds];
  KindStats kindsInShape[kNumKinds];

  uint64_t shapeVisits = 0;
  uint64_t distinctShapes = 0;
  uint64_t shapeMaps = 0;
  uint64_t shapeKeys = 0;
  uint64_t distinctShapeMaps = 0;
  uint64_t distinctShapeKeys = 0;
  uint32_t shapeDepth = 0;
  std::unordered_set<const void*>* seenShapes = nullptr;

  void Reset() {
    auto* seen = seenShapes;
    *this = Stats();
    seenShapes = seen;
    if (seenShapes) {
      seenShapes->clear();
    }
  }
};

inline Stats& Get() {
  static thread_local Stats sStats;
  return sStats;
}

class AutoTimer {
 public:
  explicit AutoTimer(double& aAccum)
      : mAccum(Level() ? &aAccum : nullptr),
        mStart(mAccum ? TimeStamp::Now() : TimeStamp()) {}
  ~AutoTimer() {
    if (mAccum) {
      *mAccum += (TimeStamp::Now() - mStart).ToMilliseconds();
    }
  }

 private:
  double* mAccum;
  TimeStamp mStart;
};

// With MOZ_CC_BENCH_PERF_CTL/MOZ_CC_BENCH_PERF_ACK naming the fifos given to
// `perf stat|record --control fifo:CTL,ACK -D -1`, counting is enabled only
// inside this scope. MOZ_CC_BENCH_PERF_PHASE selects the phase (default
// "build", or "all"); with MOZ_CC_BENCH_PERF_GATE set, only while
// MOZ_CC_BENCH_PERF_ON is also set.
class PerfScope {
 public:
  PerfScope(bool aActive, const char* aPhase)
      : mActive(aActive && Fds().ctl >= 0 && Selected(aPhase)) {
    if (mActive) {
      Send("enable\n");
    }
  }
  ~PerfScope() {
    if (mActive) {
      Send("disable\n");
    }
  }

 private:
  struct FdPair {
    int ctl = -1;
    int ack = -1;
  };
  static FdPair& Fds() {
    static FdPair sFds = [] {
      FdPair f;
      const char* ctl = getenv("MOZ_CC_BENCH_PERF_CTL");
      const char* ack = getenv("MOZ_CC_BENCH_PERF_ACK");
      if (ctl && ack) {
        f.ctl = open(ctl, O_WRONLY);
        f.ack = open(ack, O_RDONLY);
      }
      return f;
    }();
    return sFds;
  }
  static bool Selected(const char* aPhase) {
    static const char* sPhase = [] {
      const char* p = getenv("MOZ_CC_BENCH_PERF_PHASE");
      return p ? p : "build";
    }();
    static const bool sGated = getenv("MOZ_CC_BENCH_PERF_GATE");
    if (sGated) {
      const char* on = getenv("MOZ_CC_BENCH_PERF_ON");
      if (!on || !*on) {
        return false;
      }
    }
    return !strcmp(sPhase, "all") || !strcmp(sPhase, aPhase);
  }
  static void Send(const char* aMsg) {
    auto& f = Fds();
    (void)!write(f.ctl, aMsg, strlen(aMsg));
    char buf[8];
    (void)!read(f.ack, buf, sizeof(buf));
  }
  bool mActive;
};

}  // namespace mozilla::ccbench

#endif  // xpcom_base_CCBenchStats_h
