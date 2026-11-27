# Tab groups

A tab group is a named, colored run of tabs in the tab strip that the user can
collapse to its label. In the DOM it is a `<tab-group>` element with the tabs as
its children, so a tab joins or leaves a group by moving in the DOM. Session
store keeps a group's identity across windows and sessions, and keeps groups
the user closed or saved so they can be reopened. This page describes what a
group is in the tab strip, the `gBrowser` functions that create, move and
remove groups, what a group's `id` identifies, how collapsing works, and how
closed and saved groups differ. The events that groups dispatch are in
{doc}`tab-events`.

## What a group is

`<tab-group>` is a custom element defined in `tabgroup.mjs`
(`MozTabbrowserTabGroup`). Groups are children of
`gBrowser.tabContainer.arrowScrollbox`, next to ungrouped tabs and split views,
and the tabs in a group are the group's children. A split view inside a group is
a child of the group, with its tabs inside it. Groups don't nest.

```js
tab.group; // The <tab-group> the tab is in, or null.
group.tabs; // Every tab in the group, including the tabs of its split views.
group.tabsAndSplitViews; // The group's direct children: tabs and split views.
```

`group.tabs` includes tabs hidden with `gBrowser.hideTab`. Pinned tabs live in
a separate container, `gBrowser.tabContainer.pinnedTabsContainer`, so a pinned
tab is never in a group. Pinning a grouped tab moves it out of its group, and
adding a pinned tab to a group unpins it.

The group's properties are:

- `id`, the group's identity, described below.
- `label`, the name the user gave the group, or the empty string. `name` is an
  alias. An unnamed group shows the localized default name, which
  `group.defaultGroupName` returns. The `label` attribute holds a zero-width
  space for an unnamed group, so read the property, not the attribute.
- `color`, one of `blue`, `purple`, `cyan`, `orange`, `yellow`, `pink`, `green`,
  `gray` and `red`. Setting it sets the `--tab-group-color` custom properties on
  the element.
- `collapsed`, described below.
- `hasActiveTab`, true when the selected tab is in the group.

The group's label, `group.labelElement`, stands in for the group among the tab
strip's items. `gBrowser.tabContainer.dragAndDropElements` and
`ariaFocusableItems` list it before the group's tabs, so an `elementIndex`
counts the label and a `tabIndex` doesn't. The label element has the
`container`, `group`, `pinned` and `splitview` properties of a tab, and the
functions that take a tab to move (e.g. `moveTabTo`, `moveTabBefore`) accept a
label as a stand-in for its group. `Tabbrowser.isTabGroup(element)` and
`Tabbrowser.isTabGroupLabel(element)` tell the two apart.

## Creating and filling a group

`gBrowser.addTabGroup` creates a group from tabs and split views and returns it:

```js
let group = gBrowser.addTabGroup([tab1, tab2], {
  label: "Research",
  color: "blue",
  insertBefore: tab1,
});
```

- Without a `color`, the group gets the first color that no open group in a
  window of the same privateness uses.
- Without an `id`, the group gets a new one. Pass an `id` only to rebuild a
  group that already exists elsewhere.
- Without `insertBefore`, the group goes at the end of the tab strip.
- It throws when the list is empty or holds anything but tabs and split views,
  and returns `null` when none of the tabs ended up in the group.
- A `metricsContext` that is user-triggered opens the editor panel that asks the
  user to name the group, through the `TabGroupCreateByUser` event.

Tabs from another window are adopted into this one on the way in
({doc}`moving-tabs-between-windows`). The other functions that change
membership are:

- `group.addTabs(tabsAndSplitViews)` appends tabs and split views to an
  existing group, adopting and unpinning them as `addTabGroup` does.
  `gBrowser.moveTabToExistingGroup(tab, group)` and
  `moveSplitViewToExistingGroup` move one item from the same window, and do
  nothing for a pinned tab.
- `gBrowser.ungroupTab(tab)` moves a tab out of its group to just after the
  group. `group.ungroupTabs()` does that for every item in the group, which
  removes the group.
- `gBrowser.addTab` takes a `tabGroup` option, and without one a tab opened from
  a grouped tab joins the opener's group. Opening a tab into a collapsed group
  expands the group.

`gBrowser.moveTabTo`, `moveTabBefore` and `moveTabAfter` move a whole group when
given the group or its label, and never place a group inside another one.

## Finding groups

| Call | Returns |
| --- | --- |
| `gBrowser.tabGroups` | The groups in this window, in tab strip order. |
| `gBrowser.getAllTabGroups()` | The open groups in every window of this window's privateness. `sortByLastSeenActive: true` sorts the most recently used first. |
| `gBrowser.getTabGroupById(id)` | The open group with that `id` in a window of this window's privateness, or `null`. |
| `SessionStore.getSavedTabGroups()` | Saved groups, which are not open in any window (see below). |

## A group's id

`addTabGroup` generates an `id` of the form `<timestamp>-<number>`, from
`Date.now()` and a random number from 0 to 100. The timestamp part is never
reused within a session, even for groups created in the same millisecond. The
`id` is also the element's DOM `id` attribute.

The `id` names the group; the element does not. These all produce a new
`<tab-group>` element with the same `id`:

- Moving the group to another window. `adoptTabGroup` builds a new group in the
  destination and the old element removes itself once its tabs have left.
- Restoring a session, reopening a closed window, and reopening a closed or saved
  group.

So code that has to keep track of a group across these stores its `id` and
looks the group up with `getTabGroupById`, as the tab groups list and the
address bar's tab group actions do. A group moved to another window arrives expanded, since
`adoptTabGroup` copies only the `id`, `label` and `color`.

