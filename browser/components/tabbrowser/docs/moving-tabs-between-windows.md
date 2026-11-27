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
  was refused. `adoptSplitView` and `adoptTabGroup` do the same for a split
  view and a tab group, by adopting each of their tabs in turn.
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

The tab's attributes that describe its state (e.g. `muted`, `soundplaying`,
`sharing`, `usercontextid`) are copied to the new tab, which then fires
`TabAttrModified` for them. Nothing else on the old tab is copied.

## Following a page across a move

An actor in the parent process keeps working across a move, but its
`browsingContext.top.embedderElement` now points at the new browser. Look the
browser up from the actor each time rather than storing it when the actor is
created.

Code that has to keep listening to a browser re-registers on the new one. The
browser being swapped fires `SwapDocShells` before the swap and
`EndSwapDocShells` after it, each with the other browser as `event.detail`:

```js
browser.addEventListener("SwapDocShells", function onSwap(event) {
  browser.removeEventListener("SwapDocShells", onSwap);
  browser = event.detail;
  browser.addEventListener("SwapDocShells", onSwap);
});
```

Both events fire on both browsers, since each browser receives the other's
page. For a tab, the destination window's `TabOpen` carries the tab being moved
as `event.detail.adoptedTab`, and the source window's `TabClose` carries the new
tab as `event.detail.adoptedBy` ({doc}`tab-events`). `TabOpen` fires before the
swap, while the new tab still shows the placeholder `about:blank`.

## A tab that hasn't been restored

A tab with the `pending` attribute has no page to move ({doc}`lazy-browsers`).
`swapBrowsersAndCloseOther` reads its state from session store and applies it to
the new tab instead of swapping docShells. The new tab keeps its own browser,
`permanentKey` and `browserId`, and nothing of the old browser reaches it
beyond what session store had saved.

## When a move is refused

`swapBrowsersAndCloseOther` returns `false`, and `adoptTab` removes the tab it
created and returns `null`, when the two windows differ in privateness or in
whether they use Fission, or when one browser is remote and the other is not.
It is also refused when the tab is already closing or its window is.

## Moving a tab into a new window

`replaceTabWithWindow` opens the window through
`BrowserWindowTracker.openWindow` and passes the tab as `window.arguments[0]`
({doc}`/browser/BrowserWindowTracker`). The new window adopts the tab in place
of its initial tab, so no `TabOpen` with `adoptedTab` fires for it. Until the
adoption is done, `window.gBrowserInit.isAdoptingTab()` returns `true`.

The adoption does not happen while the window is opening. For a remote browser
it waits for the new window's first `MozAfterPaint`, so the window that
`replaceTabWithWindow` returns still has its blank initial tab. Just before
adopting, the window dispatches `before-initial-tab-adopted` on
`gBrowser.tabpanels`, which is where `replaceTabsWithWindow` adopts the other
tabs it moves.
