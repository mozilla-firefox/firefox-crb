/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { XPCOMUtils } from "resource://gre/modules/XPCOMUtils.sys.mjs";
import {
  expandUrlTokens,
  stripUnresolvedUrlTokens,
} from "moz-src:///browser/components/aiwindow/ui/modules/UrlTokenizer.sys.mjs";
import { componentTypeName } from "chrome://browser/content/aiwindow/modules/AITabUtils.mjs";
import {
  AITabValidation,
  ROOT_ID,
} from "moz-src:///browser/components/aiwindow/models/aitab/AITabValidation.sys.mjs";

/**
 * @import { UrlTokenizer } from "moz-src:///browser/components/aiwindow/ui/modules/UrlTokenizer.sys.mjs"
 * @import { A2UISurface } from "moz-src:///browser/components/aiwindow/models/aitab/AITabValidation.sys.mjs"
 */

const lazy = XPCOMUtils.declareLazy({
  console: () =>
    console.createInstance({
      logModule: "AITab",
      maxLogLevelPref: "browser.smartwindow.conversation.logLevel",
    }),
});

// Surface properties the browser navigates to or loads. The model may only
// fill them with URL tokens it was given (see expandSurfaceUrlTokens).
const LINK_FIELDS = new Set(["href", "src"]);

/**
 * @param {string} url
 * @returns {string|null} The form URLs are compared in when checking a link
 *   against the ones a conversation has seen, or null when `url` is invalid.
 */
export function linkKey(url) {
  return URL.parse(String(url ?? ""))?.href ?? null;
}

// Nesting limit for walking model output in expandSurfaceUrlTokens. Surfaces
// are flat adjacency lists, so real ones stay far below this.
const MAX_EXPAND_RECURSION_DEPTH = 32;

/**
 * Parsing the A2UI surfaces the model writes for AITab pages, and moving
 * their URLs between full form and the tokens the model sees. Everything is
 * static.
 *
 * Private helpers are referenced as `AITabSurface.#name` rather than
 * `this.#name` so the public methods keep working when callers destructure
 * them off the class.
 */
export class AITabSurface {
  /**
   * The `href` values in a surface, including those in its data model.
   *
   * @param {any} value - A surface, or a value nested in one.
   * @param {number} [recursionDepth] - Nesting level of `value`; callers
   *   leave it unset.
   * @returns {string[]}
   */
  static linkedUrls(value, recursionDepth = 0) {
    if (
      !value ||
      typeof value != "object" ||
      recursionDepth > MAX_EXPAND_RECURSION_DEPTH
    ) {
      return [];
    }
    return Object.entries(value).flatMap(([key, sub]) =>
      key == "href" && typeof sub == "string"
        ? [sub]
        : AITabSurface.linkedUrls(sub, recursionDepth + 1)
    );
  }

  /**
   * The page title for metadata: the Header component's `title`, resolving a
   * `{ path }` binding against the surface's data model when needed.
   *
   * @param {A2UISurface} surface
   * @returns {string}
   */
  static titleFromSurface(surface) {
    const header = (surface?.components || []).find(
      c => c?.component === "Header"
    );
    const title = header?.title;
    if (typeof title == "string") {
      return title;
    }
    if (title && typeof title == "object" && typeof title.path == "string") {
      const value = title.path.startsWith("/")
        ? AITabValidation.resolvePath(surface.dataModel ?? {}, title.path)
        : undefined;
      return typeof value == "string" ? value : "";
    }
    return "";
  }

  /**
   * The component types a validated surface uses, for telemetry: a
   * JSON-encoded array in render order, walking from the root through each
   * component's header then children. A component carrying a `layout` is
   * listed as `component_layout`. These are the types that the model sent;
   * components_converted lists the ones that render as a different type.
   *
   * @param {A2UISurface} surface
   * @returns {string}
   */
  static componentsUsed(surface) {
    const byId = new Map(surface.components.map(c => [c.id, c]));
    const visited = new Set();
    const used = [];
    const visit = id => {
      const comp = byId.get(id);
      if (!comp || visited.has(id)) {
        return;
      }
      visited.add(id);
      used.push(componentTypeName(comp));
      for (const ref of [comp.header, comp.children].flat()) {
        visit(typeof ref == "string" ? ref : ref?.componentId);
      }
    };
    visit(ROOT_ID);
    return JSON.stringify(used);
  }

