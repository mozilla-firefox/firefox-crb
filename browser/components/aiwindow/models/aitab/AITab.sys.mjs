/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** @import { ChatConversation } from "moz-src:///browser/components/aiwindow/ui/modules/ChatConversation.sys.mjs" */
/** @import { Conversation } from "moz-src:///browser/components/aiwindow/models/Conversation.sys.mjs" */
/** @import { A2UISurface, ValidationEnv } from "moz-src:///browser/components/aiwindow/models/aitab/AITabValidation.sys.mjs" */
/** @import { AITabSource } from "moz-src:///browser/components/aiwindow/models/aitab/AITabSources.sys.mjs" */

import { isSmartPageURL } from "chrome://browser/content/aiwindow/modules/TrustedInternalURLs.mjs";
import { XPCOMUtils } from "resource://gre/modules/XPCOMUtils.sys.mjs";
import { UrlTokenizer } from "moz-src:///browser/components/aiwindow/ui/modules/UrlTokenizer.sys.mjs";
import { sanitizeUntrustedContent } from "moz-src:///browser/components/aiwindow/models/ChatUtils.sys.mjs";
import {
  AITabSources,
  CANCELED_RESULT,
  MAX_AITAB_CONTEXT_TABS,
  PAGE_BREAK,
} from "moz-src:///browser/components/aiwindow/models/aitab/AITabSources.sys.mjs";
import {
  AITabSurface,
  linkKey,
} from "moz-src:///browser/components/aiwindow/models/aitab/AITabSurface.sys.mjs";
import { AITabValidation } from "moz-src:///browser/components/aiwindow/models/aitab/AITabValidation.sys.mjs";
import {
  DEFAULT_AITAB_PAGE_TYPE,
  getAITabPageType,
} from "moz-src:///browser/components/aiwindow/ui/modules/AITabPageTypes.sys.mjs";

const lazy = XPCOMUtils.declareLazy({
  A2UI: "moz-src:///browser/components/aiwindow/ui/modules/A2UI.sys.mjs",
  AIWindow:
    "moz-src:///browser/components/aiwindow/ui/modules/AIWindow.sys.mjs",
  AuthProvider:
    "moz-src:///browser/components/aiwindow/models/AuthProvider.sys.mjs",
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  buildConversation:
    "moz-src:///browser/components/aiwindow/models/PromptLoader.sys.mjs",
  buildEngineForFeature:
    "moz-src:///browser/components/aiwindow/models/PromptLoader.sys.mjs",
  isAllowedURLProtocol:
    "moz-src:///browser/components/aiwindow/models/SecurityProperties.sys.mjs",
  loadPrompt:
    "moz-src:///browser/components/aiwindow/models/PromptLoader.sys.mjs",
  MODEL_FEATURES: "moz-src:///browser/components/aiwindow/models/Utils.sys.mjs",
  renderPrompt: "moz-src:///browser/components/aiwindow/models/Utils.sys.mjs",
  PlacesUtils: "resource://gre/modules/PlacesUtils.sys.mjs",
  console: () =>
    console.createInstance({
      logModule: "AITab",
      maxLogLevelPref: "browser.smartwindow.conversation.logLevel",
    }),
  l10n: () => new Localization(["preview/aiWindow.ftl"], true),
});

// Heading for the `modifyInstructions` section. A modification continues the
// conversation that produced the page, so this marks which turn's surface the
// instructions apply to: the one the model wrote last.
const MODIFY_CONTENT_HEADING =
  "## Instructions for modifications from previous response";

// Cap on each free-text parameter the model fills in (`focus` and
// `modifyInstructions`). Both re-enter the generation prompt, and nothing the
// model is told bounds how much it writes into them.
const MAX_INSTRUCTION_CHARS = 1500;

// Ceiling on the generation history handed to the model. A modification only
// ever adds to that history — the surface it wrote, plus the turn asking for
// the next change — and past roughly this much the output degrades, so the
// request is refused rather than answered badly.
const MAX_HISTORY_CHARS = 100000;

