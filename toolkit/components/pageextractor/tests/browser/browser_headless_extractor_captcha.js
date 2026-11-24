/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// A real hidden browser loads a page with a captcha frame that the real
// CaptchaDetection actor recognizes. PageExtractor matches the frame's URL
// through a test hook; browser_captcha_urls.js checks real URLs.

const { PageExtractorParent } = ChromeUtils.importESModule(
  "resource://gre/actors/PageExtractorParent.sys.mjs"
);
const { ProfilerTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/ProfilerTestUtils.sys.mjs"
);
const { captchaUpdateFromMessage, setTestFrames } = ChromeUtils.importESModule(
  "moz-src:///toolkit/components/pageextractor/PageExtractorCaptcha.sys.mjs"
);

const TEST_DIR = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  ""
);
const CAPTCHA_FRAME = `https://example.org${TEST_DIR}captcha_frame.html`;
const CAPTCHA_TOPIC = "captcha-detection-message";

add_setup(() => {
  setTestFrames([`${CAPTCHA_FRAME}*`]);
  registerCleanupFunction(() => setTestFrames(null));
});

/**
 * Serves a page with `text` and a Cloudflare Turnstile iframe.
 *
 * @param {string} text
 * @param {"fail"|"success"} [state] - The verdict; omitted, it only loads.
 */
function serveCaptchaPage(text, state) {
  const { html } = MLTestUtils.serveHTML();
  const frameUrl = state ? `${CAPTCHA_FRAME}?state=${state}` : CAPTCHA_FRAME;
  return html`
    <p>${text}</p>
    <iframe src=${frameUrl} onload="this.dataset.loaded = 'true'"></iframe>
  `;
}

/**
 * Resolves once CaptchaDetection reports `event` for a captcha in any page.
 *
 * @param {string} event
 */
function captchaUpdate(event) {
  return TestUtils.topicObserved(
    CAPTCHA_TOPIC,
    (_subject, data) =>
      captchaUpdateFromMessage(JSON.parse(data))?.event === event
  );
}

/**
 * A failed captcha blocks the read at once.
 */
add_task(async function test_failed_captcha_blocks_immediately() {
  Services.fog.testResetFOG();
  const { url, cleanup } = serveCaptchaPage("Verify you are human.", "fail");

  try {
    await Assert.rejects(
      PageExtractorParent.getHeadlessExtractor({
        urlString: url,
        // Never settles: only the captcha verdict can end this read.
        callback: () => new Promise(() => {}),
      }),
      error =>
        error.name === "BlockedError" &&
        error.blockReason === "captcha" &&
        error.captchaType === "cf-turnstile" &&
        error.captchaEvent === "failed",
      "The failed bot check is reported as a captcha block naming the provider."
    );
  } finally {
    await cleanup();
  }

  const headless = findParentPhaseEvent("headless-extractor");
  is(headless.extra.status, "blocked", "Telemetry records a block.");
  is(headless.extra.block_reason, "captcha", "Telemetry records why.");
  is(
    headless.extra.captcha_type,
    "cf-turnstile",
    "Telemetry names the captcha."
  );
  is(headless.extra.captcha_event, "failed", "Telemetry records the verdict.");

  const detected = findParentPhaseEvent("captcha-detected");
  ok(detected, "The moment the captcha appeared is recorded.");
  is(
    detected.extra.flow_id,
    headless.extra.flow_id,
    "The captcha-detected phase belongs to the same flow as the load."
  );

  is(
    Glean.captchaDetection.cloudflareTurnstileOc.testGetValue(),
    null,
    "A captcha in a hidden browser stays out of the user-facing captcha ping."
  );
});

/**
 * A page that is little more than a captcha widget is reported as blocked.
 */
add_task(async function test_short_page_with_captcha_is_blocked() {
  const { url, cleanup } = serveCaptchaPage("Checking your browser.");
  const shown = captchaUpdate("shown");

  try {
    await Assert.rejects(
      PageExtractorParent.getHeadlessExtractor({
        urlString: url,
        callback: async (pageExtractor, traceId) => {
          await shown;
          return pageExtractor.getText({}, traceId);
        },
      }),
      error =>
        error.name === "BlockedError" &&
        error.blockReason === "captcha" &&
        error.captchaEvent === "shown",
      "The bot check's text is not mistaken for the page's content."
    );
  } finally {
    await cleanup();
  }
});

/**
 * A passed bot check lets the page be read, however short.
 */
