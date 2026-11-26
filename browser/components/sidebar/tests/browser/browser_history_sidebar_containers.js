/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const DEFAULT_URL = "https://example.com/";
const CONTAINER_URL = "https://example.org/";
const CONTAINER_ID = 1;

async function fetchUserContextIds(url) {
  const db = await PlacesUtils.promiseDBConnection();
  const rows = await db.execute(
    `SELECT v.userContextId FROM moz_historyvisits v
     JOIN moz_places h ON h.id = v.place_id
     WHERE h.url_hash = hash(:url) AND h.url = :url`,
    { url }
  );
  return [...new Set(rows.map(r => r.getResultByName("userContextId")))];
}

async function getHistoryRows(count) {
  const { component, contentWindow } = await showHistorySidebar();
  await BrowserTestUtils.waitForMutationCondition(
    component.shadowRoot,
    { childList: true, subtree: true },
    () => !!component.lists.length
  );
  const list = component.lists[0];
  await BrowserTestUtils.waitForMutationCondition(
    list.shadowRoot,
    { childList: true, subtree: true },
    () => list.rowEls.length === count
  );
  return { component, contentWindow, rows: [...list.rowEls] };
}

function findRow(rows, url, userContextId) {
  return rows.find(
    row => row.url === url && row.userContextId === userContextId
  );
}

function clickRow(row, contentWindow) {
  // The row link is not focusable, see test_history_hover_buttons.
  AccessibilityUtils.setEnv({ focusableRule: false });
  EventUtils.synthesizeMouseAtCenter(row.mainEl, {}, contentWindow);
  AccessibilityUtils.resetEnv();
}

async function insertVisits() {
  await PlacesUtils.history.clear();
  const now = Date.now();
  await PlacesUtils.history.insertMany([
    { url: DEFAULT_URL, visits: [{ date: new Date(now - 3000) }] },
    {
      url: CONTAINER_URL,
      visits: [
        { date: new Date(now - 2000) },
        { date: new Date(now - 1000), userContextId: CONTAINER_ID },
      ],
    },
  ]);
}

add_setup(async () => {
  await SpecialPowers.pushPrefEnv({
    set: [["privacy.userContext.enabled", true]],
  });
  await insertVisits();
  registerCleanupFunction(async () => {
    SidebarController.hide();
    cleanUpExtraTabs();
    await PlacesUtils.history.clear();
  });
});

add_task(async function test_container_rows_and_badge() {
  const { rows } = await getHistoryRows(3);

  const containerRow = findRow(rows, CONTAINER_URL, CONTAINER_ID);
  ok(containerRow, "The container visit has its own row.");
  ok(findRow(rows, CONTAINER_URL, 0), "The default visit has its own row.");
  is(
    containerRow.containerObj.userContextId,
    CONTAINER_ID,
    "The container row knows its container."
  );
  const { color } = containerRow.containerObj;
  const name = ContextualIdentityService.getUserContextLabel(CONTAINER_ID);
  const badge = containerRow.shadowRoot.querySelector(
    `.fxview-tab-row-container-indicator.identity-color-${color}`
  );
  ok(badge, "The container row shows the container badge.");
  await TestUtils.waitForCondition(
    () => badge.getAttribute("aria-label")?.includes(name),
    "The container badge is labelled with the container name."
  );
  ok(
    !findRow(rows, DEFAULT_URL, 0).containerObj,
    "The default row has no container."
  );
});

add_task(async function test_container_rows_with_all_history() {
  await SpecialPowers.pushPrefEnv({
    set: [["sidebar.history.showAllHistory", true]],
  });
  const { component } = await showHistorySidebar();
  await component.controller.updateCache();
  const { rows } = await getHistoryRows(3);

  const containerRow = findRow(rows, CONTAINER_URL, CONTAINER_ID);
  ok(containerRow, "The container visit has its own row.");
  ok(findRow(rows, CONTAINER_URL, 0), "The default visit has its own row.");
  is(
    containerRow.containerObj?.userContextId,
    CONTAINER_ID,
    "The container row knows its container."
  );

  await SpecialPowers.popPrefEnv();
  await component.controller.updateCache();
});

