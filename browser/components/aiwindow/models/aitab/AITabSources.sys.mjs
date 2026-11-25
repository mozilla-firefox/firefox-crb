/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** @import { ChatConversation } from "moz-src:///browser/components/aiwindow/ui/modules/ChatConversation.sys.mjs" */
/** @import { Conversation } from "moz-src:///browser/components/aiwindow/models/Conversation.sys.mjs" */

import { XPCOMUtils } from "resource://gre/modules/XPCOMUtils.sys.mjs";
import {
  URL_REGEX,
  UrlTokenizer,
} from "moz-src:///browser/components/aiwindow/ui/modules/UrlTokenizer.sys.mjs";
import { getSmartPageName } from "chrome://browser/content/aiwindow/modules/TrustedInternalURLs.mjs";
import { isAITabPageEditable } from "moz-src:///browser/components/aiwindow/ui/modules/AITabPageTypes.sys.mjs";

const lazy = XPCOMUtils.declareLazy({
  AITabStore:
    "moz-src:///browser/components/aiwindow/ui/modules/AITabStore.sys.mjs",
  ConversationStore:
    "moz-src:///browser/components/aiwindow/ui/modules/ConversationStore.sys.mjs",
  GetPageContent: "moz-src:///browser/components/aiwindow/models/Tools.sys.mjs",
  PlacesUtils: "resource://gre/modules/PlacesUtils.sys.mjs",
  console: () =>
    console.createInstance({
      logModule: "AITab",
      maxLogLevelPref: "browser.smartwindow.conversation.logLevel",
    }),
});

// Separator inserted between each page's text in the model prompt.
export const PAGE_BREAK = "\n\n<----- PAGE BREAK ---->\n\n";

export const MAX_AITAB_CONTEXT_TABS = 10;

// Heading for the `rawContent` section, so the model can tell content handed to
// it directly apart from text extracted from a fetched page.
const RAW_CONTENT_HEADING = "## Provided content (not fetched from a URL)";

const PAGE_NOT_EDITABLE_ERROR = "This page cannot be modified";

export const CANCELED_RESULT = Object.freeze({
  error: "page generation was canceled",
  code: "canceled",
});

/**
 * One source page a surface was generated from, in the order requested.
 *
 * @typedef {object} AITabSource
 * @property {string} url - The page the content was pulled from.
 * @property {string} title - The open tab's label, falling back to the URL.
 * @property {string} favIconUrl - A `page-icon:` URL for `url`.
 * @property {string|null} imageUrl - Cached og:image, or null when there is none.
 * @property {string} extractedText - Untruncated readable page text.
 */

/**
 * The material an AITab page is built from: which URLs to read, their text
 * shared out within the prompt budget, and the stored page a modification
 * revises. Everything is static.
 *
 * Private helpers are referenced as `AITabSources.#name` rather than
 * `this.#name` so the public methods keep working when callers destructure
 * them off the class.
 */