// The viewer page for AITab pages. The `page` query string parameter names the
// slug the page data is loaded from.
const AITAB_VIEWER_BASE = "about:smartpage?page=";

const HISTORY_LIMIT_ERROR = "No more modifications are supported";

/**
 * How a surface came to be: what was asked for, and what it was built from.
 *
 * @typedef {object} AITabContext
 * @property {string} creationPrompt - The user's focus, or "" when none was given.
 * @property {AITabSource[]} urlsUsed - The source pages, in the order requested.
 * @property {object[]} relevantMemories - Memories that informed the page.
 */

/**
 * Metadata derived from a validated surface, for the caller to persist or
 * display. Not sent to the viewer, which only receives the surface.
 *
 * @typedef {object} AITabMetadata
 * @property {string} id - Slug of `title` (see `#slugify`), or the slug being
 *   revised when this generation modified an existing page.
 * @property {string} [convId] - Id of the chat that owns the page being
 *   revised, which keeps it whichever chat asked for the revision. Absent for
 *   a new page, which belongs to the chat that asked for it.
 * @property {number} pageType - One of AITAB_PAGE_TYPES: the type asked
 *   for, or the type of the page being revised.
 * @property {string} toolConvId - Id of the conversation the surface was
 *   composed in, in the ConversationStore. Stored alongside the page so a
 *   later modification can continue that exchange, and so deleting the page
 *   can clear it.
 * @property {string} title - The surface's Header title, falling back to the
 *   user's focus, the single source page's title, then a localized default.
 * @property {string} howCreated - How the page was generated.
 * @property {AITabContext} context - What the page was generated from.
 */

/**
 * The result of a generation attempt: metadata plus the validated surface, or
 * a description of what went wrong and its canonical error code (the one
 * reported to telemetry).
 *
 * @typedef {{metadata: AITabMetadata, surface: A2UISurface} | {error: string, code: string}} AITabResult
 */

/**
 * The aitab prompt set: a conversation wired to the aitab model, and the two
 * prompt templates to render into it.
 *
 * @typedef {object} PromptSet
 * @property {Conversation} conversation - Conversation wired to the aitab
 *   model: the one being continued, or a fresh one.
 * @property {string} system - System-instructions template, taking `{schemas}`.
 * @property {string} user - User-data template, taking `{focus}` and `{pageContent}`.
 */

/**
 * The AITab generation service. Everything is static: the class holds no
 * per-instance state and is never constructed.
 *
 * Private helpers are referenced as `AITab.#name` rather than `this.#name` so
 * the public methods keep working when callers destructure them off the class.
 */
export class AITab {
  /**
   * Build the viewer URL for a stored page. The page data stays in the
   * database and is loaded from the slug, so nothing about the page travels
   * in the URL.
   *
   * @param {string} slug - The persisted page's slug.
   * @returns {string}
   */
  static buildViewerURL(slug) {
    return `${AITAB_VIEWER_BASE}${slug}`;
  }

  /**
   * Selects up to MAX_AITAB_CONTEXT_TABS unique context urls (http, https
   * or a smartpage) to build an AITab. Prioritizes candidate urls from
   * open tabs (sorted by lastAccessed), followed by the remaining
   * candidates as urls/mentions from the chat conversation.
   *
   * @param {string[]} candidateUrls - Candidate context urls.
   * @returns {string[]}
   */
  static selectContextUrls(candidateUrls) {
    if (!Array.isArray(candidateUrls)) {
      return [];
    }
    const candidates = new Set(
      candidateUrls.filter(
        url => lazy.isAllowedURLProtocol(url) || isSmartPageURL(URL.parse(url))
      )
    );
    const openTabUrls = new Set(
      lazy.BrowserWindowTracker.orderedWindows
        .filter(win => !win.closed && lazy.AIWindow.isAIWindowActive(win))
        .flatMap(win => win.gBrowser.tabs)
        .filter(tab => candidates.has(tab.linkedBrowser.currentURI.spec))
        .sort((a, b) => b.lastAccessed - a.lastAccessed)
        .map(tab => tab.linkedBrowser.currentURI.spec)
    );
    return Array.from(openTabUrls.union(candidates)).slice(
      0,
      MAX_AITAB_CONTEXT_TABS
    );
  }

