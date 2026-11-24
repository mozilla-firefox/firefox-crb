/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// @ts-check

/**
 * @import { StructuredMetadata } from './PageExtractor.d.ts'
 */

/**
 * Site and page furniture types that SEO plugins add to most pages.
 */
const SITE_LEVEL_TYPES = new Set([
  "BreadcrumbList",
  "ImageObject",
  "ListItem",
  "Organization",
  "Person",
  "SearchAction",
  "SiteNavigationElement",
  "WebSite",
  "WPFooter",
  "WPHeader",
  "WPSideBar",
]);

const SCHEMA_ORG_PREFIXES = [
  "https://schema.org/",
  "http://schema.org/",
  "schema:",
];

/**
 * @param {string} type - A type as the page wrote it, e.g. "Recipe",
 *   "schema:Recipe" or "https://schema.org/Recipe".
 * @returns {string} The type without its schema.org prefix.
 */
function schemaOrgName(type) {
  const prefix = SCHEMA_ORG_PREFIXES.find(candidate =>
    type.startsWith(candidate)
  );
  return prefix ? type.slice(prefix.length) : type;
}

/**
 * @param {Record<string, any>} item
 * @returns {string[]}
 */
function typesOf(item) {
  return [item["@type"]]
    .flat()
    .filter(type => typeof type == "string")
    .map(schemaOrgName);
}

/**
 * @param {string} type
 * @returns {boolean}
 */
function isWebPageType(type) {
  return type.endsWith("Page");
}

/**
 * Interprets PageExtractorParent#getStructuredMetadata for features: finds
 * schema.org items, follows their references, and picks common fields such as
 * the title across sources. Values come from the page and are untrusted.
 */
export class StructuredMetadataReader {
  /** @type {StructuredMetadata} */
  #metadata;
  /** @type {Array<Record<string, any>>} */
  #items = [];
  /** @type {Array<Record<string, any>>} */
  #topLevelItems = [];
  /** @type {Map<string, Record<string, any>>} */
  #itemsById = new Map();
  /** @type {Record<string, any> | null} */
  #primaryItem = null;

  /**
   * @param {StructuredMetadata} structuredMetadata
   */
  constructor(structuredMetadata) {
    this.#metadata = structuredMetadata;
    for (const text of structuredMetadata.jsonLd) {
      let block;
      try {
        block = JSON.parse(text);
      } catch {
        continue;
      }
      this.#collect(block);
      this.#collectTopLevel(block);
    }
  }

