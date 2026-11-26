/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const DEFAULT_URL = "https://example.com/default";
const CONTAINER_URL = "https://example.com/container";
const MIXED_URL = "https://example.com/mixed";

async function insertVisits() {
  let now = Date.now();
  await PlacesUtils.history.insertMany([
    {
      url: DEFAULT_URL,
      visits: [{ date: new Date(now - 3000) }],
    },
    {
      url: CONTAINER_URL,
      visits: [
        { date: new Date(now - 3000), userContextId: 2 },
        { date: new Date(now - 2000), userContextId: 2 },
      ],
    },
    {
      url: MIXED_URL,
      visits: [
        { date: new Date(now - 3000) },
        { date: new Date(now - 2000), userContextId: 3 },
        { date: new Date(now - 1000), userContextId: 2 },
      ],
    },
  ]);
  return now;
}

async function fetchVisits() {
  let db = await PlacesUtils.promiseDBConnection();
  let rows = await db.execute(
    `SELECT h.url, v.userContextId FROM moz_historyvisits v
     JOIN moz_places h ON h.id = v.place_id
     ORDER BY h.url, v.visit_date`
  );
  return rows.map(r => [
    r.getResultByName("url"),
    r.getResultByName("userContextId"),
  ]);
}

async function fetchPage(url) {
  let db = await PlacesUtils.promiseDBConnection();
  let [row] = await db.execute(
    `SELECT visit_count, last_visit_date FROM moz_places WHERE url = :url`,
    { url }
  );
  return {
    visitCount: row.getResultByName("visit_count"),
    lastVisitDate: row.getResultByName("last_visit_date"),
  };
}

function clearDataForPattern(pattern) {
  return new Promise(resolve => {
    Services.clearData.deleteDataFromOriginAttributesPattern(pattern, {
      onDataDeleted: resolve,
    });
  });
}

add_task(async function test_invalid_userContextId() {
  for (let userContextId of [-1, 1.5, "2", null]) {
    Assert.throws(
      () => PlacesUtils.history.removeVisitsByFilter({ userContextId }),
      /TypeError: Expected a non-negative integer as a userContextId/,
      `userContextId ${userContextId} should be rejected`
    );
  }
});

add_task(async function test_removeVisitsByFilter_userContextId() {
  let now = await insertVisits();

  let pageRemoved = PlacesTestUtils.waitForNotification(
    "page-removed",
    events => events.some(e => e.url == CONTAINER_URL)
  );
  let removed = [];
  Assert.ok(
    await PlacesUtils.history.removeVisitsByFilter({ userContextId: 2 }, v =>
      removed.push(v)
    ),
    "Some visits should have been removed"
  );
  Assert.equal(removed.length, 3, "All the container visits were reported");

  Assert.deepEqual(
    await fetchVisits(),
    [
      [DEFAULT_URL, 0],
      [MIXED_URL, 0],
      [MIXED_URL, 3],
    ],
    "Only the visits of the container should have been removed"
  );
  Assert.equal(
    await PlacesUtils.history.fetch(CONTAINER_URL),
    null,
    "A page visited only in the container should have been removed"
  );
  Assert.deepEqual(
    await fetchPage(MIXED_URL),
    { visitCount: 2, lastVisitDate: (now - 2000) * 1000 },
    "A page visited in other containers should be updated from its remaining visits"
  );
  let event = (await pageRemoved).find(e => e.url == CONTAINER_URL);
  Assert.ok(
    event.isRemovedFromStore,
    "A page-removed notification should report the container page as gone"
  );

  Assert.ok(
    !(await PlacesUtils.history.removeVisitsByFilter({ userContextId: 2 })),
    "Nothing should be left to remove"
  );

  await PlacesUtils.history.clear();
});

add_task(async function test_removeVisitsByFilter_userContextId_and_date() {
  let now = await insertVisits();

  Assert.ok(
    await PlacesUtils.history.removeVisitsByFilter({
      userContextId: 2,
      endDate: new Date(now - 2500),
    }),
    "Some visits should have been removed"
  );

  Assert.deepEqual(
    await fetchVisits(),
    [
      [CONTAINER_URL, 2],
      [DEFAULT_URL, 0],
      [MIXED_URL, 0],
      [MIXED_URL, 3],
      [MIXED_URL, 2],
    ],
    "Only the old visits of the container should have been removed"
  );

  await PlacesUtils.history.clear();
});

