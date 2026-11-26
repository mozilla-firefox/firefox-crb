/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const TEST_URL = "https://example.org/";
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

async function getHistoryRows(document, count) {
  await navigateToViewAndWait(document, "history");
  const historyComponent = await TestUtils.waitForCondition(
    () => document.querySelector("view-history"),
    "History component rendered"
  );
  historyComponent.profileAge = 8;
  await TestUtils.waitForCondition(
    () => historyComponent.lists[0]?.rowEls.length === count,
    `The history list shows ${count} rows`
  );
  return { historyComponent, rows: [...historyComponent.lists[0].rowEls] };
}

add_setup(async () => {
  await SpecialPowers.pushPrefEnv({
    set: [["privacy.userContext.enabled", true]],
  });
  await PlacesUtils.history.clear();
  const now = Date.now();
  await PlacesUtils.history.insert({
    url: TEST_URL,
    visits: [
      { date: new Date(now - 2000) },
      { date: new Date(now - 1000), userContextId: CONTAINER_ID },
    ],
  });
  registerCleanupFunction(async () => {
    await SpecialPowers.popPrefEnv();
    await PlacesUtils.history.clear();
  });
});

add_task(async function test_container_rows_and_badge() {
  await withFirefoxView({}, async browser => {
    const { document } = browser.contentWindow;
    const { historyComponent, rows } = await getHistoryRows(document, 2);

    const [containerRow, defaultRow] = rows;
    is(
      containerRow.userContextId,
      CONTAINER_ID,
      "The newest row is the container visit."
    );
    is(defaultRow.userContextId, 0, "The oldest row is the default visit.");

    const list = historyComponent.lists[0];
    ok(
      list.shadowRoot.querySelector(".fxview-tab-list.hasContainerTab"),
      "The list makes room for the container badge."
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
    ok(!defaultRow.containerObj, "The default row has no container.");
  });
});

add_task(async function test_open_container_row() {
  await withFirefoxView({}, async browser => {
    const { document } = browser.contentWindow;
    const { rows } = await getHistoryRows(document, 2);

    const tabPromise = BrowserTestUtils.waitForNewTab(gBrowser, TEST_URL, true);
    EventUtils.synthesizeMouseAtCenter(rows[0].mainEl, {}, content);
    const tab = await tabPromise;
    is(
      tab.userContextId,
      CONTAINER_ID,
      "The row is opened in a new tab of its container."
    );
    BrowserTestUtils.removeTab(tab);
  });
});

add_task(async function test_delete_container_row() {
  await withFirefoxView({}, async browser => {
    const { document } = browser.contentWindow;
    const { historyComponent, rows } = await getHistoryRows(document, 2);

    historyComponent.triggerNode = rows.find(
      row => row.userContextId === CONTAINER_ID
    );
    await historyComponent.controller.deleteFromHistory();
    await getHistoryRows(document, 1);

    Assert.deepEqual(
      await fetchUserContextIds(TEST_URL),
      [0],
      "Only the visits of the container have been removed."
    );
  });
});

add_task(async function test_first_container_visit_aligns_rows() {
  await withFirefoxView({}, async browser => {
    const { document } = browser.contentWindow;
    const { historyComponent, rows } = await getHistoryRows(document, 1);
    ok(
      !rows[0].shadowRoot.querySelector(".fxview-tab-row-container-indicator"),
      "No container placeholder is shown without container visits."
    );

    await PlacesUtils.history.insert({
      url: "https://example.net/",
      visits: [{ date: new Date(), userContextId: CONTAINER_ID }],
    });
    const list = historyComponent.lists[0];
    await TestUtils.waitForCondition(
      () =>
        list.rowEls.length === 2 &&
        [...list.rowEls].every(row =>
          row.shadowRoot.querySelector(".fxview-tab-row-container-indicator")
        ),
      "Every row has a container indicator once a container visit shows up."
    );
    ok(
      list.shadowRoot.querySelector(".fxview-tab-list.hasContainerTab"),
      "The list makes room for the container badge."
    );
  });
});
