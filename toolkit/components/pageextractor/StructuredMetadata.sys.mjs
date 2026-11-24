/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// @ts-check

/**
 * @import { MetaTag, StructuredMetadata } from './PageExtractor.d.ts'
 */

const HTML_META_NAMES = new Set([
  "description",
  "keywords",
  "author",
  "robots",
]);

/**
 * Open Graph with its object type vocabularies (https://ogp.me/#types) and
 * commerce product vocabulary, and Twitter Cards.
 */
const SOCIAL_META_PREFIXES = [
  "og:",
  "article:",
  "book:",
  "profile:",
  "music:",
  "video:",
  "product:",
  "twitter:",
];

// Real pages stay well under these. They bound what a hostile page can send
// to the parent process.
const MAX_META_TAGS = 50;
const MAX_META_LENGTH = 1000;
const MAX_JSON_LD_LENGTH = 100_000;

/**
 * Keeps repeats and conflicts so callers can pick the ones that matter.
 * StructuredMetadataReader interprets the result.
 *
 * @param {Document} document
 * @returns {StructuredMetadata}
 */
export function extractStructuredMetadata(document) {
  let truncated = false;
  // Long values are dropped, not cut: a cut URL still parses, as a different
  // URL.
  const limit = text => {
    if (text.length <= MAX_META_LENGTH) {
      return text;
    }
    truncated = true;
    return null;
  };

  const title = limit(document.title) ?? "";
  const canonicalHref = document.querySelector(
    'link[rel~="canonical" i][href]'
  )?.href;
  const canonicalUrl = canonicalHref ? limit(canonicalHref) : null;
  const lang = document.documentElement?.lang;
  const language = lang ? limit(lang) : null;

  /** @type {MetaTag[]} */
  const metaTags = [];
  let metaTagsFull = false;
  for (const meta of document.querySelectorAll("meta[content]")) {
    // Open Graph uses `property` and Twitter Cards `name`, but pages mix them
    // up and some set both on one tag.
    const names = new Set(
      [meta.getAttribute("property"), meta.getAttribute("name")]
        .filter(Boolean)
        .map(name => name.toLowerCase())
    );
    for (const name of names) {
      if (
        !HTML_META_NAMES.has(name) &&
        !SOCIAL_META_PREFIXES.some(prefix => name.startsWith(prefix))
      ) {
        continue;
      }
      const value = meta.getAttribute("content");
      if (!value.trim()) {
        break;
      }
      if (metaTags.length >= MAX_META_TAGS) {
        truncated = true;
        metaTagsFull = true;
        break;
      }
      const limited = limit(value);
      if (limited === null) {
        break;
      }
      metaTags.push({ name, value: limited });
    }
    if (metaTagsFull) {
      break;
    }
  }

  const jsonLd = [];
  let remainingLength = MAX_JSON_LD_LENGTH;
  for (const script of document.querySelectorAll(
    'script[type="application/ld+json" i]'
  )) {
    const text = script.textContent?.trim();
    if (!text) {
      continue;
    }
    if (remainingLength <= 0) {
      truncated = true;
      break;
    }
    if (text.length > remainingLength) {
      truncated = true;
      continue;
    }
    remainingLength -= text.length;
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed != "object") {
      continue;
    }
    try {
      jsonLd.push(JSON.stringify(parsed));
    } catch {
      // The block is nested too deeply to send to the parent process.
      truncated = true;
    }
  }

  const baseUrl = URL.parse(document.baseURI);
  const url =
    baseUrl?.protocol == "https:" || baseUrl?.protocol == "http:"
      ? limit(baseUrl.href)
      : null;
  return {
    truncated,
    url,
    title,
    canonicalUrl,
    language,
    metaTags,
    jsonLd,
  };
}
