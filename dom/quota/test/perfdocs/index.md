# QuotaManager Performance Testing

Two raptor/browsertime suites cover the quota manager. The storage
initialization tests (`si-*`) time `QuotaManager::LoadQuota()` for profiles
left in different states, and are the ones to watch for regressions. The
quota usage tests (`quota-usage-*`) assert the byte counts
`navigator.storage.estimate()` reports.

Both suites run against a conditioned profile that condprof builds on the
fly, behind a mitmproxy that serves the test pages for synthetic hosts, so no
recordings and no live sites are involved.

## How to run the storage initialization tests on CI

- Desktop (Linux, Windows and macOS 64-bit shippable):
  `mach try perf --full -q "shippable-browsertime-storage-initialization !-mobile"`

- One desktop platform:
  `mach try perf --full -q "test-linux1804-64-shippable-qr/opt-browsertime-storage-initialization"`

- Android (Fenix on the Samsung A55, aarch64, the primary Android
  performance platform; the mobile tasks run only there):
  `mach try perf --full -q "android-hw-a55 shippable browsertime-storage-initialization-mobile"`

- The task names are `browsertime-storage-initialization` (desktop) and
  `browsertime-storage-initialization-mobile` (Android); both are tier 2 and
  run on autoland and mozilla-central. Each task builds its conditioned
  profile from scratch, so the run time includes profile construction.

- The Treeherder symbol is `Btime(si)`; subtests appear as `si-clean`,
  `si-crash`, and so on. Perfherder alerts on each `loadQuotaMs-*` subtest
  separately.

## How to run the storage initialization tests locally

Building the profile needs the geckodriver that was built together with the
Firefox binary under test. Put its directory first on `PATH`
(`<objdir>/x86_64-unknown-linux-gnu/<variant>` for local Linux builds) or
pass it with `--browsertime-geckodriver`.

- One subtest, headless:
  `./mach raptor --browsertime -t si-clean --browsertime-arg headless=true`

- With a profile for the Firefox Profiler:
  `./mach raptor --browsertime -t si-dirty --gecko-profile --browsertime-arg headless=true`

- Android, with a device connected over adb and Fenix installed:
  `./mach raptor --browsertime -t si-clean --app fenix --binary org.mozilla.fenix`.
  The proxy certificate is installed with `certutil`, so `MOZ_HOST_BIN` must
  point at a desktop build's `dist/bin`, as for any raptor Android run.

The first run of a subtest builds its conditioned profile and caches it in
`~/.condprof-cache`; later runs reuse it. Delete the archive there to force
a rebuild, for example after changing the scenario or the customization.

## What the storage initialization subtests measure

Every subtest reports the wall-clock duration of `QuotaManager::LoadQuota()`
on the quota manager I/O thread, read from `loadQuotaDurationMs` on
`nsIQuotaManagerServiceInternal` after the test page has loaded. The profile
holds 100 origins (hosts `test-<hash>.org`, derived from a fixed nonce) that
each wrote one localStorage item, or one IndexedDB record for the `Idb`
variant. The test navigates to origin number 1 of that set.

`LoadQuota()` has two paths. When the cache in `storage.sqlite` is usable it
reads the `origin` table (`LoadQuotaFromCache`): a clean row of an origin
that was accessed recently is turned into in-memory quota state directly,
a clean row of an unaccessed origin is skipped until the origin is used,
and a row with the dirty flag or an inconsistent usage goes through
`RestoreAndInitializeOrigin`, which reads the origin directory's
`.metadata-v2` file and re-initializes the origin from disk. When the cache
is not usable, `InitializeRepository` enumerates every origin directory of
the temporary and default repositories and initializes each one. Rows are
written by the flush timer once an origin has been write-quiescent for
`dom.quotaManager.originWriteQuiescentThresholdMs`, and by `UnloadQuota()`
at a clean shutdown, which also records the build id.

- `si-clean`: the scenario ran once and shut down cleanly. Every row is
  clean and the build id is set, so this is the pure cache path and the
  baseline.
- `si-crash`: the scenario's only session was killed. `UnloadQuota()` never
  ran, so the cache carries no build id. This subtest alone keeps
  `dom.quotaManager.caching.checkBuildId=true`, so `LoadQuota()` rejects
  the cache and runs the full `InitializeRepository` scan over all 100
  origin directories, as production does after a crash in a profile's
  first session. The rows written at origin creation exist but are never
  read.
- `si-dirty`: two sessions. The first writes clean rows for all origins and
  shuts down cleanly; the second touches every origin again and is killed
  before any of them becomes quiescent. All 100 rows exist, carry stale
  usage and the dirty flag, and all go through `RestoreAndInitializeOrigin`.
- `si-nocache`: `storage.sqlite` is deleted after the build. Storage
  initialization recreates the database and its cache tables, which marks
  the cache unusable for the session, so `LoadQuota()` takes the full
  `InitializeRepository` scan and `UnloadQuota()` repopulates the rows.