The `tabGroups` WebExtension API reports a numeric id that
`getExtTabGroupIdForInternalTabGroupId` in `ext-browser.js` derives from this
format. A change to the format has to change that function too.

## Collapsed groups

`group.collapsed` reflects the `collapsed` attribute. Setting it to the value it
already has does nothing; otherwise it dispatches `TabGroupCollapse` or
`TabGroupExpand`. Clicking the label toggles it, and `group.select()` expands
the group and selects its first tab, unless the selected tab is already in it.

A collapsed group's tabs keep their `hidden` state. What changes is
`tab.visible`, which `group.isTabVisibleInGroup(tab)` answers for a grouped tab:
in a collapsed group, only the selected tab, multiselected tabs and the tabs of
a split view that holds the selected tab stay visible. The tab strip leaves the
others out of `dragAndDropElements` and `ariaFocusableItems`. Collapsing a group
also removes its tabs from the multiselection.

`gBrowser.tabsInCollapsedTabGroups` lists the tabs in collapsed groups that are
neither hidden nor closing. When the selected tab closes, the tab to select next
comes from these only when no visible tab is left.

A group that session store restores collapsed is created collapsed before it
enters the document, so no listener in the window hears a `TabGroupCollapse`
for it.

## Removing a group

A group never exists without tabs. When its last tab or split view leaves, by
closing, ungrouping or moving to another window, the group dispatches
`TabGroupRemoved`, removes itself, and notifies observers of
`browser-tabgroup-removed-from-dom`. This happens in a `MutationObserver`
callback, so the group is still in the document straight after the call that
removed its last tab.

Closing a group's tabs records the group in session store in one of three ways,
depending on the call:

- `gBrowser.removeTabGroup(group)` closes the group's tabs and records the group
  as a *closed group* of the window. It is async: it first runs the tabs'
  `beforeunload` handlers, and does nothing if the user cancels. Unlike closing
  tabs, it leaves the window open when the group holds every tab in it, unless
  `closeWindowWithLastTab` is set. `skipSessionStore: true` records nothing.
- `gBrowser.removeTabs(tabs)` saves every group that `tabs` covers completely,
  as a *saved group* unless `skipSessionStore` is set, and closes it through `removeTabGroup`. The tabs left over
  close as ordinary tabs.
- `gBrowser.removeTab` on a group's last tab records only the closed tab. Its
  state still names the group's `id`, so reopening it with Undo Close Tab while
  a group with that `id` is open in the window puts it back in the group.

`group.save()` records the group as saved and leaves it open.
`group.saveAndClose()` saves it and then removes it; the tab group editor's "Save
and close group" command and a middle click on the label use it.

## Closed and saved groups

Session store keeps two kinds of group that are not open, and both reopen with
the `id` they had.

A **closed group** belongs to the window it was closed in: it is in that
window's `closedGroups` state and in the recently closed lists, alongside closed
tabs. `removeTabGroup` produces one.

A **saved group** belongs to the profile rather than to a window: it is in the
session's `savedGroups` list and in the lists of tab groups the toolbar button
and the application menu show next to the open groups. Saving refuses tabs from a private window, and
only a group with at least one tab worth saving is recorded
(`SessionStore.shouldSaveTabsToGroup(tabs)` answers this for a set of tabs).

| | Closed group | Saved group |
| --- | --- | --- |
| Created by | `removeTabGroup` | `group.save()`, `removeTabs` closing whole groups, closing a window |
| Listed by | `SessionStore.getClosedTabGroups(options)` | `SessionStore.getSavedTabGroups()`, `getSavedTabGroup(id)` |
| Reopened by | `SessionStore.undoCloseTabGroup(source, id, targetWindow)` | `SessionStore.openSavedTabGroup(id, targetWindow, { source })` |
| Forgotten by | `SessionStore.forgetClosedTabGroup(source, id)` | `SessionStore.forgetSavedTabGroup(id)` |

Both reopen calls build the group in `targetWindow`, forget the closed or saved
entry, select the group and return the new element. `SessionStore.addTabsToSavedGroup(id, tabs)`
adds copies of open tabs to a saved group. Changes to the saved groups are
announced with the `sessionstore-saved-tab-groups-changed` notification, and to
closed groups with `sessionstore-closed-objects-changed`
({doc}`/browser/components/sessionstore/docs/events`).

## Groups across windows and sessions

Session store writes each open group into its window's state as an `id`, a
`name`, a `color` and a `collapsed` flag, and each grouped tab's state names its
group's `id`. The state calls the label `name`. On restore,
`gBrowser.createTabsForSessionRestore` rebuilds the groups from that state; a tab
that names a group missing from its window's state is restored ungrouped.

Closing a window turns its open groups into saved groups when session store
keeps the closed window. The saved group remembers the window, and reopening either one forgets the other:
reopening the window forgets the saved group, and opening the saved group removes
it from the closed window. Two cases are exempt, through the group's
`saveOnWindowClose` flag:

- A group moving to another window, which `adoptTabGroup` marks.
- A group that `removeTabGroup` removes along with every tab in the window,
  when that closes the window.

Quitting keeps groups open in the session, and a restored session reopens them in
their windows. When the previous session is not restored at startup, its open
groups become saved groups instead, marked to be forgotten if the user restores
the previous session later.

`TabGroupState` (in `browser/components/sessionstore/`) builds these state
objects from a group element, and its JSDoc types describe the open, closed and
saved shapes.

## Smart tab group suggestions

`SmartTabGroupingManager` in `SmartTabGrouping.sys.mjs` suggests a label and
further tabs for a group from the tabs' titles and URLs, using an on-device
model. The tab group editor calls it when the user has opted in, in English locales
and outside private windows. It creates no groups itself.
