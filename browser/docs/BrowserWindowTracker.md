# BrowserWindowTracker

`BrowserWindowTracker`, in `browser/modules/BrowserWindowTracker.sys.mjs`, keeps
the list of open browser windows in the order the user last activated them, and
opens new ones. Chrome code that runs outside a browser window uses it to find a
window to act on:

```js
let win =
  lazy.BrowserWindowTracker.getTopWindow() ??
  (await lazy.BrowserWindowTracker.promiseOpenWindow());
win.openTrustedLinkIn(url, "tab");
```

Every window that loads `browser.xhtml` is tracked from its `DOMContentLoaded`,
through the `browser-window-domcontentloaded` category entry described in
{doc}`BrowserStartup`, until it unloads. Other chrome windows, such as the
Library, are not tracked.

## Finding a window

`getTopWindow()` returns the most recently activated browser window that is fit
to open a tab in. It skips some windows by default and takes options to let them
back in:

| Window | By default | Option |
|---|---|---|
| Popup, i.e. a window opened without a toolbar | skipped | `allowPopups: true` |
| Taskbar tab | skipped | `allowTaskbarTabs: true` |
| On another virtual desktop, on Windows | skipped | `allowFromInactiveWorkspace: true` |
| Mini window | skipped | none |
| Minimized | returned only if no window that isn't minimized qualifies, but ahead of a window on another desktop | none |

The `private` option works the other way and narrows the search: `true` returns
only a private window and `false` only a non-private one. Leave it out to accept
either. Under permanent private browsing the option is ignored, so
`private: false` returns a private window, since every window is one.

A window from another virtual desktop is returned only when no window on the
current desktop qualifies, even with `allowFromInactiveWorkspace`, so that
opening a tab doesn't switch desktops. Without that option, a Windows user with
every window on another desktop gets `null`. Setting
`widget.prefer_windows_on_current_virtual_desktop` to `false` turns the desktop
check off.

`getTopWindow()` returns `null` whenever no window passes the filters, which
includes every macOS session with all its windows closed. Handle `null`.

### Why not `Services.wm.getMostRecentWindow`