add_task(async function test_passed_captcha_does_not_block() {
  const { url, cleanup } = serveCaptchaPage(
    "Checking your browser.",
    "success"
  );
  const passed = captchaUpdate("passed");

  try {
    const result = await PageExtractorParent.getHeadlessExtractor({
      urlString: url,
      callback: async (pageExtractor, traceId) => {
        await passed;
        return pageExtractor.getText({}, traceId);
      },
    });
    is(
      result.text,
      "Checking your browser.",
      "A passed bot check is not reported as a block."
    );
  } finally {
    await cleanup();
  }
});

/**
 * A read failing beside a widget that only loaded keeps its own error:
 * nothing shows the widget caused it.
 */
add_task(async function test_failure_beside_shown_captcha_is_not_a_block() {
  const { url, cleanup } = serveCaptchaPage("Checking your browser.");
  const shown = captchaUpdate("shown");

  try {
    await Assert.rejects(
      PageExtractorParent.getHeadlessExtractor({
        urlString: url,
        callback: async () => {
          await shown;
          throw new DOMException("The read stalled.", "TimeoutError");
        },
      }),
      error => error.name === "TimeoutError" && !error.blockReason,
      "The failure is reported as itself, not blamed on the captcha."
    );
  } finally {
    await cleanup();
  }
});

/**
 * A captcha frame on the page counts even if its actor never reported in.
 * With the actor off, only the frame's URL can give it away.
 */
add_task(async function test_captcha_frame_found_without_actor_report() {
  Services.fog.testResetFOG();
  await SpecialPowers.pushPrefEnv({
    set: [["captchadetection.actor.enabled", false]],
  });
  const { url, cleanup } = serveCaptchaPage("Checking your browser.");
  const updates = [];
  const observer = (_subject, _topic, data) => updates.push(data);
  Services.obs.addObserver(observer, CAPTCHA_TOPIC);

  try {
    await Assert.rejects(
      PageExtractorParent.getHeadlessExtractor({
        urlString: url,
        callback: async (pageExtractor, traceId) => {
          await SpecialPowers.spawn(
            pageExtractor.browsingContext,
            [],
            async () => {
              const frame = content.document.querySelector("iframe");
              if (frame.dataset.loaded !== "true") {
                await ContentTaskUtils.waitForEvent(frame, "load");
              }
            }
          );
          return pageExtractor.getText({}, traceId);
        },
      }),
      error =>
        error.name === "BlockedError" &&
        error.blockReason === "captcha" &&
        error.captchaType === "cf-turnstile" &&
        error.captchaEvent === "shown",
      "The captcha frame on the page is found when the page is read."
    );
  } finally {
    Services.obs.removeObserver(observer, CAPTCHA_TOPIC);
    await cleanup();
    await SpecialPowers.popPrefEnv();
  }
  Assert.deepEqual(
    updates,
    [],
    "No actor reported the captcha, so the frame's URL found it."
  );

  const headless = findParentPhaseEvent("headless-extractor");
  is(headless.extra.block_reason, "captcha", "Telemetry records why.");
  is(
    headless.extra.captcha_type,
    "cf-turnstile",
    "Telemetry names the captcha found only when the page was read."
  );
  is(
    headless.extra.captcha_event,
    "shown",
    "Telemetry records the captcha's state."
  );
  is(
    findParentPhaseEvent("captcha-detected").extra.detected_by,
    "frame-url",
    "Telemetry says the captcha was found by its frame's URL at read time."
  );
});

/**
 * A widget beside readable content, as on a comment form, doesn't block.
 */
add_task(async function test_captcha_beside_content_is_read() {
  Services.fog.testResetFOG();
  const text = "An article long enough to read. ".repeat(40).trim();
  const { url, cleanup } = serveCaptchaPage(text);
  const shown = captchaUpdate("shown");

  try {
    const result = await PageExtractorParent.getHeadlessExtractor({
      urlString: url,
      callback: async (pageExtractor, traceId) => {
        await shown;
        return pageExtractor.getText({}, traceId);
      },
    });
    is(result.text, text, "The page's own content is extracted.");
  } finally {
    await cleanup();
  }

  is(
    findParentPhaseEvent("headless-extractor").extra.captcha_type,
    "cf-turnstile",
    "A captcha beside readable content is still recorded on the load."
  );
});

/**
 * A Cloudflare challenge response blocks the read, on both fetch paths,
 * before its empty page can be read.
 */
