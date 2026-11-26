# QuotaManager Performance Testing

## Quota Usage Assertion Tests

These tests assert the byte count that `navigator.storage.estimate()`
reports after populating specific storage types via a conditioned profile.

### Test strategy

**Defect isolation.** Each storage type has its own subtest so that a
regression in reported usage can be traced to the responsible component:

- `quota-usage-ls` -- localStorage
- `quota-usage-idb-v` -- IndexedDB inline (value) storage
- `quota-usage-idb-eb` -- IndexedDB external blob storage
- `quota-usage-cache` -- Cache API
- `quota-usage-fs` -- Origin Private File System (OPFS)

**Cross-component interference.** The combined `quota-usage-all` subtest
populates all five storage types in a single profile. A regression here
that does not appear in the per-type tests indicates interference between
components.

**Small vs. large data sizes.** Each subtest exists in two variants:

- **Small** (1 byte of user data) -- fits on a single database page.
  Measures QuotaManager bookkeeping overhead without paging or caching
  effects.
- **Large** (1 MB of user data) -- spans many database pages
  (approximately 1000 localStorage pages at 1024 bytes, 250 IndexedDB
  pages at 4096 bytes). Exercises caching and paging code paths that
  small data does not reach.

The large variants use the `-large` suffix (e.g. `quota-usage-ls-large`).

### Running quota-usage tests locally

The support class builds the conditioned profile with condprof the first
time a subtest runs and caches it in `~/.condprof-cache`, then starts the
scenario's intercept proxy for the test itself. Building the profile needs
the geckodriver that was built together with the Firefox binary under
test: put its directory (`<objdir>/x86_64-unknown-linux-gnu/<variant>` for
local builds) first on `PATH`, or pass it with `--browsertime-geckodriver`.

Run a single subtest, headless:

    ./mach raptor --browsertime -t quota-usage-all --browsertime-arg headless=true

Run a large variant:

    ./mach raptor --browsertime -t quota-usage-all-large --browsertime-arg headless=true

The profile a subtest builds is controlled by its `customization` in the
manifest. The command line can override that through raptor's
`--browsertime-arg` passthrough: `condprof.customization` takes a
customization name or a JSON object whose keys are merged over the
manifest's (command-line keys win), and `condprof.scenario` picks another
condprof scenario. For example, to populate 1 MB instead of 1 byte:

    ./mach raptor --browsertime -t quota-usage-ls \
        --browsertime-arg 'condprof.customization={"data_size_bytes": 1048576}'

Each distinct customization is cached separately; delete the archive from
`~/.condprof-cache` to force a rebuild.

### Running quota-usage tests on CI

    mach try perf --full -q "browsertime-quota-usage"