`Services.wm.getMostRecentWindow("navigator:browser")` looks equivalent and is
not. The window mediator stamps a window when it registers and each time it is
shown or hidden, never when it is activated, so "most recent" means most
recently opened, not the window the user is in. The mediator also applies none
of the filters above, and returns a popup as readily as a normal window. Its
z-order enumerator returns no windows at all
([bug 1214585](https://bugzilla.mozilla.org/show_bug.cgi?id=1214585)).

`BrowserWindowTracker` keeps its own order by listening for `activate`, which is
what makes it right. Use `getTopWindow()` in new code;
[bug 1455349](https://bugzilla.mozilla.org/show_bug.cgi?id=1455349) migrates the
existing callers.

## Listing windows

`getOrderedWindows()`, and the `orderedWindows` getter that calls it with no
options, return every tracked window, most recently activated first. The JSDoc
calls this z-order, but it is activation order, and the two diverge whenever the
user moves a window without activating it.

The list applies none of `getTopWindow()`'s filters, so popups and taskbar tabs
are in it. Minimized windows are moved to the back when the list is read, not
when the order is recorded: macOS fires `activate` while a window is still
minimized ([bug 2007691](https://bugzilla.mozilla.org/show_bug.cgi?id=2007691)),
so a filter applied on write would misplace the window being restored.

`getOrderedWindows({ private })` filters by privateness. Under permanent private
browsing `private: true` returns every window and `private: false` returns none.

`windowCount` counts every tracked window, popups included.

## Opening a window

`openWindow()` opens a browser window and returns it at once.
`promiseOpenWindow()` takes the same options and resolves once the window has
fired `browser-delayed-startup-finished`. Prefer it: the window `openWindow()`
returns has no `gBrowser` until its document has loaded, and has not started
loading its tabs until delayed startup.

| Option | Effect |
|---|---|
| `private` | Opens a private window, or a normal one where private browsing is disabled. Defaults to `false`. |
| `args` | What the new window loads; see below. Defaults to the home page, or `about:privatebrowsing` in a private window outside permanent private browsing. |
| `openerWindow` | The window to open from. |
| `features` | Window features appended to the defaults, as a comma-separated string. |
| `all` | Whether the default features include `all`. Defaults to `true`. |
| `remote`, `fission` | Override the profile's default for the window. |
| `aiWindow` | Opens an AI window. Left out, a non-private window opened from an AI window is one too. |
| `restoreSessionURL` | For an AI window that session restore reopens, the URL of its selected tab. |

### A window that is still opening

A window is tracked from its `DOMContentLoaded`, so until then `getTopWindow()`
cannot see it. Code that runs early in startup, such as a command-line handler,
can find no top window while the first window is on its way, and open a second.
`getPendingWindow()` closes that gap. It returns a promise for a window that
`openWindow()` has opened and that is not tracked yet, resolving once the window
finishes delayed startup, or `null` when there is no such window:

```js
let win = lazy.BrowserWindowTracker.getTopWindow();
if (!win) {
  let pending = lazy.BrowserWindowTracker.getPendingWindow();
  win = pending
    ? await pending
    : await lazy.BrowserWindowTracker.promiseOpenWindow();
}
```

A window that closes before `DOMContentLoaded` resolves the promise with the
closed window, so check `win.closed`. One that closes after `DOMContentLoaded`
but before delayed startup finishes leaves the promise unsettled. A window
opened some other way is pending only if its opener passed it to
`registerOpeningWindow()`.

The two calls leave a window in between: from `DOMContentLoaded` until delayed
startup finishes, `getTopWindow()` returns a window whose tabs have not started
loading. Where that matters, wait for the window's `delayedStartupPromise`.

## `window.arguments`

`openWindow()` hands `args` to the new window as `window.arguments`, where
`gBrowserInit` reads them. An `nsIArray` is spread across the indexes, and
anything else becomes index 0, so several URLs take an `nsIArray` with another
`nsIArray` as its first element. An AI window gets an `nsIArray` either way,
with its options added at index 1.

| Index | Holds |
|---|---|
| 0 | The URL to load, as a string or an `nsISupportsString`; several, as an `nsIArray` of `nsISupportsString`; or a tab, split view or tab group to adopt. |
| 1 | An `nsIPropertyBag2` of extra options, or `null`. |
| 2 | `referrerInfo` |
| 3 | `postData` |
| 4 | `allowThirdPartyFixup` |
| 5 | `userContextId` |
| 6 | `originPrincipal` |
| 7 | `originStoragePrincipal` |
| 8 | `triggeringPrincipal` |
| 9 | `allowInheritPrincipal` |
| 10 | `policyContainer` |
| 11 | An `nsOpenWindowInfo`, used when the window was not opened with one |

With fewer than three arguments, a string at index 0 may hold several URLs
separated by `|`, as the home page does. With three or more it is a single URL,
and with an `nsIArray` only indexes 5 and 8 to 10 apply.

A tab, split view or tab group at index 0 is how `gBrowser.replaceTabWithWindow`
moves one into a window of its own. The new window adopts it in place of its
initial tab, and no URL is loaded. `gBrowserInit.getTabToAdopt()` returns it
and clears index 0, so later readers find `null` there.

## What the tracker does besides

The tracker tells the network stack which browser is selected in the most
recently activated window, with the `net:current-browser-id` notification. The
network stack gives that tab's requests priority over background tabs'.

`getAllVisibleTabs()` and `getBrowserById()` have no callers in product
JavaScript. They implement `nsIBrowserWindowTracker` for C++: WebRTC lists the
tabs a user can share with the first, and Places reads the search engine and
sponsored-link attributes a browser holds for a visit with the second. Both skip
hidden tabs and {doc}`lazy tabs </browser/components/tabbrowser/docs/lazy-browsers>`.

## API reference

Generated from the JSDoc in
{searchfox}`BrowserWindowTracker.sys.mjs <browser/modules/BrowserWindowTracker.sys.mjs>`.

```{js:autofunction} BrowserWindowTracker.getTopWindow
```

```{js:autofunction} BrowserWindowTracker.getOrderedWindows
```

```{js:autofunction} BrowserWindowTracker.openWindow
```

```{js:autofunction} BrowserWindowTracker.promiseOpenWindow
```

```{js:autofunction} BrowserWindowTracker.getPendingWindow
```

```{js:autofunction} BrowserWindowTracker.registerOpeningWindow
```