export class AITabSources {
  /**
   * The longest prefix of `text` that fits in `budget` once its URLs are
   * tokenized. Never ends inside a URL, which would hand the model a token
   * for a URL that doesn't exist.
   *
   * @param {string} text
   * @param {number} budget
   * @returns {string}
   */
  static #truncateToBudget(text, budget) {
    // Measures token lengths only. The prompt is tokenized separately, so
    // nothing registered here can resolve a link in the model's output.
    const urlTokenizer = new UrlTokenizer();
    let length = 0;
    let end = 0;
    for (const match of text.matchAll(URL_REGEX)) {
      const gap = match.index - end;
      if (length + gap >= budget) {
        break;
      }
      length += gap + urlTokenizer.tokenizeText(match[0]).length;
      if (length > budget) {
        return text.slice(0, match.index);
      }
      end = match.index + match[0].length;
    }
    return text.slice(0, end + Math.max(0, budget - length));
  }

  /**
   * The length of `text` once its URLs are tokenized, which is the length the
   * source-text budget is measured in.
   *
   * @param {string} text
   * @returns {number}
   */
  static #tokenizedLength(text) {
    // Measures token lengths only, as in #truncateToBudget.
    return new UrlTokenizer().tokenizeText(text).length;
  }

  /**
   * Share `budget` among sections of the given lengths. A section shorter
   * than an even share keeps all of its text, and what it leaves over is
   * shared among the longer ones, so a short or unreadable page doesn't hold
   * budget that a long page is cut for.
   *
   * @param {number[]} lengths - Each section's length, in the order the
   *   sections are sent.
   * @param {number} budget
   * @returns {number[]} Each section's share, in the same order.
   */
  static shareBudget(lengths, budget) {
    const shares = new Array(lengths.length).fill(0);
    const shortestFirst = lengths
      .map((_, index) => index)
      .sort((a, b) => lengths[a] - lengths[b]);
    let remaining = budget;
    for (const [position, index] of shortestFirst.entries()) {
      const evenShare = Math.floor(
        remaining / (shortestFirst.length - position)
      );
      shares[index] = Math.min(lengths[index], evenShare);
      remaining -= shares[index];
    }
    return shares;
  }

  /**
   * Read the material a surface is composed from: the readable text of each
   * requested URL, plus any content handed over inline, laid out as the
   * prompt's source sections and separated by PAGE_BREAK.
   *
   * @param {object} options
   * @param {string[]} options.urls - URLs to read, in the requested order.
   * @param {string} options.rawText - Content supplied inline, or "".
   * @param {number} options.sourceTextBudget - Total characters of source
   *   text, measured after URL tokenization since URLs only reach the model as
   *   tokens.
   * @param {ChatConversation} options.conversation - Gates each URL's access
   *   check, so a page the chat may not read contributes nothing.
   * @param {AbortSignal} [options.signal] - Cancels the extractions.
   * @returns {Promise<{urlsUsed: AITabSource[], readUrls: string[],
   *   sourceText: string}|{error: string}>} The sources in the order
   *   requested, the URLs among them that could be read, and the text for the
   *   prompt, or a description of why there is nothing to build from.
   */
  static async collectSources({
    urls,
    rawText,
    sourceTextBudget,
    conversation,
    signal,
  }) {
    // Pull the readable content for each requested URL (order-aligned with
    // urls). Structured results, so a refusal is distinguishable from page
    // text rather than being composed into the page as if it were content.
    let contents = [];
    if (urls.length) {
      contents = await lazy.GetPageContent.getPageContent(
        { url_list: urls, signal },
        conversation
      );

      if (signal?.aborted) {
        return CANCELED_RESULT;
      }

      // Nothing readable and no inline content: report it instead of
      // generating a page whose only source material is the refusal. A
      // partial read, or inline content alongside unreadable pages, still
      // generates from what is there.
      if (!rawText && !contents.some(result => result.ok)) {
        return {
          error: "none of the requested pages could be read",
          code: "pages_unreadable",
        };
      }
    }

    // Share the source-text budget among the sections the prompt will carry —
    // one per requested tab, plus one for inline content — so the model prompt
    // stays bounded no matter how many tabs are included. A modification can
    // bring neither, in which case there is nothing to budget.
    const texts = urls.map((url, index) => contents[index]?.content ?? "");
    const budgets = AITabSources.shareBudget(
      [...texts, ...(rawText ? [rawText] : [])].map(text =>
        AITabSources.#tokenizedLength(text)
      ),
      sourceTextBudget
    );

    /** @type {AITabSource[]} */
    const urlsUsed = [];
    const sourceParts = [];
    for (const [index, url] of urls.entries()) {
      // Prefer the open tab's title for the heading; fall back to the URL.
      const tab = lazy.GetPageContent.getTabWithURL(url);
      const heading = tab?.label || url;
      const text = texts[index];
      // Best-effort og:image lookup ("" when none cached), gated on the same
      // access-control decision as the page text so a refused URL leaks no
      // image either.
      const imageUrl = lazy.GetPageContent.isContentAllowed(url, conversation)
        ? await AITabSources.#getPageImage(url)
        : "";
      urlsUsed.push({
        url,
        title: heading,
        favIconUrl: `page-icon:${url}`,
        imageUrl: imageUrl || null,
        extractedText: text,
      });

      // Trim each page's text to its share of the budget before sending to the
      // model.
      const budgetedText = AITabSources.#truncateToBudget(text, budgets[index]);
      const headLines = [`## ${heading}`, `URL: ${url}`];
      // Omit the Image: line when absent so the model never echoes an empty
      // value.
      if (imageUrl) {
        headLines.push(`Image: ${imageUrl}`);
      }
      sourceParts.push(`${headLines.join("\n")}\n\n${budgetedText}`);
    }

    if (signal?.aborted) {
      return CANCELED_RESULT;
    }

    if (rawText) {
      sourceParts.push(
        `${RAW_CONTENT_HEADING}\n\n${AITabSources.#truncateToBudget(rawText, budgets.at(-1))}`
      );
    }

    return {
      urlsUsed,
      readUrls: urls.filter((url, index) => contents[index]?.ok),
      sourceText: sourceParts.join(PAGE_BREAK),
    };
  }

  /**
   * Load the stored page a modification names, along with the conversation that
   * composed it. The stored conversation carries its messages, URL ledgers and
   * security flags but no engine; AITab attaches one.
   *
   * Only a page belonging to `conversation`, or one the user referenced in it
   * (the current tab or an @mention), can be loaded: slugs are visible in page
   * URLs, so without that check a model could be talked into rewriting a page
   * from an unrelated chat. URLs the conversation merely came across, such as
   * open tabs or links in fetched pages, do not count. Keying the lookup on
   * the chat conversation would also file the new version under the wrong
   * slug.
   *
   * @param {string} slug
   * @param {ChatConversation} conversation - The chat asking for the revision.
   * @returns {Promise<{page: object, conversation: Conversation}
   *   |{error: string}>}
   */
  static async loadPageToModify(slug, conversation) {
    let page;
    let priorConversation;
    try {
      page = await lazy.AITabStore.getBySlug(slug);
      if (page?.toolConvId) {
        priorConversation = await lazy.ConversationStore.findConversationById(
          page.toolConvId
        );
      }
    } catch (error) {
      lazy.console.error("could not load the page to modify", slug, error);
      return {
        error: `the page "${slug}" could not be loaded`,
        code: "page_load_failed",
      };
    }

    const referencedByUser = [
      ...(conversation?.getAllMentionURLs() ?? []),
    ].some(url => getSmartPageName(URL.parse(url)) === slug);
    if (!page || (page.convId !== conversation?.id && !referencedByUser)) {
      return {
        error: `this conversation has no page with the slug "${slug}"`,
        code: "page_not_found",
      };
    }

    if (!isAITabPageEditable(page.pageType)) {
      return {
        error: PAGE_NOT_EDITABLE_ERROR,
        code: "page_not_editable",
      };
    }

    // The surface to revise lives in that conversation's assistant message, so
    // without the exchange there is nothing to modify — regenerating is the
    // only way forward.
    if (!priorConversation?.messageCount) {
      return {
        error:
          `the conversation that generated "${slug}" is no longer available, ` +
          `so it can only be generated again from scratch`,
        code: "conversation_unavailable",
      };
    }

    return { page, conversation: priorConversation };
  }

  /**
   * The source list for a revised page: everything it was already built from,
   * then whatever this turn added, deduplicated by URL so a page re-read on a
   * later turn is listed once, with its newest extraction.
   *
   * @param {AITabSource[]} [previous] - Sources from the stored page.
   * @param {AITabSource[]} added - Sources read on this turn.
   * @returns {AITabSource[]}
   */
  static mergeSources(previous, added) {
    if (!Array.isArray(previous) || !previous.length) {
      return added;
    }
    const byUrl = new Map(previous.map(source => [source?.url, source]));
    for (const source of added) {
      byUrl.set(source.url, source);
    }
    return Array.from(byUrl.values());
  }

  /**
   * Look up a page's preview-image (og:image) URL from Places. Never rejects;
   * returns "" on failure or when none is cached.
   *
   * @param {string} url
   * @returns {Promise<string>}
   */
  static async #getPageImage(url) {
    try {
      const pageInfo = await lazy.PlacesUtils.history
        .fetch(url, { includeMeta: true })
        .catch(() => null);
      // previewImageURL is a URL object when the page cached an og:image.
      return pageInfo?.previewImageURL ? pageInfo.previewImageURL.href : "";
    } catch (e) {
      lazy.console.debug("getPageImage failed", url, e);
      return "";
    }
  }
}