  /**
   * Extract a JSON object from the model's text output, tolerating markdown
   * code fences or surrounding prose.
   *
   * @param {string} text
   * @returns {A2UISurface|null} The candidate surface, not yet validated
   *   against the catalog.
   */
  static parsePageConfig(text) {
    // The outermost {...} span covers the common cases in two indexOf scans: a
    // bare object, an object inside a ```json fence, and an object wrapped in
    // unfenced prose (e.g. "Here is the page: {...} — let me know if...").
    const surface = AITabSurface.#parseJsonSpan(text);
    if (surface) {
      return surface;
    }
    // The span only misses when prose on either side of a fenced block has
    // braces of its own, so fall back to the region between the first pair of
    // fences. Any language tag is left in it, which is harmless:
    // #parseJsonSpan starts at "{".
    const open = text.indexOf("```");
    const close = open < 0 ? -1 : text.indexOf("```", open + 3);
    const fenced =
      close > open
        ? AITabSurface.#parseJsonSpan(text.slice(open + 3, close))
        : null;
    if (fenced) {
      return fenced;
    }
    lazy.console.error("failed to parse surface JSON", text);
    return null;
  }

  /**
   * Expand the URL tokens in a parsed model surface back into full URLs.
   * Tokens inside free text are expanded, or removed when hallucinated. Link
   * fields (see LINK_FIELDS) must hold exactly one known token; an object whose
   * `href` or `src` does not is dropped,
   * so a URL the model was never given can't become a link or image.
   *
   * When `allowedLinks` is given, an `href` must also be one of them.
   *
   * @param {any} value - A parsed surface, or a value nested in one.
   * @param {UrlTokenizer} urlTokenizer - The tokenizer used for the prompt.
   * @param {Set<string>|null} [allowedLinks] - Normalized URLs (see
   *   linkKey) an `href` may point to; an item linking anywhere else is
   *   dropped. Null allows any URL the prompt contained.
   * @param {number} [recursionDepth] - Nesting level of `value`; callers
   *   leave it unset.
   * @param {WeakMap<object, object>} [expandedObjects] - Original objects
   *   mapped to their filtered copies; callers leave it unset.
   * @returns {any} A detokenized copy, or undefined when `value` is dropped or
   *   nested deeper than MAX_EXPAND_RECURSION_DEPTH.
   */
  static expandSurfaceUrlTokens(
    value,
    urlTokenizer,
    allowedLinks = null,
    recursionDepth = 0,
    expandedObjects = new WeakMap()
  ) {
    if (typeof value == "string") {
      return stripUnresolvedUrlTokens(
        expandUrlTokens(value, urlTokenizer.tokenToUrl)
      );
    }
    if (recursionDepth > MAX_EXPAND_RECURSION_DEPTH) {
      return undefined;
    }
    if (Array.isArray(value)) {
      const result = value
        .map(item =>
          AITabSurface.expandSurfaceUrlTokens(
            item,
            urlTokenizer,
            allowedLinks,
            recursionDepth + 1,
            expandedObjects
          )
        )
        .filter(item => item !== undefined);
      expandedObjects.set(value, result);
      return result;
    }
    if (!value || typeof value != "object") {
      return value;
    }
    const result = {};
    for (const [key, sub] of Object.entries(value)) {
      if (LINK_FIELDS.has(key)) {
        const url = urlTokenizer.resolveExactToken(sub);
        if (
          key == "href" &&
          url &&
          allowedLinks &&
          !allowedLinks.has(linkKey(url))
        ) {
          lazy.console.warn("dropping item with unseen link", url);
          return undefined;
        }
        if (url) {
          result[key] = url;
        } else {
          lazy.console.warn("dropping item with unknown link", sub);
          return undefined;
        }
        continue;
      }
      const expanded = AITabSurface.expandSurfaceUrlTokens(
        sub,
        urlTokenizer,
        allowedLinks,
        recursionDepth + 1,
        expandedObjects
      );
      if (expanded !== undefined) {
        result[key] = expanded;
      }
    }

    expandedObjects.set(value, result);

    if (recursionDepth === 0 && Array.isArray(result.components)) {
      AITabSurface.#removeFilteredBindings(value, result, expandedObjects);
    }

    return result;
  }

