# Providers, Results and the View

Paths are relative to `browser/components/urlbar/`. Background:
`browser/components/urlbar/docs/overview.md`,
`browser/components/urlbar/docs/dynamic-result-types.md`,
`browser/components/urlbar/docs/preferences.md`, and the JSDoc of
`UrlbarProvider` (in `UrlbarUtils.sys.mjs`), `UrlbarResult`,
`UrlbarQueryContext` and `UrlbarPrefs`.

## Provider contract

- **`isActive` returns a promise and never throws synchronously.**
  `Query.start` in `UrlbarProvidersManager.sys.mjs` calls `.then` on it outside
  `tryMethod`, so a sync throw breaks the start loop for every provider.
- **A raised `getPriority` is meant to suppress every lower-priority provider**,
  since only the highest-priority active providers run.
- **`startQuery` returns early after every `await` once the query is stale**
  (`instance != this.queryInstance`). A provider instance is shared by every
  input with its SAP, so it serves concurrent queries; `add()` drops late
  results, but the network or database work still happens. An async `startQuery`
  catches its own rejections, since `tryMethod` catches only sync throws.
- **`cancelQuery` releases what `startQuery` holds** (e.g. timers, fetches,
  listeners). SQL that must not be interrupted goes through
  `runInCriticalSection`, because cancelling the Places provider's search
  interrupts the shared Places connection.
- **A provider doesn't cache what it read during a query that may be
  cancelled.** An interrupted statement on the shared Places connection doesn't
  reject; it resolves with the rows read so far, often none. Check
  `queryContext.canceled` after the `await` before storing the answer, or the
  cache keeps a wrong value after the cancel. The interrupt is connection-wide,
  so a cancel in one search bar also cuts short what another is reading.
- **A heuristic provider answers `isActive` and `startQuery` fast and adds its
  heuristic result first.** Every result waits on pending heuristic providers. A
  new heuristic result needs a case in `UrlbarShared.getResultGroup` and a
  `HEURISTIC_*` group placed in the `UrlbarPrefs` group trees (e.g.
  `makeDefaultResultGroups`), or it falls back to `HEURISTIC_FALLBACK`.
  Non-heuristic providers start only after the `browser.urlbar.delay` timer.
- **A new provider has an entry in `localProviderModules` with the right
  `supportedSAPs` and a unique `name`**, and its name joins the provider list in
  `metrics.yaml`. A duplicate name leaves both registered, but lookups by name
  find only the first.
- **A provider that fetches remote data checks
  `queryContext.allowRemoteResults()` and its own `suggest.*` pref.** The source
  filter doesn't check `suggest.searches`, so a stray suggestion means the
  network was already hit.
- **Every command `getResultCommands` returns is handled in `onEngagement`**,
  built-ins such as "help" aside. Dynamic results with pickable elements
  implement `onEngagement`, which only the provider that made `details.result`
  receives.
- **Code never mutates a result after `add()` and expects the view to see it.**
  The view holds a snapshot from across the boundary. A dismissal goes through
  `controller.removeResult(result, { acknowledgeDismissal: true })`, and rows
  match by `result.id`.

## Result construction

- **A new payload property on a non-dynamic type is added to
  `UrlbarUtils.RESULT_PAYLOAD_SCHEMA`**, or the constructor throws. Validation
  is skipped in a content realm, so a payload the view builds itself fails only
  in chrome. `#validatePayload` never transforms the payload, since `fromWire`
  skips validation.
- **A new private field on `UrlbarResult` is added to `toWire()`, and a public
  property set after construction is re-applied in `fromWire()`.** Payload,
  `viewTemplate` and `viewUpdate` stay structured-clonable (e.g. no UniFFI
  objects). A new `UrlbarQueryContext` field holding a result or a class
  instance needs the same `toWire()`/`fromWire()` handling.
- **`source` is the most privacy-restricted source involved.** `OTHER_NETWORK`
  is excluded in private windows and under restriction tokens, and heuristic
  results bypass the source filter.
- **Highlighting goes through the constructor's `highlights` option**
  (`HIGHLIGHT.TYPED`, `SUGGESTED`, `ALL` or index arrays), not through payload
  values.
- **`suggestedIndex` and `resultSpan` are set deliberately.** A negative
  `suggestedIndex` counts from the end and is global unless
  `isSuggestedIndexRelativeToGroup` is set, and the view won't reuse a row
  across `suggestedIndex` values. A result without `resultSpan` spans 1 (3 for
  tips, see `UrlbarShared.getSpanForResult`), and a larger span uses up
  `maxResults`.
- **A new `UrlbarQueryContext` option is added to `optionalProperties` with a
  validator**, or it is silently dropped.

## Muxer and groups

- **New state in `UrlbarMuxerStandard` is added to `_copyState`**, deep-copied
  for a Map, Set or array, or flex passes corrupt each other.
- **A new pass over the results in `sort` is justified against its cost.** It
  runs several times per keystroke, so new logic joins the existing passes where
  it can, rather than adding a `find`, `filter` or `sort`.
- **A new input to `UrlbarPrefs.getResultGroups` joins its cache key**, and a
  pref that feeds it clears the cached groups in `onPrefChanged`.
- **A group with `orderBy` receives its results contiguously**, since the
  pre-sort splices one range. `flex` belongs only on children of a
  `flexChildren: true` group, where `maxResultCount` is ignored.

## View and dynamic result types

- **`getViewTemplate` and `getViewUpdate` are synchronous and don't throw.**
  They run in the parent inside `Query.add`, outside `tryMethod`; they can't
  reference the DOM or row IDs, and `controller` may be null.
- **A view update that sets an attribute, style or `textContent` for one result
  sets it for every result of that type**, with `null` to clear. A row is reused
  when the provider, `dynamicType` and a deep-equal `viewTemplate` match;
  `undefined` is skipped and only the row element's own attributes are reset.
- **A view update never sets `id`, which is reserved.** `classList` replaces the
  existing classes, and `l10n` wins over `textContent`.
- **The template root has `role=group`, and `selectable` or `role=button` marks
  keyboard stops.** See `browser/components/urlbar/docs/dynamic-result-types.md`
  "Accessibility".
- **`dynamicType` is a valid CSS identifier**, and styling goes in
  `browser/themes/shared/urlbar/dynamic-results.css` under
  `.urlbarView-dynamic-<type>-<name>`.

## Prefs and Nimbus

- **A pref read through `UrlbarPrefs` is declared in `PREF_URLBAR_DEFAULTS`
  (relative to `browser.urlbar.`) or `PREF_OTHER_DEFAULTS` (full name).** The
  type comes from the default: `[v, "float"]` for a float, `"utf8"` for a string
  that may hold non-ASCII. A default in `browser/app/profile/firefox.js` wins
  over the `UrlbarPrefs` one, so check that its value, including any `#ifdef`
  channel branch, is the one the patch intends.
- **A Nimbus variable has a `fallbackPref` in `FeatureManifest.yaml` or an entry
  in `NIMBUS_DEFAULTS`**, or `get()` throws outside an enrollment. Nimbus values
  can't be set, cleared or asked for a user value, and no pref name equals a
  variable name.
- **A value derived in `_getPrefValue` is invalidated in `onPrefChanged` for
  each pref it reads**, and a pref that changes which results show is in
  `affectsResults`.
- **A `UrlbarPrefs` observer is held strongly by its owner**, since observers
  are held weakly. Nimbus changes arrive through `onNimbusChanged`.