  /**
   * Collects primaryItem candidates. Other nested items belong to another
   * item, like a site's SearchAction.
   *
   * @param {unknown} block
   */
  #collectTopLevel(block) {
    const isItem = value =>
      value && typeof value == "object" && value["@type"] !== undefined;
    for (const root of [block].flat()) {
      if (!root || typeof root != "object") {
        continue;
      }
      for (const item of [root].concat(root["@graph"] ?? [])) {
        if (!isItem(item)) {
          continue;
        }
        this.#topLevelItems.push(item);
        this.#topLevelItems.push(
          ...[].concat(item.mainEntity ?? []).filter(isItem)
        );
      }
    }
  }

  /**
   * Walks a JSON-LD block without recursion, as a page can nest it deeply.
   *
   * @param {unknown} block
   */
  #collect(block) {
    const pending = [block];
    while (pending.length) {
      const value = pending.pop();
      if (!value || typeof value != "object") {
        continue;
      }
      const children = Array.isArray(value)
        ? value
        : Object.keys(value)
            .filter(key => key != "@context")
            .map(key => value[key]);
      for (let i = children.length - 1; i >= 0; i--) {
        pending.push(children[i]);
      }
      if (Array.isArray(value)) {
        continue;
      }
      if (value["@type"] !== undefined) {
        this.#items.push(value);
      }
      const id = value["@id"];
      if (
        typeof id == "string" &&
        Object.keys(value).length > 1 &&
        !this.#itemsById.has(id)
      ) {
        this.#itemsById.set(id, value);
      }
    }
  }

  /**
   * Every typed JSON-LD item, nested ones included, in document order.
   *
   * @returns {Array<Record<string, any>>}
   */
  get items() {
    return this.#items;
  }

  /**
   * Schema.org subtypes are not inferred, so list the ones the feature
   * handles, e.g. findItems("Event", "MusicEvent", "SportsEvent").
   *
   * @param {...string} types - Schema.org type names.
   * @returns {Array<Record<string, any>>} Items of any of these types in
   *   document order, written as a term, a compact IRI or an IRI.
   */
  findItems(...types) {
    return this.#items.filter(item =>
      typesOf(item).some(type => types.includes(type))
    );
  }

  /**
   * A guess at the item the page is about, which a consumer that knows better
   * can assign. Title, description, image, author and dates follow it.
   *
   * @returns {Record<string, any> | null}
   */
  get primaryItem() {
    if (this.#primaryItem) {
      return this.#primaryItem;
    }
    const candidates = this.#topLevelItems.filter(
      item => !typesOf(item).some(type => SITE_LEVEL_TYPES.has(type))
    );
    const content = candidates.filter(
      item => !typesOf(item).every(isWebPageType)
    );
    return (
      content.find(item => item.mainEntityOfPage != null) ??
      content[0] ??
      candidates[0] ??
      null
    );
  }

  /** @param {Record<string, any> | null} item */
  set primaryItem(item) {
    this.#primaryItem = item;
  }

  /**
   * @param {any} value - A property value.
   * @returns {any} The item a `{ "@id" }` reference points to, or the value
   *   itself when it is not a reference to an item on the page.
   */
  resolve(value) {
    if (
      value &&
      typeof value == "object" &&
      typeof value["@id"] == "string" &&
      Object.keys(value).length == 1
    ) {
      return this.#itemsById.get(value["@id"]) ?? value;
    }
    return value;
  }

  /**
   * @param {string} name - A lowercased meta name or property.
   * @returns {string[]} Its values in document order.
   */
  metaValues(name) {
    return this.#metadata.metaTags
      .filter(tag => tag.name == name)
      .map(tag => tag.value);
  }

  /** @returns {string | null} */
  get title() {
    const item = this.primaryItem;
    return firstText(
      item?.headline,
      item?.name,
      this.#meta("og:title"),
      this.#meta("twitter:title"),
      this.#metadata.title
    );
  }

  /** @returns {string | null} */
  get description() {
    return firstText(
      this.primaryItem?.description,
      this.#meta("og:description"),
      this.#meta("twitter:description"),
      this.#meta("description")
    );
  }

  /** @returns {string | null} An absolute http(s) URL. */
  get image() {
    return this.#firstUrl(
      this.primaryItem?.image,
      this.#meta("og:image"),
      this.#meta("twitter:image"),
      this.#meta("twitter:image:src")
    );
  }

  /** @returns {string | null} The author names, comma separated. */
  get author() {
    return firstText(
      this.#names(this.primaryItem?.author),
      this.#meta("author")
    );
  }

  /** @returns {string | null} As the page wrote it, usually ISO 8601. */
  get publishedTime() {
    return firstText(
      this.primaryItem?.datePublished,
      this.#meta("article:published_time")
    );
  }

  /** @returns {string | null} As the page wrote it, usually ISO 8601. */
  get modifiedTime() {
    return firstText(
      this.primaryItem?.dateModified,
      this.#meta("article:modified_time"),
      this.#meta("og:updated_time")
    );
  }

  /** @returns {string | null} */
  get siteName() {
    return firstText(
      this.#meta("og:site_name"),
      this.#names(this.primaryItem?.publisher),
      this.#names(this.findItems("WebSite")[0])
    );
  }

  /** @returns {string | null} An absolute http(s) URL. */
  get canonicalUrl() {
    return this.#firstUrl(
      this.#metadata.canonicalUrl,
      this.#meta("og:url"),
      this.primaryItem?.url
    );
  }

  /** @returns {string | null} A language tag, e.g. "en-US". */
  get language() {
    return firstText(this.#metadata.language, this.primaryItem?.inLanguage);
  }

  /**
   * @param {string} name
   * @returns {string | undefined}
   */
  #meta(name) {
    return this.metaValues(name)[0];
  }

  /**
   * @param {any} value - A name, an item with a name, or a list of either.
   * @returns {string | null}
   */
  #names(value) {
    const names = [value]
      .flat()
      .map(entry => {
        const resolved = this.resolve(entry);
        return firstText(
          typeof resolved == "object" ? resolved?.name : resolved
        );
      })
      .filter(Boolean);
    return names.length ? names.join(", ") : null;
  }

  /**
   * @param {...any} candidates - URLs, items with a url or contentUrl, or
   *   lists of either, in order of preference.
   * @returns {string | null}
   */
  #firstUrl(...candidates) {
    for (const candidate of candidates) {
      for (const entry of [candidate].flat()) {
        const resolved = this.resolve(entry);
        const text = firstText(
          typeof resolved == "object"
            ? (resolved?.url ?? resolved?.contentUrl)
            : resolved
        );
        const url = text && URL.parse(text, this.#metadata.url || undefined);
        if (url && (url.protocol == "https:" || url.protocol == "http:")) {
          return url.href;
        }
      }
    }
    return null;
  }
}

/**
 * @param {...any} candidates - In order of preference.
 * @returns {string | null} The first candidate that is a non-blank string or
 *   a number, trimmed. A list counts as its first entry.
 */
function firstText(...candidates) {
  for (const candidate of candidates) {
    const value = Array.isArray(candidate) ? candidate[0] : candidate;
    if (typeof value == "number") {
      return String(value);
    }
    if (typeof value == "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}
