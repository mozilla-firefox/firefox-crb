# Moving tabs between windows

A tab dragged to another window, or detached into a window of its own, looks
like one tab changing places. Underneath, the destination window creates a new
`<tab>` and `<browser>`, the page's docShell moves into that browser, and the
original tab closes. Code that holds a reference to the tab or the browser is
left holding the closed one. This page describes which functions perform a
move, what survives it, and how to follow a page across one.

## Which function to call

These are all called on the destination window's `gBrowser`, except where the
destination does not exist yet.

- `adoptTab(tab, { elementIndex, tabIndex, selectTab })` moves a tab from
  another window into this one and returns the new tab, or `null` if the move
  was refused. `adoptSplitView` and `adoptTabGroup` move a split view or a tab
  group by adopting each of its tabs in turn, and return the new split view or
  group. They don't check for a refused move. If the move of one of the tabs is
  refused, they throw a `TypeError`, and the tabs that had already moved by then
  stay in this window outside any split view or group.
- `replaceTabWithWindow(tab)`, called on the *source* window's `gBrowser`,
  opens a new window that adopts the tab, and returns that window. It returns
  `null` without doing anything when the tab is the window's only one, unless
  `replaceLastTab` is set. `replaceTabsWithWindow` moves the multiselected tabs
  along with it, and `replaceGroupWithWindow` moves a tab group; both record
  telemetry on top.
- `swapBrowsersAndCloseOther(ourTab, otherTab)` is the step every one of these
  ends in: it moves `otherTab`'s page into `ourTab`, which already exists, and
  closes `otherTab`. Call `adoptTab` instead, which creates `ourTab` with the
  right process and position.
- `swapBrowsers(ourTab, otherTab)` exchanges the pages of two tabs and keeps
  both open. `nsIBrowser.swapBrowsers` reaches it when both browsers belong to a
  tabbrowser.

## What a move keeps and what it replaces

The docShell swap moves the page itself, so whatever belongs to the page goes
with it:

- The browsing context, and with it `browser.browserId`, the content process
  and the loaded document, which is neither reloaded nor unloaded.
- The window globals of the page and its frames, and so the `JSWindowActor`
  instances attached to them, in both the parent and the content process.
- `browser.permanentKey`, which `swapBrowsersAndCloseOther` swaps onto the new
  browser, so session store's state follows it.
- The values set with `SessionStore.setCustomTabValue`, and the tab's id as
  WebExtensions see it.

Everything attached to the elements stays behind with the closed tab:

- The `<tab>` and `<browser>` elements, and `ownerGlobal` and `gBrowser` with
  them.
- Event listeners added to those elements, expando properties set on them, and
  entries in a `Map` or `WeakMap` keyed on them.
- `browser.messageManager`, which a swap does not exchange, so message listeners
  have to be added to the new browser's.

`swapBrowsersAndCloseOther` copies the tab's attributes that describe its state
(e.g. `muted`, `soundplaying`, `sharing`, `usercontextid`) to the new tab, which
then fires `TabAttrModified` for them. It also carries over the icon, the
temporary site permissions, the find bar's text and the tab note state. Anything
it doesn't copy explicitly stays on the old tab.

## Following a page across a move

An actor in the parent process keeps working across a move, but its
`browsingContext.top.embedderElement` now points at the new browser. Look the
browser up from the actor each time rather than storing it when the actor is
created.

Code that has to keep listening to a browser re-registers on the new one. A
swap fires `SwapDocShells` before it and `EndSwapDocShells` after it, on both
browsers, each with the other browser as `event.detail`. Wait for
`EndSwapDocShells` before registering on the other browser, since registering
from `SwapDocShells` can catch that browser's own `SwapDocShells` and move the
listener straight back:

```js
function followBrowser(browser) {
  browser.addEventListener("SwapDocShells", function onSwap(event) {
    browser.removeEventListener("SwapDocShells", onSwap);
    let newBrowser = event.detail;
    browser.addEventListener(
      "EndSwapDocShells",
      () => followBrowser(newBrowser),
      { once: true }
    );
  });
}
```

For a tab, the destination window's `TabOpen` carries the tab being moved as
`event.detail.adoptedTab`, and the source window's `TabClose` carries the new
tab as `event.detail.adoptedBy` ({doc}`tab-events`). When the tab is the last
visible one in its window, the window closes without closing the tab first, to
avoid flicker, so `TabClose` doesn't fire. `TabOpen` fires before the swap,
while the new tab still shows the placeholder `about:blank`.

## A tab that hasn't been restored

A tab with the `pending` attribute has no page to move ({doc}`lazy-browsers`).
`swapBrowsersAndCloseOther` reads its state from session store and applies it to
the new tab instead of swapping docShells. The new tab keeps its own browser,
`permanentKey` and `browserId`. The tab state above is copied as for a loaded
tab.

## When a move is refused

`swapBrowsersAndCloseOther` returns `false`, and `adoptTab` removes the tab it
created and returns `null`, when the two windows differ in privateness or in
whether they use Fission, or when one browser is remote and the other is not.
It is also refused when the tab is already closing or its window is.

## Moving a tab into a new window

`replaceTabWithWindow` opens the window through
`BrowserWindowTracker.openWindow` and passes it the tab, or the split view or
tab group being moved, as `window.arguments[0]`
({doc}`/browser/BrowserWindowTracker`). The new window clears that argument
once it reads it, so check `window.gBrowserInit.isAdoptingTab()` instead, which
returns `true` until the adoption is done.

A single tab takes the place of the window's initial tab, so no `TabOpen` with
`adoptedTab` fires for it. A split view or a tab group is adopted through
`adoptSplitView` or `adoptTabGroup`, which fire one for each tab.

`replaceTabWithWindow` returns before the new window has loaded, so the window
has no `gBrowser` yet and the tab hasn't moved. The window's `load` handler
dispatches `before-initial-tab-adopted` on `gBrowser.tabpanels`, and
`replaceTabsWithWindow` listens for it on the window to adopt the other tabs it
moves. The swap itself waits for the window's first `MozAfterPaint`, unless a
single tab with a non-remote browser is being moved.