  /**
   * Generate an AITab from a list of URLs, content handed over inline, or both.
   * Each URL's readable content is pulled via get_page_content, then an LLM
   * composes a structured A2UI surface that is validated against the packaged
   * catalog. The validated surface and its derived metadata are returned to the
   * caller — nothing is persisted and no HTML is assembled here (rendering
   * happens in about:smartpage). If generation fails, an `error` string
   * describing the problem is returned instead.
   *
   * `modifySlug` revises a stored page instead of writing a new one: the
   * conversation that composed that page is loaded and continued, so the model
   * edits the surface it already wrote rather than being handed it back as
   * source content. Only a page belonging to `conversation` can be revised.
   *
   * @param {object} options
   * @param {string[]} [options.urlList] - The URLs to include, already expanded
   *   from URL tokens by the tool dispatcher. Trims at MAX_AITAB_URLS urls.
   * @param {string} [options.focus] - What the user wants the page to focus
   *   on. Cut to MAX_INSTRUCTION_CHARS.
   * @param {string} [options.rawContent] - Content supplied inline rather than
   *   fetched, appended to the source text as its own PAGE_BREAK section.
   *   Shares the source-text budget with the pages.
   * @param {string} [options.modifySlug] - Slug of the stored page to revise.
   * @param {string} [options.modifyInstructions] - What to change about it.
   *   Cut to MAX_INSTRUCTION_CHARS.
   * @param {number} [options.pageType] - One of AITAB_PAGE_TYPES, for a new
   *   page. A revision keeps the type of the page it revises.
   * @param {string} [options.howInitiated] - How the generation was requested,
   *   for telemetry: tab_list, tab_group, fxms, chat, chat_followup or
   *   refresh.
   * @param {AbortSignal} [options.signal] - Cancels the generation. Checked at
   *   every await boundary here and in #generateStructuredSurface, and passed to
   *   the page extractions so they can be torn down early.
   * @param {ChatConversation} conversation
   * @returns {Promise<AITabResult>} The derived metadata and validated
   *   surface, or an error description.
   */
  static async generateAITab(
    {
      urlList,
      focus = "",
      rawContent,
      modifySlug,
      modifyInstructions,
      pageType = DEFAULT_AITAB_PAGE_TYPE,
      howInitiated = "chat",
      signal,
    } = {},
    conversation
  ) {
    if (!getAITabPageType(pageType)) {
      throw new Error(
        `generateAITab() called with unknown page type ${pageType}`
      );
    }

    const urls = Array.isArray(urlList)
      ? urlList
          .filter(url => typeof url == "string")
          .slice(0, MAX_AITAB_CONTEXT_TABS)
      : [];
    const rawText = typeof rawContent == "string" ? rawContent.trim() : "";
    const slug = typeof modifySlug == "string" ? modifySlug.trim() : "";

    const initiateExtra = {
      num_tabs: urls.length,
      how_initiated: howInitiated,
      raw_content_len: typeof rawContent == "string" ? rawContent.length : 0,
    };
    if (slug) {
      Glean.smartWindow.aitabEditInitiate.record(initiateExtra);
    } else {
      Glean.smartWindow.aitabCreateInitiate.record({
        ...initiateExtra,
        num_tabs_total_attempted: Array.isArray(urlList) ? urlList.length : 0,
      });
    }

    const startTime = ChromeUtils.now();
    const stats = { charsRead: 0, charsOut: 0 };
    const result = await AITab.#generate(
      {
        urls,
        rawText,
        slug,
        focus,
        modifyInstructions,
        pageType,
        signal,
        stats,
      },
      conversation
    );

