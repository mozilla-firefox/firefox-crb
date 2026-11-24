/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * @import { CaptchaUpdate } from './PageExtractor.d.ts'
 */

// The widget frames CaptchaDetectionChild's handlers recognize.
const RECAPTCHA_V2_FRAMES = new MatchPatternSet([
  "https://www.google.com/recaptcha/api2/*",
  "https://www.google.com/recaptcha/enterprise/*",
]);

// "f/av0/rch" is Cloudflare's frame as of October 2026, "if/ov2/av0/rcv" the
// one before.
const CF_TURNSTILE_FRAMES = new MatchPatternSet([
  "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/*/turnstile/if/ov2/av0/rcv/*",
  "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/*/turnstile/f/av0/rch/*",
]);

const DATADOME_FRAMES = new MatchPatternSet([
  "https://geo.captcha-delivery.com/captcha/*",
]);

// A match pattern's path includes the query, so the page is matched both
// with and without one.
const HCAPTCHA_FRAMES = new MatchPatternSet([
  "https://newassets.hcaptcha.com/captcha/v1/*/static/hcaptcha.html",
  "https://newassets.hcaptcha.com/captcha/v1/*/static/hcaptcha.html?*",
]);

const ARKOSE_LABS_FRAMES = new MatchPatternSet([
  "https://client-api.arkoselabs.com/fc/assets/ec-game-core/game-core/*",
]);

// Only list scripts whose widget CaptchaDetectionChild reports, or a read
// waits for a report that never comes.
const RECAPTCHA_V2_SCRIPTS = new MatchPatternSet([
  "https://www.google.com/recaptcha/api.js",
  "https://www.google.com/recaptcha/api.js?*",
  "https://www.google.com/recaptcha/enterprise.js",
  "https://www.google.com/recaptcha/enterprise.js?*",
]);

const HCAPTCHA_SCRIPTS = new MatchPatternSet([
  "https://js.hcaptcha.com/1/api.js",
  "https://js.hcaptcha.com/1/api.js?*",
]);

// Only served on DataDome's block page, beside its captcha frame.
const DATADOME_SCRIPTS = new MatchPatternSet([
  "https://ct.captcha-delivery.com/c.js",
  "https://ct.captcha-delivery.com/c.js?*",
]);

const CF_TURNSTILE_SCRIPTS = new MatchPatternSet([
  "https://challenges.cloudflare.com/turnstile/v0/api.js",
  "https://challenges.cloudflare.com/turnstile/v0/api.js?*",
]);

/** @type {Set<CaptchaUpdate["event"]>} */
export const BLOCKING_CAPTCHA_EVENTS = new Set([
  "challenge",
  "blocked",
  "failed",
]);

/** @type {Map<string, string>} */
export const CAPTCHA_PROVIDER_NAMES = new Map([
  ["g-recaptcha-v2", "Google reCAPTCHA"],
  ["cf-turnstile", "Cloudflare Turnstile"],
  ["datadome", "DataDome"],
  ["hCaptcha", "hCaptcha"],
  ["arkoseLabs", "Arkose Labs"],
]);

/** @type {Map<CaptchaUpdate["event"], string>} */
export const CAPTCHA_EVENT_LABELS = new Map([
  ["shown", "widget shown"],
  ["challenge", "puzzle presented"],
  ["blocked", "visitor refused"],
  ["failed", "check failed"],
  ["passed", "check passed"],
]);

/** @type {Map<string, CaptchaUpdate["event"]>} */
const RECAPTCHA_EVENTS = new Map([
  ["ImagesShown", "challenge"],
  ["GotCheckmark", "passed"],
]);

/** @type {Map<string, CaptchaUpdate["event"]>} */
const HCAPTCHA_EVENTS = new Map([
  ["shown", "challenge"],
  ["passed", "passed"],
]);

/**
 * @param {Record<string, any>} message - A "captcha-detection-message"
 *   notification's JSON data.
 * @returns {CaptchaUpdate | null}
 */
export function captchaUpdateFromMessage(message) {
  if (message.topLevel) {
    // Sites embed the widget document in a frame, and a redirect to the
    // provider's origin is already blocked as off-site, so a top-level widget
    // is the page the caller asked for, such as Google's reCAPTCHA demo.
    return null;
  }
  const event =
    message.name === "CaptchaHandler:Constructed"
      ? "shown"
      : stateUpdateEvent(message);
  return event ? { type: message.type, event } : null;
}