  /**
   * Rewrite shapes models commonly emit that the catalog rejects but whose
   * meaning is unambiguous, so buildSurface can accept the page.
   *
   * @param {A2UISurface} surface - Modified in place.
   * @returns {A2UISurface} `surface`.
   */
  static repairValidations(surface) {
    return AITabSurface.inlineListGroupItems(surface);
  }

  /**
   * Replace each List group's `items` binding with a copy of the array it
   * points to, whether the groups are literal or bound into the data model.
   * Models carry the catalog's preference for bindings into ListGroup.items,
   * the one content array the catalog requires to be literal. A binding that
   * does not resolve to an array is left for validation to reject.
   *
   * @param {A2UISurface} surface - Modified in place.
   * @returns {A2UISurface} `surface`.
   */
  static inlineListGroupItems(surface) {
    const components = surface?.components;
    if (!Array.isArray(components)) {
      return surface;
    }
    const dataModel = surface.dataModel ?? {};
    for (const comp of components) {
      if (comp?.component != "List") {
        continue;
      }
      let groups = comp.groups;
      if (AITabValidation.isBinding(groups) && groups.path.startsWith("/")) {
        groups = AITabValidation.resolvePath(dataModel, groups.path);
      }
      if (!Array.isArray(groups)) {
        continue;
      }
      for (const group of groups) {
        const items = group?.items;
        if (!AITabValidation.isBinding(items) || !items.path.startsWith("/")) {
          continue;
        }
        const resolved = AITabValidation.resolvePath(dataModel, items.path);
        if (Array.isArray(resolved)) {
          lazy.console.warn(
            `inlining List "${comp.id}" group items bound to "${items.path}"`
          );
          group.items = structuredClone(resolved);
        }
      }
    }
    return surface;
  }

