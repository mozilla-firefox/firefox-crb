/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The max dimension for a canvas is 32,767 https://searchfox.org/mozilla-central/rev/f40d29a11f2eb4685256b59934e637012ea6fb78/gfx/cairo/cairo/src/cairo-image-surface.c#62.
// The max number of pixels for a canvas is 472,907,776 pixels (i.e., 22,528 x 20,992) https://developer.mozilla.org/en-US/docs/Web/HTML/Element/canvas#maximum_canvas_size
// We have to limit screenshots to these dimensions otherwise it will cause an error.
export const MAX_CAPTURE_DIMENSION = 32766;
export const MAX_CAPTURE_AREA = 472907776;

/**
 * Clamps dimensions to fit within MAX_CAPTURE_DIMENSION and MAX_CAPTURE_AREA constraints.
 *
 * @param {number} width - The width to potentially crop
 * @param {number} height - The height to potentially crop
 * @returns {object} Object with:
 *   - width: The cropped width
 *   - height: The cropped height
 *   - cropped: Boolean indicating if any cropping occurred
 */
export function clampDimensionsIfNeeded(width, height) {
  let cropped = false;

  if (width > MAX_CAPTURE_DIMENSION) {
    width = MAX_CAPTURE_DIMENSION;
    cropped = true;
  }
  if (height > MAX_CAPTURE_DIMENSION) {
    height = MAX_CAPTURE_DIMENSION;
    cropped = true;
  }
  if (width * height > MAX_CAPTURE_AREA) {
    height = Math.floor(MAX_CAPTURE_AREA / width);
    cropped = true;
  }

  return { width, height, cropped };
}