/**
 * @param {Record<string, any>} data - A "CaptchaState:Update" message's data.
 * @returns {CaptchaUpdate["event"] | null}
 */
function stateUpdateEvent(data) {
  switch (data.type) {
    case "g-recaptcha-v2":
      return RECAPTCHA_EVENTS.get(data.changes) ?? null;
    case "cf-turnstile":
      return data.result === "Succeeded" ? "passed" : "failed";
    case "datadome":
      if (data.event === "passed") {
        return "passed";
      }
      if (data.blocked) {
        return "blocked";
      }
      return data.captchaShown ? "challenge" : null;
    case "hCaptcha":
      return HCAPTCHA_EVENTS.get(data.changes) ?? null;
  }
  return null;
}

/**
 * @param {nsIURI} uri
 * @returns {string | null} The provider whose widget frame is at `uri`.
 */
export function captchaTypeForURI(uri) {
  if (RECAPTCHA_V2_FRAMES.matches(uri)) {
    const size = URL.fromURI(uri).searchParams.get("size");
    return size === "invisible" ? null : "g-recaptcha-v2";
  }
  if (CF_TURNSTILE_FRAMES.matches(uri)) {
    return "cf-turnstile";
  }
  if (DATADOME_FRAMES.matches(uri)) {
    return "datadome";
  }
  if (HCAPTCHA_FRAMES.matches(uri)) {
    // hCaptcha passes its frame's options in the fragment.
    const options = new URLSearchParams(URL.fromURI(uri).hash.slice(1));
    return options.get("size") === "invisible" ||
      options.get("frame") === "checkbox-invisible"
      ? null
      : "hCaptcha";
  }
  if (ARKOSE_LABS_FRAMES.matches(uri)) {
    return "arkoseLabs";
  }
  return null;
}

/**
 * Test-only widget frames, matched as Cloudflare Turnstile's.
 *
 * @type {MatchPatternSet | null}
 */
let testFrames = null;

/**
 * @param {string[] | null} patterns - null resets.
 */
export function setTestFrames(patterns) {
  if (!Cu.isInAutomation) {
    throw new Error("Only available in automation.");
  }
  testFrames = patterns && new MatchPatternSet(patterns);
}

/**
 * Test-only loader scripts, matched as Cloudflare Turnstile's.
 *
 * @type {MatchPatternSet | null}
 */
let testScripts = null;

/**
 * @param {string[] | null} patterns - null resets.
 */
export function setTestScripts(patterns) {
  if (!Cu.isInAutomation) {
    throw new Error("Only available in automation.");
  }
  testScripts = patterns && new MatchPatternSet(patterns);
}

/**
 * @param {nsIURI} uri
 * @returns {string | null} The provider whose widget-loading script `uri` is.
 */
export function captchaTypeForLoaderScript(uri) {
  if (testScripts?.matches(uri)) {
    return "cf-turnstile";
  }
  if (RECAPTCHA_V2_SCRIPTS.matches(uri)) {
    // v3 loads as api.js?render=<site key> and only renders an invisible
    // frame, which GoogleRecaptchaV2Handler skips; v2 uses render=explicit.
    const render = URL.fromURI(uri).searchParams.get("render");
    return render && render !== "explicit" ? null : "g-recaptcha-v2";
  }
  if (HCAPTCHA_SCRIPTS.matches(uri)) {
    return "hCaptcha";
  }
  if (DATADOME_SCRIPTS.matches(uri)) {
    return "datadome";
  }
  if (CF_TURNSTILE_SCRIPTS.matches(uri)) {
    return "cf-turnstile";
  }
  return null;
}

/**
 * Matches frame URLs alone, so a caller needn't wait for a frame's actor to
 * report in.
 *
 * @param {BrowsingContext} browsingContext - The page's top BrowsingContext.
 * @returns {CaptchaUpdate | null} A "shown" update for the first captcha
 *   frame found.
 */
export function findCaptchaFrame(browsingContext) {
  for (const context of browsingContext.getAllBrowsingContextsInSubtree()) {
    const uri = context.currentURI;
    if (!uri || context === browsingContext) {
      continue;
    }
    const type = testFrames?.matches(uri)
      ? "cf-turnstile"
      : captchaTypeForURI(uri);
    if (type) {
      return { type, event: "shown" };
    }
  }
  return null;
}
