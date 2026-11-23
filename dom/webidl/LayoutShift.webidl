/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * The origin of this IDL file is
 * https://wicg.github.io/layout-instability/
 */

[Pref="dom.enable_layout_shift",
 Exposed=Window]
interface LayoutShift : PerformanceEntry {
  readonly attribute double value;
  readonly attribute boolean hadRecentInput;
  readonly attribute DOMHighResTimeStamp lastInputTime;
  [Frozen, Cached, Constant]
  readonly attribute sequence<LayoutShiftAttribution> sources;
  [Default] object toJSON();
};

[Pref="dom.enable_layout_shift",
 Exposed=Window]
interface LayoutShiftAttribution {
  readonly attribute Node? node;
  readonly attribute DOMRectReadOnly previousRect;
  readonly attribute DOMRectReadOnly currentRect;
};
