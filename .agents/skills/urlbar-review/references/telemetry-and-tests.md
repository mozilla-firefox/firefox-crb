# Telemetry and Tests

Paths are relative to `browser/components/urlbar/`. Background:
`browser/components/urlbar/docs/telemetry.md`,
`browser/components/urlbar/docs/firefox-suggest-telemetry.md` and
`browser/components/urlbar/docs/testing.md`.

## Engagement telemetry

- **A new result type, sub-type or provider has a branch in
  `UrlbarShared.searchEngagementTelemetryType()`**, or its rows report
  `unknown`. A new group has a case in `searchEngagementTelemetryGroup()`, and a
  new global action key joins the `actions` list in `metrics.yaml`.
- **A new type string goes in `selected_result` and `results` of
  `urlbar.engagement` in `metrics.yaml` and in `results` of
  `urlbar.abandonment`**, and a new group goes in `groups` of both. The other
  engagement events refer back to the `urlbar.engagement` lists.
- **Every metric or event change appends the bug to `bugs:` and a matching
  entry to `data_reviews:`**, and keeps `data_sensitivity`,
  `notification_emails` and `expires` set. The revision has the data
  classification tag for that sensitivity.
- **Renaming a telemetry type needs sign-off from search telemetry and the
  owners of running experiments.** The same string keys Nimbus exposure matching
  (`#setExposureTelemetryProperty` in `UrlbarMuxerStandard.sys.mjs`) and
  dashboards.
- **A metric in a custom ping names a ping in `pings.yaml`.** `quick-suggest`
  and `urlbar-keyword-exposure` keep `include_client_id: false`, OHTTP upload
  and no info sections, and the keyword exposure ping is never submitted from
  private windows.
- **A content-process search bar sends `RecordEngagement` before the `LoadURL`
  that unloads its page, and records abandonment on blur.** See
  `browser/components/urlbar/docs/telemetry.md` "Engagements from a search bar
  in a web page".

## Firefox Suggest telemetry

- **A new Suggest feature sets `payload.telemetryType`**, which makes the
  engagement type `<source>_<telemetryType>`, and its unit test calls
  `doTelemetryTypeTest`.
- **A change to the `quick-suggest` ping's contents is tested with
  `initQuickSuggestPingTest` and `doQuickSuggestPingTest`** in a
  `browser_quicksuggest_ping_*.js` test.
- **New data sent to Merino needs a data collection review** and an update to
  the Merino section of
  `browser/components/urlbar/docs/firefox-suggest-telemetry.md`.

## Tests

| Directory | Holds |
|---|---|
| `tests/unit/` | xpcshell tests of providers, the muxer, utilities, autofill |
| `tests/browser/` | browser tests that fit no topic directory |
| `tests/browser/searchbar/` | the urlbar-based toolbar search bar |
| `tests/browser-newtab/` | the New Tab search bar, over the message path |
| `tests/browser-<topic>/` | browser tests by topic, e.g. `browser-results`, `browser-searchMode` |
| `tests/browser-engagementTelemetry/` | Glean engagement, abandonment, exposure, bounce |
| `tests/quicksuggest/` | Firefox Suggest, Merino and the `quick-suggest` ping |

- **A behavior change in code reachable from content (i.e. the input, the view,
  the actors, or a provider hook the view calls) has a test that runs over the
  message path**: in `tests/browser-newtab/`, or in a directory tagged `urlbar`,
  which the `urlbar-ipc` CI variant runs with
  `browser.urlbar.ipc.chromeMessagePassing=true`. A test that only passes on the
  direct path doesn't cover the items in `boundary.md`. A change confined to
  parent-side query code (e.g. the providers manager, a provider's `startQuery`)
  behaves the same on both paths, and an xpcshell test covers it. An xpcshell
  test also covers a `UrlbarParentController` method that content reaches over
  the actor, unless its arguments or return value change; the serializability
  items in `boundary.md` cover those.
- **Provider and muxer logic gets an xpcshell test in `tests/unit/`, and UI
  behavior a browser test in its topic directory.**
- **A new browser test directory joins `BROWSER_CHROME_MANIFESTS` in
  `moz.build`**, sets `tags = "urlbar"` in `[DEFAULT]` (without it, `urlbar-ipc`
  never runs it) and lists `../browser/head-common.js` and its own `head.js` in
  `support-files`.
- **A pref every test in a directory needs goes in the manifest's `[DEFAULT]`
  prefs, and a per-test pref uses `SpecialPowers.pushPrefEnv`.** A test that
  relies on a directory default (e.g. `browser.urlbar.suggest.engines=false` in
  `tests/unit/`) lives where that default applies.
- **A test cleans up history, bookmarks, form history, engines, Nimbus
  enrollments and stubs.** `initNimbusFeature()` returns a cleanup that must be
  called; `ensureQuickSuggestInit()` registers its own.
- **Tests wait for the parent rather than assume a synchronous answer.** Queries
  go through `UrlbarTestUtils.promiseAutocompleteResultPopup`, never with
  `fireInputEvent: false` when engagement telemetry or `userTypedValue` is
  checked. The `assert*Telemetry` helpers in `head-common.js` are awaited, apart
  from the synchronous `assertDisableTelemetry`.
  `promiseControllerNotification()` and `promiseProviderEngagement()` are
  created before the action, and picks are checked with `assertPickedResult()`.
  See `browser/components/urlbar/docs/testing.md` "Waiting for the Parent".
- **A test that can't run on the message path has `skip-if = ["urlbar_ipc"]`
  with a reason**, and a stub forcing a race applies only when
  `browser.urlbar.ipc.chromeMessagePassing` is set.
- **A New Tab search bar test drives the input through
  `NewtabSearchbarTestUtils`**, opens the page with
  `NewtabSearchbarTestUtils.openNewTabPage()` or `add_telemetry_task`, and adds
  no test hook on `UrlbarChild` or `window.UrlbarActorPort`, which ship in
  release.
- **Suggest tests set up through `QuickSuggestTestUtils.ensureQuickSuggestInit`
  and use `MerinoTestUtils.server` and `RemoteSettingsServer`**, never the
  network.

## Type checking

- **`tsconfig.json` checks every `.mjs` and `.sys.mjs` file and `types/*.ts`,
  apart from its `exclude` list.** Test `.js` files and `head*.js` are never
  checked, so a green `typescript` lint says nothing about them.
- **A patch doesn't add to `exclude` or add `@ts-nocheck`**, and adds
  `@ts-ignore` or `@ts-expect-error` only where no annotation fixes the error.