add_task(async function test_removeVisitsByFilter_userContextId_and_url() {
  await insertVisits();

  Assert.ok(
    await PlacesUtils.history.removeVisitsByFilter({
      userContextId: 2,
      url: MIXED_URL,
    }),
    "Some visits should have been removed"
  );

  Assert.deepEqual(
    await fetchVisits(),
    [
      [CONTAINER_URL, 2],
      [CONTAINER_URL, 2],
      [DEFAULT_URL, 0],
      [MIXED_URL, 0],
      [MIXED_URL, 3],
    ],
    "Only the container visits of the url should have been removed"
  );

  await PlacesUtils.history.clear();
});

add_task(async function test_removeVisitsByFilter_userContextId_and_urls() {
  await insertVisits();

  Assert.throws(
    () => PlacesUtils.history.removeVisitsByFilter({ url: [] }),
    /TypeError: Expected a valid URL for `url`/,
    "An empty array of urls should be rejected"
  );

  Assert.ok(
    await PlacesUtils.history.removeVisitsByFilter({
      userContextId: 0,
      url: [DEFAULT_URL, Services.io.newURI(MIXED_URL)],
    }),
    "Some visits should have been removed"
  );

  Assert.deepEqual(
    await fetchVisits(),
    [
      [CONTAINER_URL, 2],
      [CONTAINER_URL, 2],
      [MIXED_URL, 3],
      [MIXED_URL, 2],
    ],
    "Only the container visits of the urls should have been removed"
  );

  await PlacesUtils.history.clear();
});

add_task(async function test_removeVisitsByFilter_default_container() {
  await insertVisits();

  Assert.ok(
    await PlacesUtils.history.removeVisitsByFilter({ userContextId: 0 }),
    "Some visits should have been removed"
  );

  Assert.deepEqual(
    await fetchVisits(),
    [
      [CONTAINER_URL, 2],
      [CONTAINER_URL, 2],
      [MIXED_URL, 3],
      [MIXED_URL, 2],
    ],
    "Only the visits of the default container should have been removed"
  );
  Assert.equal(
    await PlacesUtils.history.fetch(DEFAULT_URL),
    null,
    "A page visited only in the default container should have been removed"
  );

  await PlacesUtils.history.clear();
});

add_task(async function test_clearData_userContextId() {
  await insertVisits();

  await clearDataForPattern({ userContextId: 2 });

  Assert.deepEqual(
    await fetchVisits(),
    [
      [DEFAULT_URL, 0],
      [MIXED_URL, 0],
      [MIXED_URL, 3],
    ],
    "Clearing the container data should remove its visits"
  );

  await PlacesUtils.history.clear();
});

add_task(async function test_clearData_default_container() {
  await insertVisits();

  await clearDataForPattern({ userContextId: 0 });

  Assert.deepEqual(
    await fetchVisits(),
    [
      [CONTAINER_URL, 2],
      [CONTAINER_URL, 2],
      [MIXED_URL, 3],
      [MIXED_URL, 2],
    ],
    "Clearing the default container data should remove its visits"
  );

  await PlacesUtils.history.clear();
});

add_task(async function test_clearData_empty_pattern() {
  await insertVisits();

  await clearDataForPattern({});

  Assert.deepEqual(
    await fetchVisits(),
    [],
    "An empty pattern should remove all the visits"
  );
});

add_task(async function test_clearData_ignored_patterns() {
  await insertVisits();
  let visits = await fetchVisits();

  for (let pattern of [
    { privateBrowsingId: 1 },
    { userContextId: 2, privateBrowsingId: 1 },
    { userContextId: 2, firstPartyDomain: "example.com" },
  ]) {
    await clearDataForPattern(pattern);
    Assert.deepEqual(
      await fetchVisits(),
      visits,
      `Pattern ${JSON.stringify(pattern)} should not remove any visit`
    );
  }

  await PlacesUtils.history.clear();
});