    const completeExtra = {
      is_success: !result.error,
      components_used: result.surface
        ? AITabSurface.componentsUsed(result.surface)
        : "[]",
      components_converted: JSON.stringify(
        result.surface ? new lazy.A2UI(result.surface).conversions() : []
      ),
      num_chars_read: stats.charsRead,
      num_chars_out: stats.charsOut,
      seconds_elapsed: Math.round((ChromeUtils.now() - startTime) / 1000),
    };
    if (result.error) {
      completeExtra.error = result.code;
    }
    if (slug) {
      Glean.smartWindow.aitabEditComplete.record(completeExtra);
    } else {
      Glean.smartWindow.aitabCreateComplete.record(completeExtra);
    }

    return result.error ? { error: result.error, code: result.code } : result;
  }

  /**
   * The body of generateAITab, with its options already normalized.
   *
   * @param {object} options
   * @param {string[]} options.urls
   * @param {string} options.rawText
   * @param {string} options.slug - Slug of the page to revise, or "".
   * @param {string} options.focus
   * @param {string} [options.modifyInstructions]
   * @param {number} options.pageType - The type for a new page; ignored for a
   *   revision.
   * @param {AbortSignal} [options.signal]
   * @param {{charsRead: number, charsOut: number}} options.stats - Filled in
   *   with the characters sent to and received from the model.
   * @param {ChatConversation} conversation
   * @returns {Promise<AITabResult|{error: string, code: string}>} On failure,
   *   `code` is the canonical error code reported to telemetry.
   */
  static async #generate(
    { urls, rawText, slug, focus, modifyInstructions, pageType, signal, stats },
    conversation
  ) {
    // A modification already has a page to work from, so it needs no material
    // of its own; anything else has to bring something to build one out of.
    if (!urls.length && !rawText && !slug) {
      return {
        error: "no URLs or content were provided to build a page from",
        code: "no_content",
      };
    }

    if (signal?.aborted) {
      return CANCELED_RESULT;
    }

    // Resolved before any content is fetched: a slug that names no page of
    // this conversation's is the model's mistake to correct, not work to pay
    // for.
    let prior = null;
    if (slug) {
      prior = await AITabSources.loadPageToModify(slug, conversation);
      if (prior.error) {
        return prior;
      }

      if (signal?.aborted) {
        return CANCELED_RESULT;
      }
    }

    const effectivePageType = prior ? prior.page.pageType : pageType;
    const sources = await AITabSources.collectSources({
      urls,
      rawText,
      sourceTextBudget: getAITabPageType(effectivePageType).sourceTextBudget,
      conversation,
      signal,
    });

    if (sources.error) {
      return sources;
    }
    const { urlsUsed, readUrls, sourceText } = sources;

    const focusText = AITab.#capped(focus);

    // Compose the surface with the LLM. Modification instructions only mean
    // something alongside the conversation they revise, so they are dropped
    // when there is no page to modify. With no new sources to carry it, the
    // focus is the only place a modification's request can be, so it stands in
    // for missing instructions.
    let instructions = "";
    if (prior) {
      instructions =
        AITab.#capped(modifyInstructions) || (sourceText ? "" : focusText);
    }
    const structured = await AITab.#generateStructuredSurface({
      sourceText,
      focus: focusText,
      modifyInstructions: instructions,
      priorConversation: prior?.conversation,
      allowedLinks: conversation?.securityProperties.untrustedInput
        ? AITab.#allowedLinks({ conversation, readUrls, prior })
        : null,
      signal,
      stats,
    });

    if (signal?.aborted) {
      return CANCELED_RESULT;
    }

    if (structured.error) {
      return structured;
    }

    // Every page in urlList was extracted into this conversation, so it holds
    // private data (a credentialed page load) and untrusted input (arbitrary
    // web content, possibly carrying a prompt injection). Security flags on
    // this tool conversation will be used when getPageContent is called on the
    // associated generated page: bug 2069128 propagates untrustedInput from
    // here to the chat conversation that reads it.
    const toolConversation = structured.conversation;
    toolConversation.securityProperties.setPrivateData();
    toolConversation.securityProperties.setUntrustedInput();
    toolConversation.securityProperties.commit();

    // Inherit the chat's URL ledgers, and nothing beyond them. Search result
    // URLs carry their own anonymous-fetch exemption, so they come across
    // separately rather than being folded in as ordinary seen URLs.
    toolConversation.addSeenUrls(conversation?.seenUrls ?? []);
    toolConversation.addSerpUrlsForAnonymousFetch(
      conversation?.serpUrlsForAnonymousFetch ?? []
    );

    // Awaited, not fired and forgotten: the stored page points back at this
    // row through its tool_conv_id, and a modification can only continue the
    // exchange once it has landed. A failure still yields a usable page, so it
    // is logged rather than failing the generation.
    toolConversation.updatedDate = Date.now();
    await toolConversation
      .save()
      .catch(error =>
        lazy.console.error(`Could not save tool conversation: ${error}`)
      );

    // Fill in link-item favicons from Places, before the surface is linked or
    // stored.
    await AITab.#hydrateFavicons(structured.surface, signal);

    if (signal?.aborted) {
      return CANCELED_RESULT;
    }

    const title =
      AITabSurface.titleFromSurface(structured.surface) ||
      // A revision that comes back untitled keeps the title it had, which is
      // more specific than anything this turn could fall back to.
      prior?.page.title ||
      focusText ||
      (urls.length === 1 && urlsUsed[0].title) ||
      lazy.l10n.formatValueSync("ai-tab-default-page-title");

    /** @type {AITabMetadata} */
    const metadata = {
      id: prior ? prior.page.slug : AITab.#slugify(title),
      convId: prior?.page.convId,
      pageType: effectivePageType,
      toolConvId: toolConversation.id,
      title,
      howCreated: "chat",
      context: {
        creationPrompt: prior?.page.context?.creationPrompt || focusText,
        // A revision keeps the sources the page was already built from: the
        // turn that asked for it may have brought no URLs of its own.
        urlsUsed: AITabSources.mergeSources(
          prior?.page.context?.urlsUsed,
          urlsUsed
        ),
        relevantMemories: [],
      },
    };

    return { metadata, surface: structured.surface };
  }

  /**
   * The URLs a generated page may link to: those the chat has seen, its
   * search results and @mentions, the pages read for this turn, and, for a
   * revision, the links already on the page.
   *
   * @param {object} options
   * @param {ChatConversation} options.conversation - The chat asking for the
   *   page.
   * @param {string[]} options.readUrls - Pages read for this turn.
   * @param {{page: object, conversation: Conversation}|null} options.prior -
   *   The page being revised, from AITabSources.loadPageToModify.
   * @returns {Set<string>} Normalized URLs (see linkKey).
   */
  static #allowedLinks({ conversation, readUrls, prior }) {
    const urls = [
      ...(conversation?.seenUrls ?? []),
      ...(conversation?.serpUrlsForAnonymousFetch ?? []),
      ...(conversation?.getAllMentionURLs() ?? []),
      ...readUrls,
      ...AITabSurface.linkedUrls(prior?.page.components?.surface),
    ];
    return new Set(urls.map(linkKey).filter(Boolean));
  }

  /**
   * A model-supplied free-text parameter, trimmed and cut to
   * MAX_INSTRUCTION_CHARS.
   *
   * @param {*} text - The parameter as the model sent it, which is not
   *   guaranteed to be a string.
   * @returns {string}
   */
  static #capped(text) {
    return typeof text == "string"
      ? text.trim().slice(0, MAX_INSTRUCTION_CHARS)
      : "";
  }

  /**
   * Make the browser the only source of link-item favicons: on the surface's
   * SourceLink items (the SourceLinks component, Header.references, and each
   * Highlights item's `sources`) and Card items, drop whatever the model put
   * in `favicon` — the catalog accepts the property, so instructing the model
   * to leave it out is no guarantee — and fill it from the favicons Places
   * has stored. Mutates `surface` in place; best-effort — an item keeps no
   * `favicon` when Places has none or the lookup fails.
   *
   * Places only has favicons for sites the user has visited, so these images
   * automatically count as seen URLs and are not subject to security
   * restrictions.
   *
   * @param {A2UISurface} surface
   * @param {AbortSignal} [signal] - Stops the remaining Places lookups (the
   *   caller re-checks it and discards the surface).
   */
  static async #hydrateFavicons(surface, signal) {
    const dataModel = surface?.dataModel ?? {};
    const itemsOf = value => {
      let items = value;
      if (AITabValidation.isBinding(value)) {
        // resolvePath needs an absolute pointer, and validation skips
        // relative (template-scope) paths, so those must not resolve here
        // either. The resolved array is the same object the serialized
        // surface carries, so mutating its items reaches the output.
        items = value.path.startsWith("/")
          ? AITabValidation.resolvePath(dataModel, value.path)
          : undefined;
      }
      return Array.isArray(items) ? items : [];
    };

    const linkItems = [];
    for (const component of surface?.components ?? []) {
      switch (component?.component) {
        case "SourceLinks":
        case "Cards":
          linkItems.push(...itemsOf(component.items));
          break;
        case "Header":
          linkItems.push(...itemsOf(component.references?.items));
          break;
        case "Highlights":
          for (const item of itemsOf(component.items)) {
            linkItems.push(...itemsOf(item?.sources?.items));
          }
          break;
      }
    }

    // One Places lookup per unique href; sources typically repeat across the
    // header references and per-highlight sources.
    const faviconByHref = new Map();
    for (const item of linkItems) {
      if (!item || typeof item != "object") {
        continue;
      }
      delete item.favicon;
      if (typeof item.href != "string" || signal?.aborted) {
        continue;
      }
      if (!faviconByHref.has(item.href)) {
        faviconByHref.set(item.href, await AITab.#getFaviconURL(item.href));
      }
      const favicon = faviconByHref.get(item.href);
      if (favicon) {
        item.favicon = favicon;
      }
    }
  }

  /**
   * The page-icon: URL for a page whose favicon Places has stored. Never
   * rejects; returns "" when no favicon is stored for the page or the lookup
   * fails.
   *
   * @param {string} url
   * @returns {Promise<string>}
   */
  static async #getFaviconURL(url) {
    try {
      const favicon = await lazy.PlacesUtils.favicons.getFaviconForPage(
        Services.io.newURI(url)
      );
      return favicon ? `page-icon:${url}` : "";
    } catch (e) {
      lazy.console.debug("getFaviconURL failed", url, e);
      return "";
    }
  }

  /**
   * The conversation's messages as they are sent to the model. They are stored
   * with full URLs, as chat messages are, and tokenized here under one
   * tokenizer, so a continued conversation's earlier turns share the token map
   * the reply is expanded with.
   *
   * @param {Conversation} conversation
   * @param {UrlTokenizer} urlTokenizer - The tokenizer for this request.
   * @returns {object[]} Messages in the chat-completions format.
   */
  static #tokenizedMessages(conversation, urlTokenizer) {
    return conversation.getMessagesInChatCompletionsFormat().map(message => {
      if (message.role == "system" || typeof message.content != "string") {
        return message;
      }
      const surface =
        message.role == "assistant"
          ? AITabSurface.parsePageConfig(message.content)
          : null;
      const content = surface
        ? JSON.stringify(
            AITabSurface.tokenizeSurfaceUrls(surface, urlTokenizer)
          )
        : urlTokenizer.tokenizeText(message.content);
      return { ...message, content };
    });
  }

  /**
   * Ask the model for a validated surface for the given source content, either
   * in a conversation of its own or as the next turn of `priorConversation`.
   * Returns the validated surface and the conversation that produced it on
   * success, or an object with an `error` string describing why generation
   * failed.
   *
   * @param {object} options Options, as detailed in the Tool specification for AITab
   * @param {string} [options.focus] Focus of page information.
   * @param {string} options.sourceText Page content separated by PAGE_BREAK_TOKEN
   * @param {string} [options.modifyInstructions] What to change about the
   *   surface `priorConversation` already produced.
   * @param {Conversation} [options.priorConversation] The conversation to
   *   continue; a fresh one is built when there is none.
   * @param {Set<string>|null} options.allowedLinks URLs the surface may link
   *   to, as expandSurfaceUrlTokens takes them.
   * @param {AbortSignal} [options.signal] - Cancels the generation.
   * @param {{charsRead: number, charsOut: number}} options.stats - Filled in
   *   with the characters sent to and received from the model.
   * @returns {Promise<{surface: A2UISurface, conversation: Conversation}
   *   | {error: string}>}
   */
  static async #generateStructuredSurface({
    sourceText,
    focus,
    modifyInstructions,
    priorConversation,
    allowedLinks,
    signal,
    stats,
  }) {
    try {
      const { env } = await AITabValidation.loadAssets();

      const { conversation, system, user } =
        await AITab.#resolvePromptSet(priorConversation);
      // An upsert at index 0, so a continued conversation is re-pointed at
      // today's catalog rather than the one it was first generated against.
      conversation.setSystemMessage(
        lazy.renderPrompt(system, { schemas: AITab.#schemaText(env) })
      );

      // A modification can arrive with nothing new to read. Rendering the
      // source-content template around an empty body would read as "the
      // sources are gone", so it is left out and only the instructions go in.
      const userParts = [];
      let charsRead = modifyInstructions?.length ?? 0;
      if (sourceText) {
        charsRead += sourceText.length + (focus?.length ?? 0);
        userParts.push(
          lazy.renderPrompt(user, {
            focus: focus ?? "",
            pageContent: sourceText,
          })
        );
      }
      if (modifyInstructions) {
        userParts.push(`${MODIFY_CONTENT_HEADING}\n\n${modifyInstructions}`);
      }
      if (!userParts.length) {
        return {
          error: "nothing was provided to change the page with",
          code: "nothing_to_change",
        };
      }
      conversation.addUserMessage(userParts.join(PAGE_BREAK));

      // URLs only reach the model as tokens, so any link it emits can be traced
      // back to a URL it was actually given.
      const urlTokenizer = new UrlTokenizer();
      const args = AITab.#tokenizedMessages(conversation, urlTokenizer);

      // Measured on the wire format, so this is the payload run() sends rather
      // than an estimate of it. Only a continued conversation can reach the
      // ceiling: a first generation is one capped turn against a fixed system
      // message.
      if (priorConversation) {
        const history = JSON.stringify(args);
        if (history.length > MAX_HISTORY_CHARS) {
          lazy.console.warn(
            `refusing to modify: history is ${history.length} chars`
          );
          return { error: HISTORY_LIMIT_ERROR, code: "history_limit" };
        }
      }

      if (signal?.aborted) {
        return CANCELED_RESULT;
      }

      stats.charsRead = charsRead;
      // An AbortSignal cannot be structured-cloned to the engine actor.
      // We pass it between functions in the calling process to identify
      // when it's aborted. When that happens, the engine sends a
      // cancellation message with a request ID so the backend
      // aborts the HTTP request to the model.
      const response = await conversation.run({
        args,
        token: await lazy.AuthProvider.getToken(),
        signal,
      });

      if (signal?.aborted) {
        return CANCELED_RESULT;
      }

      const text = response?.finalOutput?.trim();
      stats.charsOut = text?.length ?? 0;
      lazy.console.debug(
        `model returned ${text?.length || 0} chars`,
        text ? text.slice(0, 500) : response
      );
      if (!text) {
        return {
          error: "the model returned an empty response",
          code: "empty_response",
        };
      }

      const parsed = AITabSurface.parsePageConfig(text);
      if (!parsed) {
        lazy.console.error("model did not return valid JSON:", text);
        return {
          error: "the model did not return valid JSON",
          code: "invalid_json",
        };
      }

      if (parsed.error && typeof parsed.error == "string") {
        lazy.console.warn("Model returned response error", parsed.error);
        return {
          error: sanitizeUntrustedContent(parsed.error),
          code: "content_related",
        };
      }

      const surface = AITabSurface.repairValidations(
        AITabSurface.expandSurfaceUrlTokens(parsed, urlTokenizer, allowedLinks)
      );

      const result = AITabValidation.buildSurface(surface, env);
      if (!result.ok) {
        lazy.console.error("surface failed validation", result.errors, surface);
        return {
          error: "the generated page did not match the required format",
          code: "invalid_format",
        };
      }

      // Record what the model wrote, with its URLs expanded as the user turn's
      // are. `run()` does not add its own reply, and a later modification
      // continues this conversation to revise this surface, so without this
      // there would be nothing there to revise.
      conversation.addAssistantMessage(JSON.stringify(result.surface));

      lazy.console.debug("structured surface validated successfully");
      return { surface: result.surface, conversation };
    } catch (error) {
      if (signal?.aborted) {
        return CANCELED_RESULT;
      }
      lazy.console.error("structured generation failed", error);
      return {
        error: `page generation failed: ${error?.message ?? error}`,
        code: "generation_failed",
      };
    }
  }

  /**
   * Load the aitab prompt templates and engine from Remote Settings. The
   * "ai-window-prompts" collection ships a packaged dump
   * (services/settings/dumps/main/ai-window-prompts.json), so the records are
   * always available — offline and on first run — without an in-tree fallback.
   * A genuine failure propagates and is surfaced as a generation error by the
   * caller.
   *
   * @param {Conversation} [existing] - Conversation to render the templates
   *   into, for a modification, which gets an aitab engine attached; a fresh
   *   one is built when there is none.
   * @returns {Promise<PromptSet>}
   */
  static async #resolvePromptSet(existing) {
    let conversation = existing;
    if (conversation) {
      const { engine, parameters } = await lazy.buildEngineForFeature(
        lazy.MODEL_FEATURES.AITAB
      );
      conversation.engine = engine;
      conversation.parameters = parameters;
    } else {
      conversation = await lazy.buildConversation(lazy.MODEL_FEATURES.AITAB);
    }
    const [{ prompt: system }, { prompt: user }] = await Promise.all([
      lazy.loadPrompt(lazy.MODEL_FEATURES.AITAB, {
        module: "system-instructions",
      }),
      lazy.loadPrompt(lazy.MODEL_FEATURES.AITAB, { module: "user-data" }),
    ]);
    return { conversation, system, user };
  }

  /**
   * Serialize the catalog for a prompt's `{schemas}` placeholder: the shared
   * `$defs` once up front (the component schemas reference them), then each
   * component's property schema. Compact (no indentation). The natural-language
   * assembly rules live in the Remote Settings system-instructions prompt, not
   * here — this method injects catalog data only.
   *
   * @param {ValidationEnv} env
   * @returns {string}
   */
  static #schemaText(env) {
    const { catalog, names } = env;
    const parts = [];
    if (catalog.$defs) {
      parts.push(`=== $defs (shared) ===\n${JSON.stringify(catalog.$defs)}`);
    }
    for (const name of names) {
      parts.push(
        `=== ${name} ===\n${JSON.stringify(catalog.components[name])}`
      );
    }
    return parts.join("\n\n");
  }

  /**
   * Turn a title into a lowercase kebab-case slug.
   *
   * @param {string} title
   * @returns {string}
   */
  static #slugify(title) {
    const slug = title
      .slice(0, 60)
      .toLowerCase()
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    // A title with no ASCII alphanumerics at all (e.g. one written in Japanese)
    // slugs to the empty string, which is not a usable identifier.
    return slug || "aitab";
  }
}
