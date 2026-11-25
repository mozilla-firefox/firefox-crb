/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Counts one Merino request sent by a New Tab widget in
 * `newtab.widgets_merino_result`. Takes what MerinoClient passes to an
 * `onResult` callback.
 *
 * @param {string} key
 *   The request, one of the metric's keys (for example "weather_report").
 * @param {string} status
 *   "success", "no_suggestion", "timeout", "network_error" or "http_error".
 * @param {object} [details]
 * @param {?number} [details.httpStatus]
 *   The status code of the response, used to count an "http_error" as
 *   "http_4xx" or "http_5xx".
 */
export function recordWidgetsMerinoResult(key, status, { httpStatus } = {}) {
  let category = status;
  if (status === "http_error") {
    if (httpStatus >= 400 && httpStatus < 500) {
      category = "http_4xx";
    } else if (httpStatus >= 500 && httpStatus < 600) {
      category = "http_5xx";
    } else {
      category = "network_error";
    }
  }
  /**
   * @backward-compat { version 163 }
   * A train-hopped New Tab can run on a Firefox that doesn't have this metric.
   * Drop the optional chaining once 163 reaches Release.
   */
  Glean.newtab.widgetsMerinoResult?.get(key, category).add(1);
}

/**
 * Holds the result MerinoClient reports for one request until the caller knows
 * whether it could use the response. In the metric, "success" means that it
 * could: a "success" the caller couldn't use is counted as "no_suggestion".
 *
 * @param {string} key
 *   The request, one of the metric's keys.
 * @returns {{onResult: (status: string, details?: {httpStatus?: ?number}) => void, record: (usable?: boolean) => void}}
 *   Pass `onResult` to MerinoClient, then call `record` when the request is
 *   done. `record` counts nothing if MerinoClient reported no result, which is
 *   what happens when no request was sent.
 */
export function trackWidgetsMerinoResult(key) {
  let result = null;
  return {
    onResult(status, details) {
      result = { status, details };
    },
    record(usable = true) {
      if (!result) {
        return;
      }
      let { status, details } = result;
      result = null;
      recordWidgetsMerinoResult(
        key,
        status === "success" && !usable ? "no_suggestion" : status,
        details
      );
    },
  };
}