add_task(async function test_cloudflare_challenge_response_is_blocked() {
  const url = `https://example.com${TEST_DIR}cf_challenge.sjs`;
  for (const anonymousFetch of [false, true]) {
    Services.fog.testResetFOG();
    await Assert.rejects(
      PageExtractorParent.getHeadlessExtractor({
        urlString: url,
        anonymousFetch,
        callback: (pageExtractor, traceId) =>
          pageExtractor.getText({}, traceId),
      }),
      error =>
        error.name === "BlockedError" &&
        error.blockReason === "captcha" &&
        error.captchaType === "cf-turnstile" &&
        error.captchaEvent === "challenge",
      `The challenge page is reported as a Cloudflare block (anonymousFetch: ${anonymousFetch}).`
    );

    is(
      findParentPhaseEvent("headless-extractor").extra.status,
      "blocked",
      "Telemetry records a block."
    );
    ok(
      findParentPhaseEvent("captcha-detected"),
      "The moment the challenge was found is recorded."
    );
  }
});

/**
 * With the consumer turned off, a captcha is not reported as a block.
 */
add_task(async function test_disabled_ignores_captcha() {
  await SpecialPowers.pushPrefEnv({
    set: [["browser.ml.pageExtractor.captchaDetection.enabled", false]],
  });
  const { url, cleanup } = serveCaptchaPage("Checking your browser.");
  const shown = captchaUpdate("shown");

  try {
    const result = await PageExtractorParent.getHeadlessExtractor({
      urlString: url,
      callback: async (pageExtractor, traceId) => {
        await shown;
        return pageExtractor.getText({}, traceId);
      },
    });
    is(
      result.text,
      "Checking your browser.",
      "The page is read as-is when captcha detection is disabled."
    );
  } finally {
    await cleanup();
    await SpecialPowers.popPrefEnv();
  }
});

/**
 * A profile shows the captcha on the same PageExtractor track as the load it
 * blocked.
 */
add_task(async function test_captcha_profiler_markers() {
  const { url, cleanup } = serveCaptchaPage("Verify you are human.", "fail");

  await ProfilerTestUtils.startProfilerForMarkerTests();
  let profile;
  try {
    await Assert.rejects(
      PageExtractorParent.getHeadlessExtractor({
        urlString: url,
        callback: () => new Promise(() => {}),
      }),
      error => error.name === "BlockedError",
      "The read is blocked."
    );
    profile = await ProfilerTestUtils.stopNowAndGetProfile();
  } finally {
    if (Services.profiler.IsActive()) {
      await Services.profiler.StopProfiler();
    }
    await cleanup();
  }

  const markers = ProfilerTestUtils.getPayloadsOfTypeFromAllThreads(
    profile,
    "PageExtractor"
  );
  const headless = markers.find(m => m.phase === "headless-extractor");
  is(headless.blockReason, "captcha", "The load marker says why it failed.");
  is(
    headless.outcome,
    "blocked by Cloudflare Turnstile (check failed)",
    "The load marker says in plain words who blocked it and how."
  );
  is(
    headless.color,
    "yellow",
    "A block is drawn as an outcome the caller handles, not an error."
  );
  is(
    headless.captchaType,
    "cf-turnstile",
    "The load marker names the captcha."
  );
  const detected = markers.find(m => m.phase === "captcha-detected");
  ok(detected, "A captcha-detected marker is recorded.");
  is(
    detected.traceId,
    headless.traceId,
    "The captcha-detected marker is drawn on the blocked load's track."
  );
  is(
    detected.outcome,
    "Cloudflare Turnstile (widget shown), found by its frame reporting in",
    "The captcha-detected marker names the captcha and what it did first."
  );
  is(detected.color, "blue", "A captcha showing up is not an error.");
});

/**
 * A top-level page at a widget's address, like a demo page, is read even
 * after CaptchaDetection reports it.
 */
add_task(async function test_page_at_widget_address_is_read() {
  const reported = TestUtils.topicObserved(CAPTCHA_TOPIC, (_subject, data) => {
    const message = JSON.parse(data);
    return message.name === "CaptchaHandler:Constructed" && message.topLevel;
  });
  const result = await PageExtractorParent.getHeadlessExtractor({
    urlString: CAPTCHA_FRAME,
    callback: async (pageExtractor, traceId) => {
      await reported;
      return pageExtractor.getText({}, traceId);
    },
  });
  is(result.text, "", "The page is read, not taken for a bot check.");
});