  /**
   * Remove bindings whose targets existed before filtering and disappeared
   * because they, or an ancestor object, contained an unresolved URL token
   * or a link outside the allowed set.
   *
   * @param {A2UISurface} original
   * @param {A2UISurface} surface - Filtered surface, updated in place.
   * @param {WeakMap<object, object>} expandedObjects
   */
  static #removeFilteredBindings(original, surface, expandedObjects) {
    surface.components = surface.components.map(
      component =>
        AITabSurface.#cleanFilteredBindings(
          component,
          original.dataModel,
          surface.dataModel
        ).value
    );

    const root = surface.components.find(
      component => component?.id === ROOT_ID
    );
    const repeater = root?.children;
    const hasAbsoluteRepeaterPath =
      repeater &&
      !Array.isArray(repeater) &&
      typeof repeater.path == "string" &&
      repeater.path.startsWith("/");

    if (!hasAbsoluteRepeaterPath) {
      return;
    }

    const template = surface.components.find(
      component => component?.id === repeater.componentId
    );
    const originalScopes = AITabValidation.resolvePath(
      original.dataModel,
      repeater.path
    );
    const filteredScopes = AITabValidation.resolvePath(
      surface.dataModel,
      repeater.path
    );
    const canCompareRepeaterScopes =
      template !== undefined &&
      Array.isArray(originalScopes) &&
      Array.isArray(filteredScopes);

    if (!canCompareRepeaterScopes) {
      return;
    }

    // Filtering can remove whole repeater items, so pair scopes by identity.
    const originalByFiltered = new Map(
      originalScopes.map(scope => [expandedObjects.get(scope) ?? scope, scope])
    );

    const cleanedInstances = filteredScopes.map((scope, index) =>
      AITabSurface.#cleanFilteredBindings(
        template,
        original.dataModel,
        surface.dataModel,
        {
          original: originalByFiltered.get(scope),
          filtered: scope,
          path: `${repeater.path}/${index}`,
        }
      )
    );
    const hasFilteredRelativeBindings = cleanedInstances.some(
      instance => instance.removedBinding
    );

    if (!hasFilteredRelativeBindings) {
      return;
    }

    AITabSurface.#replaceRepeaterWithInstances(
      surface,
      root,
      template,
      cleanedInstances.map(instance => instance.value)
    );
  }

  /**
   * Copy component properties, removing bindings whose targets were filtered.
   * Scoped relative bindings become absolute so each copy can stand alone.
   *
   * @param {*} value
   * @param {A2UIDataModel} originalDataModel
   * @param {A2UIDataModel} filteredDataModel
   * @param {{ original: *, filtered: *, path: string } | null} [scope]
   * @returns {{ value: *, removedBinding: boolean }}
   */
  static #cleanFilteredBindings(
    value,
    originalDataModel,
    filteredDataModel,
    scope = null
  ) {
    if (AITabValidation.isBinding(value)) {
      const absolute = value.path.startsWith("/");
      const canResolveBinding = absolute || scope !== null;

      if (!canResolveBinding) {
        return { value, removedBinding: false };
      }

      const path = absolute ? value.path : `/${value.path}`;
      const before = AITabValidation.resolvePath(
        absolute ? originalDataModel : scope.original,
        path
      );
      const after = AITabValidation.resolvePath(
        absolute ? filteredDataModel : scope.filtered,
        path
      );
      const targetWasFiltered = before !== undefined && after === undefined;

      if (targetWasFiltered) {
        return { value: undefined, removedBinding: true };
      }

      return {
        value: absolute ? value : { path: `${scope.path}/${value.path}` },
        removedBinding: false,
      };
    }

    const hasNestedProperties = value !== null && typeof value == "object";

    if (!hasNestedProperties) {
      return { value, removedBinding: false };
    }

    const entries = [];
    let removedBinding = false;

    for (const [key, sub] of Object.entries(value)) {
      const cleaned = AITabSurface.#cleanFilteredBindings(
        sub,
        originalDataModel,
        filteredDataModel,
        scope
      );

      removedBinding ||= cleaned.removedBinding;

      if (cleaned.value !== undefined) {
        entries.push([key, cleaned.value]);
      }
    }

    return {
      value: Array.isArray(value)
        ? entries.map(([, item]) => item)
        : Object.fromEntries(entries),
      removedBinding,
    };
  }

  /**
   * Replace a shared repeater template with independently bound components.
   *
   * @param {A2UISurface} surface
   * @param {A2UIComponent} root
   * @param {A2UIComponent} template
   * @param {A2UIComponent[]} instances
   */
  static #replaceRepeaterWithInstances(surface, root, template, instances) {
    const ids = new Set(surface.components.map(component => component?.id));

    for (const [index, instance] of instances.entries()) {
      if (index === 0) {
        continue;
      }

      let id = `${template.id}-${index}`;

      while (ids.has(id)) {
        id += "-";
      }

      ids.add(id);
      instance.id = id;
    }

    root.children = instances.map(instance => instance.id);
    surface.components = surface.components.flatMap(component =>
      component === template ? instances : [component]
    );
  }

  /**
   * The inverse of expandSurfaceUrlTokens: replace the URLs in a stored surface
   * with tokens, so a surface the model wrote on an earlier turn can be handed
   * back to it under this turn's tokenizer.
   *
   * @param {any} value - A surface, or a value nested in one.
   * @param {UrlTokenizer} urlTokenizer - The tokenizer for this request.
   * @param {number} [recursionDepth] - Nesting level of `value`; callers
   *   leave it unset.
   * @returns {any} A tokenized copy, or undefined when `value` is nested deeper
   *   than MAX_EXPAND_RECURSION_DEPTH.
   */
  static tokenizeSurfaceUrls(value, urlTokenizer, recursionDepth = 0) {
    if (typeof value == "string") {
      return urlTokenizer.tokenizeText(value);
    }
    if (recursionDepth > MAX_EXPAND_RECURSION_DEPTH) {
      return undefined;
    }
    if (Array.isArray(value)) {
      return value
        .map(item =>
          AITabSurface.tokenizeSurfaceUrls(
            item,
            urlTokenizer,
            recursionDepth + 1
          )
        )
        .filter(item => item !== undefined);
    }
    if (!value || typeof value != "object") {
      return value;
    }
    const result = {};
    for (const [key, sub] of Object.entries(value)) {
      const tokenized =
        LINK_FIELDS.has(key) && typeof sub == "string"
          ? urlTokenizer.formatToken(sub)
          : AITabSurface.tokenizeSurfaceUrls(
              sub,
              urlTokenizer,
              recursionDepth + 1
            );
      if (tokenized !== undefined) {
        result[key] = tokenized;
      }
    }
    return result;
  }

  /**
   * Parse the span from the first "{" to the last "}" of `text` as JSON, or
   * null when there is no such span or it does not parse.
   *
   * @param {string} text
   * @returns {A2UISurface|null}
   */
  static #parseJsonSpan(text) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) {
      return null;
    }
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}
