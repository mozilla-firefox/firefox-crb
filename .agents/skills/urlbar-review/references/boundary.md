# Process Boundary and Search Access Points

Paths are relative to `browser/components/urlbar/`. Background:
`browser/components/urlbar/docs/process-boundary.md`,
`browser/components/urlbar/docs/message-path.md`,
`browser/components/urlbar/docs/lifetime.md`,
`browser/components/urlbar/docs/utilities.md` and
`browser/components/urlbar/docs/adding-a-search-bar.md`.

## Which side code runs on

- **Code reachable from the input or view uses nothing privileged without a
  realm check.** That rules out `Services`, `ChromeUtils`, `Cu`, `windowUtils`,
  `gBrowser`, `UrlbarPrefs.sys.mjs` and the `lazy` getters in
  `content/UrlbarInputBase.mjs`, which are undefined in a content realm, and
  `Iface.isInstance()`, which throws there. `handleEvent` swallows the throw, so
  the feature silently does nothing on New Tab. DOM interface checks use
  `UrlbarShared.isInstance()`. Parent-only services (e.g.
  `ContextualIdentityService`, the keyword lookup of `Services.uriFixup`) are
  reached through a `UrlbarContentUtils` accessor or a parent controller method.
- **A helper goes in `content/UrlbarShared.mjs` only when both sides need it and
  it uses nothing privileged and no `window`.** Otherwise it goes in
  `UrlbarUtils.sys.mjs`. Each realm gets its own copy of `UrlbarShared`, so
  module state there is per realm.
- **Content reads prefs through `content/UrlbarContentPrefs.mjs`.** A pref
  method it lacks is added to the port in `UrlbarChild.createPort()`, or it is
  undefined in content.
- **Parent-only work runs in `UrlbarParentController` behind a method.** That
  covers Places writes, Glean recording, the search service, tabbrowser
  bookkeeping, `openPreferences` and infobars. Address-bar-only code in the
  input (after an `#isAddressbar` check, or in `setURI()`) always runs in
  chrome and may use `browserWindow.gBrowser` directly, as the `overrideValue`
  accessors do.

## The actor wire contract

- **A `UrlbarParentController` method the child calls is wired on both ends.**
  It needs a method in `content/UrlbarParentControllerProxy.mjs`, a `case` in
  `UrlbarParent.receiveMessage` (an unknown name returns `undefined`), and
  `toWire`/`fromWire` on query context and result arguments and return values.
  A call that returns a value uses `sendQuery`, and its `case` returns rather
  than `break`s. A miss works on the direct path and does nothing on the message
  path.
- **A new `receiveMessage` handler validates its payload:** a numeric
  `instanceId`, a known name, a live controller, and any field that decides
  privacy or recording.
- **A message handler assumes the content process may be compromised.** It can
  send any message, with any payload, at any time, without a user gesture.
  Returning data New Tab can already show (e.g. history, bookmarks, top sites)
  is fine. A handler that destroys data (e.g. removes history), loads a
  privileged URL, or does what web content needs a user gesture for (e.g.
  clipboard access) acts only on state the parent already holds, such as a
  result in `controller.liveResults` matched by `id`, never on a URL or value
  from the payload. A capability that needs a user gesture isn't exposed as a
  message.
- **A result crosses as what `UrlbarResult.toWire()` returns**: its private
  fields, its payload, and of the properties set on it, only `id`, `rowIndex`,
  `commands` and `isSERP`. A new private field is added to `toWire()`, and a
  public property set after construction is re-applied in `fromWire()`. Payload,
  `viewTemplate` and `viewUpdate` values must be structured-clonable (e.g. no
  UniFFI objects): a function fails the message and a class instance arrives as
  a plain object. A new `UrlbarQueryContext` field holding a result or a class
  instance needs the same `toWire()`/`fromWire()` handling. Results coming back
  to the parent are matched by `id` through
  `UrlbarResult.fromWire(wire, controller.liveResults)`, never by identity.
- **Everything the view needs is computed in the parent and stored in the
  result, and any work on the provider's original result runs in the parent.**
  The view only has a plain clone (e.g. without the Rust `Suggestion` a
  dismissal needs) and never calls back synchronously. To change a shown row,
  add a result in a later query; the result menu can use
  `updateResultMenuCommands()`. See
  `browser/components/urlbar/docs/process-boundary.md` "Payloads".
- **Provider hooks don't rely on `details.element` or `details.event`**, which
  are `null` on the message path. They get the chrome window from
  `controller.browserWindow`, not `controller.input`.
