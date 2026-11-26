/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

/* exported getWidgetsMerinoResults */

// `__other__` is where Glean counts a category that isn't one of the metric's
// labels, so a count recorded under the wrong category shows up there.
const WIDGETS_MERINO_CATEGORIES = [
  "success",
  "no_suggestion",
  "timeout",
  "network_error",
  "http_4xx",
  "http_5xx",
  "__other__",
];

/**
 * @param {string[]} keys
 *   The keys of `newtab.widgets_merino_result` to read.
 * @returns {object}
 *   The recorded counts for those keys, as { key: { category: n } }.
 */
function getWidgetsMerinoResults(keys) {
  let results = {};
  for (let key of keys) {
    for (let category of WIDGETS_MERINO_CATEGORIES) {
      let value = Glean.newtab.widgetsMerinoResult
        .get(key, category)
        .testGetValue();
      if (value) {
        results[key] ??= {};
        results[key][category] = value;
      }
    }
  }
  return results;
}