- `si-crInit`: after a clean first session,
  `dom.quotaManager.storageInitialization.pauseOnIOThreadMs` holds
  `EnsureStorageIsInitialized` for 30 s and the browser is killed during
  the pause, so the measured startup follows a crash inside storage
  initialization.
- `si-crShut`: same, with `dom.quotaManager.shutdown.pauseOnIOThreadMs`
  holding `ShutdownStorageInternal` before `UnloadQuota()`, so the measured
  startup follows a crash during quota manager shutdown.
- `si-dirtyIdb`: `si-dirty` with IndexedDB instead of localStorage, so the
  recovery reads IndexedDB client directories.

### Cold and warm iterations

On desktop each test runs two browser cycles (`browser_cycles = 2`). The
first cycle measures the state the conditioned profile scenario built; it
then shuts down cleanly, which leaves the second cycle to measure an
already-valid cache. The support script reports them as `loadQuotaMs-cold`
and `loadQuotaMs-warm` so that perfherder never averages them together.

On Android only `loadQuotaMs-cold` is reported. geckodriver replaces the
on-device profile with the host template before every session, so a second
cycle would measure another cold start rather than a warm one.

### Test-time preferences

The conditioned profile is built with shortened flush intervals to speed up
construction, and its `user.js` is removed after the build so that only the
manifest's `preferences` apply at test time. Two of them matter for the
results:

- `dom.quotaManager.caching.checkBuildId=false`: a killed session leaves the
  `.startup-incomplete` marker behind, and the next startup then asks the
  quota manager to drop its cache rows unless this is off. The recovery
  variants would otherwise measure an emptied cache instead of recovery.
  `si-crash` turns the check back on through `browsertime_args`, because
  rejecting the cache is the behaviour it measures.
- `dom.quotaManager.originWriteQuiescentThresholdMs=500`: the flush
  threshold during the measured sessions.

## Quota usage assertion tests

These tests populate specific storage types in a conditioned profile and
report the usage `navigator.storage.estimate()` returns, so a change in the
reported byte count shows up as a perfherder alert
(`alert_threshold = 0.01`). They are an assertion dressed as a performance
test, not a timing measurement.

### Running on CI

- Desktop:
  `mach try perf --full -q "shippable-browsertime-quota-usage !-mobile"`
- Android (Samsung A55, aarch64):
  `mach try perf --full -q "android-hw-a55 shippable browsertime-quota-usage-mobile"`

The tasks are `browsertime-quota-usage` and `browsertime-quota-usage-mobile`,
Treeherder symbol `Btime(qu)`. CI schedules the small variants only.

### Running locally

- One subtest, headless:
  `./mach raptor --browsertime -t quota-usage-all --browsertime-arg headless=true`
- A large variant:
  `./mach raptor --browsertime -t quota-usage-all-large --browsertime-arg headless=true`

### Subtests

Each storage type has its own subtest so that a regression in reported
usage can be traced to the responsible component:

- `quota-usage-ls`: localStorage
- `quota-usage-idb-v`: IndexedDB inline (value) storage
- `quota-usage-idb-eb`: IndexedDB external blob storage
- `quota-usage-cache`: Cache API
- `quota-usage-fs`: Origin Private File System (OPFS)
- `quota-usage-all`: all five in one profile. A regression here that does
  not appear in the per-type tests indicates interference between
  components.

Each subtest exists in two sizes. The small variants write 1 byte of user
data, which fits on a single database page and measures bookkeeping
overhead. The `-large` variants write 1 MB, which spans many database
pages (about 1000 localStorage pages at 1024 bytes, 250 IndexedDB pages at
4096 bytes) and exercises paging and caching code.

## Customizing a run from the command line

The profile a subtest builds is controlled by its `customization` in the
manifest, a JSON object of overrides applied to the scenario's base
customization (`qm_init.json` or `qm_use.json` in
`testing/condprofile/condprof/customization/`). The command line can override
that through raptor's `--browsertime-arg` passthrough: `condprof.customization`
takes a customization name or a JSON object whose keys are merged over the
manifest's (command-line keys win), and `condprof.scenario` picks another
condprof scenario.

For the storage initialization scenario the useful keys are `max_urls`
(number of origins, 100 in the manifests), `dirty_shutdown` (kill the
browser instead of shutting down cleanly) and `storage_api` (`"ls"` or
`"idb"`). A quick crash-recovery run over 50 origins:

    ./mach raptor --browsertime -t si-clean \
        --browsertime-arg 'condprof.customization={"max_urls": 50, "dirty_shutdown": true}'

For the quota usage scenario, `storage_types` and `data_size_bytes`. To
populate 1 MB instead of 1 byte:

    ./mach raptor --browsertime -t quota-usage-ls \
        --browsertime-arg 'condprof.customization={"data_size_bytes": 1048576}'

A key without `/` is applied to every step of a multi-step subtest such as
`si-dirty`; use an exact `scenario` list to change a single step. Each
distinct customization is cached separately in `~/.condprof-cache`.