- **Providers and the parent call only the input, view and controller methods
  listed in `UrlbarShared.INVOKABLE_CONTENT_ACTIONS`.** These calls return
  nothing, take effect after the hook returns, are dropped if the page is gone,
  and take clonable arguments (a result's `id`, not the result). A new method
  goes on the list, or `UrlbarChild` throws `disallowed content action`.
- **A load goes through `parentController.loadURL()` with serializable
  parameters.** No `<browser>`, `document`, `nsIURI` or `nsIURIFixupInfo`
  crosses, and post data travels as a string. Target-browser logic uses
  `resolveTargetBrowser()`, which ignores a content sender's `browserId`.
- **A difference between the two paths lives in `UrlbarChild` or the proxy**,
  not in a `usesMessagePath()` branch in the input, view or a provider.

## Realms, lifetime and async

- **A capability content needs is added to `UrlbarChild.createPort()`, and a
  value `UrlbarChild` hands to content is cloned into the content window.**
  Promises are wrapped, as the existing port members do, and a class crosses in
  wire form and is rebuilt in the reader's realm. See
  `browser/components/urlbar/docs/message-path.md` "A value has to be cloned
  into the realm that reads it".
- **Nothing that outlives an input holds it, or anything holding it, strongly.**
  The parent never holds the child. One strong reference leaks the parent
  controller until the page or window closes. See
  `browser/components/urlbar/docs/message-path.md` "One strong reference keeps
  the whole chain alive".
- **A process-wide registration added to `UrlbarParentController` is undone in
  `destroy()`** (e.g. an observer, a pref listener). Parent-to-child sends go
  through `sendToChild`, which checks for a closed global.
- **A caller of `parentController.*` works when the call returns a promise or
  nothing.** On the message path the answer is at least a round trip later. A
  promise-returning API resolves when the work is done, not when the message is
  sent, as `startQuery` and `lastQueryContextPromise` do.
- **`maybeInitEngineStore()` returns `false` on the message path.** A query
  waits for the engine store, but input code that reads `engineStore` outside a
  query (e.g. the placeholder, search mode entry) awaits `engineStore.init()`.
- **Listener state is keyed by `queryContext.id`, never by object identity.**
  Listeners register through `UrlbarChildController.addListener`, and on the
  message path each notification brings a new context object. A new notification
  goes in `UrlbarShared.NOTIFICATIONS` and reaches the child through
  `notifyFromWire`.
- **The input calls `discardResults()` when it takes over a running query**
  (e.g. on search mode entry or a restart), or stale results reach the view.

## Search access points

- **Behavior for one element goes in its hooks** (i.e. `sapInit`,
  `sapConnectedCallback`, `sapDisconnectedCallback`, `initSapContextMenuItems`,
  `handleEmptyValueNavigation`), not in new `sapName` checks in
  `UrlbarInputBase`. The New Tab search bar has no subclass of its own, so its
  behavior is a `newtab_searchbar` check.
- **Shared behavior branches on SAP groups, not on class:** `SEARCHBAR_SAPS`,
  `isSearchbarSAP`, `navigationEnabled()`, `keywordEnabled`. A
  `sapName == "searchbar"` check covers the toolbar search bar only, and a
  `"urlbar"` check excludes `newtab_searchbar`. Confirm which the patch means,
  and that address bar behavior doesn't leak into the other SAPs.
- **Shared input and view code tolerates a null `browserWindow` and
  `gBrowser`**, as on the New Tab search bar.
- **A new SAP or search source updates every list in
  `browser/components/urlbar/docs/adding-a-search-bar.md` "Registering the
  Search Access Point".** Nothing enforces the list. A miss gives no results, an
  `Unknown SAP name` error, an undeclared `sap` value or counts in `__other__`.
- **A page hosting a search bar sets `sap-name` and is added to the `Urlbar`
  actor's `matches` in `browser/components/DesktopActorRegistry.sys.mjs`, never
  a page that loads in web content.** Registrant `l10nURLs` lists every
  FTL file, since a missing one puts the whole page in en-US. Registrants that
  replace each other read the same condition and call `updated()`.

## Search mode

- **Search mode is stored per browser only for `urlbar`.** Every other SAP keeps
  one set per input. See `UrlbarInputBase` `getSearchMode`/`setSearchMode`.
- **`setSearchMode` is async, and its `entry` is a
  `UrlbarShared.SEARCH_MODE_ENTRY` value.** Preview mode records nothing, and
  recording goes through `parentController.recordSearchMode`.
- **A change to suggestion settings keeps suggestions in search mode, even
  when the user turned them off.**
  See `browser/components/urlbar/docs/nontechnical-overview.md` "Search Mode".
