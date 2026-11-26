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
        { date: new Date(now - 2000), userContextId: 2 },
        { date: new Date(now - 1000), userContextId: 3 },
      ],
    },
  ]);
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

function clearDataForPattern(pattern) {
  return new Promise(resolve => {
    Services.clearData.deleteDataFromOriginAttributesPattern(pattern, {
      onDataDeleted: resolve,
    });
  });
}

add_task(async function test_invalid_userContextId() {
  for (let userContextId of [0, -1, 1.5, "2", null]) {
    Assert.throws(
      () => PlacesUtils.history.countPagesByUserContextId(userContextId),
      /TypeError: Expected a non-default userContextId/,
      `countPagesByUserContextId throws for ${userContextId}`
    );
    Assert.throws(
      () => PlacesUtils.history.moveVisitsToDefaultUserContext(userContextId),
      /TypeError: Expected a non-default userContextId/,
      `moveVisitsToDefaultUserContext throws for ${userContextId}`
    );
  }
});

add_task(async function test_countPagesByUserContextId() {
  await insertVisits();

  Assert.equal(
    await PlacesUtils.history.countPagesByUserContextId(2),
    2,
    "Pages are counted once even with several visits"
  );
  Assert.equal(await PlacesUtils.history.countPagesByUserContextId(3), 1);
  Assert.equal(await PlacesUtils.history.countPagesByUserContextId(4), 0);

  await PlacesUtils.history.clear();
});

add_task(async function test_countPagesByUserContextId_skips_hidden() {
  await insertVisits();
  await PlacesUtils.withConnectionWrapper("test", db =>
    db.execute("UPDATE moz_places SET hidden = 1 WHERE url = :url", {
      url: MIXED_URL,
    })
  );

  Assert.equal(
    await PlacesUtils.history.countPagesByUserContextId(2),
    1,
    "Hidden pages, like redirect sources, are not counted"
  );
  Assert.equal(await PlacesUtils.history.countPagesByUserContextId(3), 0);

  await PlacesUtils.history.clear();
});

add_task(async function test_moveVisitsToDefaultUserContext() {
  await insertVisits();

  await PlacesUtils.history.moveVisitsToDefaultUserContext(2);

  Assert.deepEqual(
    await fetchVisits(),
    [
      [CONTAINER_URL, 0],
      [CONTAINER_URL, 0],
      [DEFAULT_URL, 0],
      [MIXED_URL, 0],
      [MIXED_URL, 0],
      [MIXED_URL, 3],
    ],
    "Only the visits of the container are moved"
  );
  Assert.equal(await PlacesUtils.history.countPagesByUserContextId(2), 0);

  await PlacesUtils.history.clear();
});

add_task(async function test_moved_visits_survive_clearing_container_data() {
  await insertVisits();

  await PlacesUtils.history.moveVisitsToDefaultUserContext(2);
  await clearDataForPattern({ userContextId: 2 });

  Assert.deepEqual(
    await fetchVisits(),
    [
      [CONTAINER_URL, 0],
      [CONTAINER_URL, 0],
      [DEFAULT_URL, 0],
      [MIXED_URL, 0],
      [MIXED_URL, 0],
      [MIXED_URL, 3],
    ],
    "Clearing the container data keeps the moved visits"
  );

  await PlacesUtils.history.clear();
});
