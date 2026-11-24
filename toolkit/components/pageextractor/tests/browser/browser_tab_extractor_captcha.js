/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// A tab the user has open loads a page with a captcha frame. PageExtractor
// matches the frame's URL through a test hook; browser_captcha_urls.js checks
// real URLs.

const { setTestFrames } = ChromeUtils.importESModule(
  "moz-src:///toolkit/components/pageextractor/PageExtractorCaptcha.sys.mjs"
);

const TEST_DIR = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  ""
);
const CAPTCHA_FRAME = `https://example.org${TEST_DIR}captcha_frame.html`;

add_setup(() => {
  setTestFrames([`${CAPTCHA_FRAME}*`]);
  registerCleanupFunction(() => setTestFrames(null));
});

/**
 * Opens a tab on a page with `text` and, unless `withFrame` is false, a
 * Cloudflare Turnstile iframe.
 *
 * @param {string} text
 * @param {boolean} [withFrame]
 */
function openCaptchaPage(text, withFrame = true) {
  const { html } = MLTestUtils.serveHTMLInTab({ browser: gBrowser });
  return withFrame
    ? html`
        <p>${text}</p>
        <iframe src=${CAPTCHA_FRAME}></iframe>
      `
    : html`<p>${text}</p>`;
}

/**
 * A tab that is little more than a captcha widget is reported as blocked.
 */
add_task(async function test_tab_showing_captcha_is_blocked() {
  Services.fog.testResetFOG();
  const { getPageExtractor, cleanup } = await openCaptchaPage(
    "Verify you are human."
  );

  let flowId;
  try {
    await Assert.rejects(
      getPageExtractor().getText(),
      error => {
        flowId = error.flowId;
        return (
          error.name === "BlockedError" &&
          error.blockReason === "captcha" &&
          error.captchaType === "cf-turnstile" &&
          error.captchaEvent === "shown"
        );
      },
      "The bot check's text in a tab is not mistaken for the page's content."
    );
  } finally {
    await cleanup();
  }

  const getText = findParentPhaseEvent("get-text");
  is(getText.extra.status, "blocked", "Telemetry records a block.");
  is(getText.extra.block_reason, "captcha", "Telemetry records why.");
  is(
    getText.extra.captcha_type,
    "cf-turnstile",
    "Telemetry names the captcha."
  );
  ok(flowId, "The block names a flow, so a caller can join the read's.");
  is(
    flowId,
    getText.extra.flow_id,
    "It is the flow the blocked read was recorded under."
  );
});

/**
 * A widget beside readable content in a tab, as on a comment form, doesn't
 * block.
 */
add_task(async function test_tab_with_captcha_beside_content_is_read() {
  const text = "An article long enough to read. ".repeat(40).trim();
  const { getPageExtractor, cleanup } = await openCaptchaPage(text);

  try {
    is(
      (await getPageExtractor().getText()).text,
      text,
      "The page's own content is extracted."
    );
  } finally {
    await cleanup();
  }
});

/**
 * A short page without a captcha frame is read, not taken for a bot check.
 */
add_task(async function test_short_tab_without_captcha_frame_is_read() {
  const { getPageExtractor, cleanup } = await openCaptchaPage(
    "Welcome back.",
    false
  );

  try {
    is(
      (await getPageExtractor().getText()).text,
      "Welcome back.",
      "A short page without a captcha frame is read."
    );
  } finally {
    await cleanup();
  }
});

/**
 * With captcha detection turned off, a tab showing a captcha is read as is.
 */
add_task(async function test_tab_captcha_ignored_when_disabled() {
  await SpecialPowers.pushPrefEnv({
    set: [["browser.ml.pageExtractor.captchaDetection.enabled", false]],
  });
  const { getPageExtractor, cleanup } = await openCaptchaPage(
    "Verify you are human."
  );

  try {
    is(
      (await getPageExtractor().getText()).text,
      "Verify you are human.",
      "The page is read as is when captcha detection is disabled."
    );
  } finally {
    await cleanup();
    await SpecialPowers.popPrefEnv();
  }
});