add_task(async function test_open_container_row_in_new_tab() {
  const { rows, contentWindow } = await getHistoryRows(3);

  const tabPromise = BrowserTestUtils.waitForNewTab(
    gBrowser,
    CONTAINER_URL,
    true
  );
  clickRow(findRow(rows, CONTAINER_URL, CONTAINER_ID), contentWindow);
  const tab = await tabPromise;
  is(
    tab.userContextId,
    CONTAINER_ID,
    "The row is opened in a new tab of its container."
  );
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_open_same_container_row_in_current_tab() {
  const { rows, contentWindow } = await getHistoryRows(3);
  const tabCount = gBrowser.tabs.length;

  const loadedPromise = BrowserTestUtils.browserLoaded(
    gBrowser.selectedBrowser,
    false,
    DEFAULT_URL
  );
  clickRow(findRow(rows, DEFAULT_URL, 0), contentWindow);
  await loadedPromise;
  is(gBrowser.tabs.length, tabCount, "The row is opened in the current tab.");
});

add_task(async function test_open_default_row_from_container_tab() {
  const containerTab = BrowserTestUtils.addTab(gBrowser, "about:blank", {
    userContextId: CONTAINER_ID,
  });
  gBrowser.selectedTab = containerTab;
  const { rows, contentWindow } = await getHistoryRows(3);

  const tabPromise = BrowserTestUtils.waitForNewTab(
    gBrowser,
    DEFAULT_URL,
    true
  );
  clickRow(findRow(rows, DEFAULT_URL, 0), contentWindow);
  const tab = await tabPromise;
  is(tab.userContextId, 0, "The row is opened in a new default tab.");
  BrowserTestUtils.removeTab(tab);
  BrowserTestUtils.removeTab(containerTab);
});

add_task(async function test_containers_disabled() {
  await SpecialPowers.pushPrefEnv({
    set: [["privacy.userContext.enabled", false]],
  });
  // Disabling containers clears their data, including their history.
  await TestUtils.waitForCondition(
    async () =>
      !(await fetchUserContextIds(CONTAINER_URL)).includes(CONTAINER_ID),
    "The history of the container has been cleared."
  );
  await insertVisits();
  const { component } = await showHistorySidebar();
  await component.controller.updateCache();
  await component.updateComplete;
  const { rows, contentWindow } = await getHistoryRows(3);

  const containerRow = findRow(rows, CONTAINER_URL, CONTAINER_ID);
  await BrowserTestUtils.waitForMutationCondition(
    containerRow.shadowRoot,
    { attributes: true, childList: true, subtree: true },
    () => !containerRow.shadowRoot.querySelector("[class*='identity-color-']")
  );
  ok(true, "No badge is shown when containers are disabled.");

  const tabCount = gBrowser.tabs.length;
  const loadedPromise = BrowserTestUtils.browserLoaded(
    gBrowser.selectedBrowser,
    false,
    CONTAINER_URL
  );
  clickRow(containerRow, contentWindow);
  await loadedPromise;
  is(
    gBrowser.tabs.length,
    tabCount,
    "The row is opened in the current tab when containers are disabled."
  );

  await SpecialPowers.popPrefEnv();
  await component.controller.updateCache();
});

add_task(async function test_private_window() {
  const privateWin = await BrowserTestUtils.openNewBrowserWindow({
    private: true,
  });
  await SidebarTestUtils.showPanel(privateWin, "viewHistorySidebar");
  const { contentDocument, contentWindow } =
    privateWin.SidebarController.browser;
  const component = contentDocument.querySelector("sidebar-history");
  await TestUtils.waitForCondition(
    () => component.lists?.[0]?.rowEls.length === 3,
    "The history rows are shown in the private window."
  );
  const containerRow = findRow(
    [...component.lists[0].rowEls],
    CONTAINER_URL,
    CONTAINER_ID
  );
  is(
    component.getUserContextIdToOpen(containerRow),
    undefined,
    "No container is used to open rows in a private window."
  );

  const tabCount = privateWin.gBrowser.tabs.length;
  const loadedPromise = BrowserTestUtils.browserLoaded(
    privateWin.gBrowser.selectedBrowser,
    false,
    CONTAINER_URL
  );
  clickRow(containerRow, contentWindow);
  await loadedPromise;
  is(
    privateWin.gBrowser.tabs.length,
    tabCount,
    "The row is opened in the current private tab."
  );
  is(
    privateWin.gBrowser.selectedTab.userContextId,
    0,
    "The private tab is not in a container."
  );

  await BrowserTestUtils.closeWindow(privateWin);
});

add_task(async function test_open_all_in_tabs() {
  const { component, rows } = await getHistoryRows(3);
  const list = component.lists[0];

  list.selectAll();
  for (const row of rows) {
    await BrowserTestUtils.waitForMutationCondition(
      row,
      { attributes: true },
      () => row.hasAttribute("selected")
    );
  }

  const tabCountBefore = gBrowser.tabs.length;
  const contextMenu = SidebarController.currentContextMenu;
  await openAndWaitForContextMenu(contextMenu, rows[0].mainEl, () =>
    contextMenu.activateItem(
      document.getElementById("sidebar-history-context-open-all-in-tabs")
    )
  );
  await TestUtils.waitForCondition(
    () => gBrowser.tabs.length === tabCountBefore + rows.length,
    "All the rows were opened in new tabs."
  );

  Assert.deepEqual(
    gBrowser.tabs
      .slice(tabCountBefore)
      .map(tab => tab.userContextId)
      .sort(),
    rows.map(row => row.userContextId).sort(),
    "Each row is opened in a tab of its container."
  );

  cleanUpExtraTabs();
  component.treeView.resetSelection();
});

add_task(async function test_delete_container_row() {
  const { component, rows } = await getHistoryRows(3);

  component.triggerNode = findRow(rows, CONTAINER_URL, CONTAINER_ID);
  await component.controller.deleteFromHistory();
  await getHistoryRows(2);

  Assert.deepEqual(
    await fetchUserContextIds(CONTAINER_URL),
    [0],
    "Only the visits of the container have been removed."
  );
});
