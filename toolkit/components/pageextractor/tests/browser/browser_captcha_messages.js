/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Each provider's messages are written the way CaptchaDetectionChild and
// CaptchaDetectionCommunicationChild send them. The headless tests only drive
// Cloudflare Turnstile through a real actor, so the other providers' verdicts
// are only checked here.

const { captchaUpdateFromMessage } = ChromeUtils.importESModule(
  "moz-src:///toolkit/components/pageextractor/PageExtractorCaptcha.sys.mjs"
);

const PROVIDERS = [
  "g-recaptcha-v2",
  "cf-turnstile",
  "datadome",
  "hCaptcha",
  "arkoseLabs",
];

/**
 * A widget being constructed means it is on the page, not that it asks
 * anything of the visitor yet.
 */
add_task(function test_widget_construction_is_presence() {
  for (const type of PROVIDERS) {
    Assert.deepEqual(
      captchaUpdateFromMessage({
        name: "CaptchaHandler:Constructed",
        topLevel: false,
        type,
      }),
      { type, event: "shown" },
      `A ${type} widget being constructed reports presence, not a challenge.`
    );
  }
});

/**
 * Each provider's own words for its state keep their meaning.
 */
add_task(function test_provider_verdicts() {
  const cases = [
    [{ type: "g-recaptcha-v2", changes: "ImagesShown" }, "challenge"],
    [{ type: "g-recaptcha-v2", changes: "GotCheckmark" }, "passed"],
    [{ type: "cf-turnstile", result: "Succeeded" }, "passed"],
    [{ type: "cf-turnstile", result: "Failed" }, "failed"],
    [
      { type: "datadome", event: "load", captchaShown: true, blocked: false },
      "challenge",
    ],
    [
      { type: "datadome", event: "load", captchaShown: false, blocked: true },
      "blocked",
    ],
    [{ type: "datadome", event: "passed" }, "passed"],
    [{ type: "hCaptcha", changes: "shown" }, "challenge"],
    [{ type: "hCaptcha", changes: "passed" }, "passed"],
  ];
  for (const [data, event] of cases) {
    Assert.deepEqual(
      captchaUpdateFromMessage({
        name: "CaptchaState:Update",
        topLevel: false,
        ...data,
      }),
      { type: data.type, event },
      `${JSON.stringify(data)} means "${event}".`
    );
  }
});

/**
 * A message that carries no verdict PageExtractor acts on is ignored.
 */
add_task(function test_messages_without_a_verdict() {
  const cases = [
    { type: "datadome", event: "load", captchaShown: false, blocked: false },
    { type: "g-recaptcha-v2", changes: "unsupported-state" },
    { type: "hCaptcha", changes: "unsupported-state" },
    { type: "arkoseLabs", changes: "passed" },
    { type: "unsupported-provider", changes: "passed" },
  ];
  for (const data of cases) {
    Assert.strictEqual(
      captchaUpdateFromMessage({
        name: "CaptchaState:Update",
        topLevel: false,
        ...data,
      }),
      null,
      `${JSON.stringify(data)} carries no verdict.`
    );
  }
});

/**
 * A widget whose own document is the page, such as a provider's demo page,
 * is the page the caller asked for rather than a check in front of it.
 */
add_task(function test_top_level_widget_is_the_page() {
  Assert.strictEqual(
    captchaUpdateFromMessage({
      name: "CaptchaState:Update",
      topLevel: true,
      type: "g-recaptcha-v2",
      changes: "ImagesShown",
    }),
    null,
    "A challenge in a top-level widget document is not a block."
  );
});
