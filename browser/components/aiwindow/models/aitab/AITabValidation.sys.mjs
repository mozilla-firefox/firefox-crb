/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { XPCOMUtils } from "resource://gre/modules/XPCOMUtils.sys.mjs";

const lazy = XPCOMUtils.declareLazy({
  JsonSchema: "resource://gre/modules/JsonSchema.sys.mjs",
  MODEL_FEATURES: "moz-src:///browser/components/aiwindow/models/Utils.sys.mjs",
  FEATURE_MAJOR_VERSIONS:
    "moz-src:///browser/components/aiwindow/models/Utils.sys.mjs",
  parseVersion: "moz-src:///browser/components/aiwindow/models/Utils.sys.mjs",
  console: () =>
    console.createInstance({
      logModule: "AITab",
      maxLogLevelPref: "browser.smartwindow.conversation.logLevel",
    }),
  // Dev override: when the pref holds a non-empty string, it is parsed as an
  // A2UICatalog instead of the packaged component_schema.json, so the catalog
  // can be iterated on without rebuilding.
  overrideCatalog: {
    pref: "browser.smartwindow.aitab.components",
    transform: prefValue => {
      const pref = prefValue.trim();
      if (!pref) {
        return null;
      }
      try {
        return JSON.parse(pref);
      } catch (e) {
        throw new Error(
          `failed to parse browser.smartwindow.aitab.components: ${e.message}`
        );
      }
    },
  },
});

// Packaged A2UI component catalog (see models/aitab/jar.mn). The service
// produces a validated surface only.
//
// component_schema.json is an A2UI-compatible *catalog*: a single JSON-Schema
// object with a `components` map (name -> property schema), shared `$defs`,
// and a `version` ("{major}.{minor}") paired with the aitab Remote Settings
// major (FEATURE_MAJOR_VERSIONS.aitab): the prompts published at that major
// describe this catalog. A catalog change that older prompts cannot describe
// (a new component, a new property on a component that forbids unknown ones)
// bumps the catalog major, FEATURE_MAJOR_VERSIONS.aitab, and the packaged
// dump's aitab records together, so two releases can be served side by side.
const COMPONENT_SCHEMA_URL =
  "chrome://browser/content/aiwindow/aitab/component_schema.json";
// The `component` type every surface's root must use.
const ROOT_COMPONENT = "Page";
// The id the single root component must carry.
export const ROOT_ID = "root";
// JSON Schema dialect the per-component validators declare.
const JSON_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";

/**
 * A JSON Schema object from the catalog: a component's property schema, one of
 * the shared `$defs`, or any subschema of those. Only the keywords the
 * validation walk itself inspects are listed here; every other JSON Schema
 * keyword may be present and is handled by the compiled validators.
 *
 * @typedef {object} A2UISchema
 * @property {string} [$ref] - Reference into the catalog's `$defs`, e.g. "#/$defs/DynamicString".
 * @property {string} [type] - JSON Schema type of the described value.
 * @property {A2UISchema[]} [oneOf] - Alternative shapes the value may take,
 *   e.g. a literal array or an `A2UIDataBinding` to one.
 * @property {Record<string, A2UISchema>} [properties] - Property name to its schema.
 * @property {A2UISchema} [items] - Schema each element of an array must satisfy.
 * @property {string[]} [required] - Names of the properties that must be present.
 */

/**
 * An A2UI component catalog: the packaged component_schema.json, or the object
 * held by the browser.smartwindow.aitab.components pref. A single JSON-Schema
 * document whose `components` map holds one property schema per component
 * type, all sharing the document's `$defs`.
 *
 * @typedef {object} A2UICatalog
 * @property {string} [version] - "{major}.{minor}"; the major is paired with
 *   FEATURE_MAJOR_VERSIONS.aitab. Required on the packaged catalog.
 * @property {Record<string, A2UISchema>} components - Component type name to its property schema.
 * @property {Record<string, A2UISchema>} [$defs] - Definitions the component schemas `$ref`.
 * @property {string} [catalogId] - Identifier of the catalog.
 * @property {string} [title] - Human-readable catalog name.
 * @property {string} [description] - What the catalog covers.
 */

/**
 * A surface: the generated page, as a flat list of component instances plus
 * the data model their bindings resolve against.
 *
 * @typedef {object} A2UISurface
 * @property {A2UIComponent[]} components - Every component instance, as a flat
 *   adjacency list: parent/child structure comes from the id references, not
 *   from this array's order.
 * @property {A2UIDataModel} [dataModel] - The data the components bind to.
 */

/**
 * One component instance in a surface. Alongside the two discriminators, a
 * component carries the catalog properties declared for its type (see
 * `#propsOf`), each either a literal or an `A2UIDataBinding`; `header` and
 * `children` are the two such properties this module reads directly.
 *
 * @typedef {object} A2UIComponent
 * @property {string} id - Unique within the surface; the root component's id is ROOT_ID.
 * @property {string} component - A component type name from the catalog.
 * @property {A2UIIdReference} [header] - Id of this component's header component.
 * @property {A2UIIdReference} [children] - Ids of this component's child components.
 */

/**
 * A component's catalog properties: a component instance minus its `id` and
 * `component` discriminators, which the per-component schemas don't declare.
 *
 * @typedef {Record<string, *>} A2UIComponentProps
 */

/**
 * A surface's data model: an arbitrary JSON tree that binding paths resolve
 * into. Keeps real content out of the component instances.
 *
 * @typedef {Record<string, *>} A2UIDataModel
 */

/**
 * A binding to a value in the data model. `path` is a JSON-Pointer (RFC 6901),
 * absolute from the data-model root when it starts with "/", otherwise
 * relative to the enclosing template scope.
 *
 * @typedef {object} A2UIDataBinding
 * @property {string} path - Pointer to the bound value.
 */

/**
 * A template repeater: instantiates the `componentId` component once per
 * element of the array bound at `path`.
 *
 * @typedef {object} A2UITemplateRef
 * @property {string} componentId - Id of the template component.
 * @property {string} path - Absolute JSON-Pointer to the array to repeat over.
 */

/**
 * Related components, always referenced by id and never inlined: a single id,
 * a fixed ordered list of ids, or a template repeater.
 *
 * @typedef {string|string[]|A2UITemplateRef} A2UIIdReference
 */

/**
 * A compiled JSON Schema validator: the part of a `JsonSchema.Validator`
 * instance this module uses.
 *
 * @typedef {object} SchemaValidator
 * @property {(instance: *) => {valid: boolean, errors: ValidationError[]}} validate -
 *   Validates one instance against the compiled schema, collecting every
 *   failure (the validators are built with shortCircuit off).
 */

/**
 * Everything needed to validate a surface against one catalog: the catalog
 * itself, its component type names in catalog order, and one compiled
 * validator per component type.
 *
 * @typedef {object} ValidationEnv
 * @property {A2UICatalog} catalog - The catalog the validators were built from.
 * @property {string[]} names - Component type names, in catalog order.
 * @property {Record<string, SchemaValidator>} validators - Component type name to its props validator.
 */

/**
 * A single validation failure. Errors raised by this module carry `message`
 * (plus `component` or `dataPath` when the failure is attributable to one);
 * errors coming out of a JsonSchema validator carry the JSON Schema
 * output-unit fields instead.
 *
 * @typedef {object} ValidationError
 * @property {string} [message] - Description, for errors raised by this module.
 * @property {string} [component] - Id of the offending component instance.
 * @property {string} [dataPath] - JSON-Pointer of the offending data-model value.
 * @property {string} [error] - Description, for errors from a JsonSchema validator.
 * @property {string} [keyword] - The JSON Schema keyword that failed.
 * @property {string} [keywordLocation] - Pointer to the failed keyword within the schema.
 * @property {string} [instanceLocation] - Pointer to the failing value within the validated instance.
 */

/**
 * The outcome of validating a surface: the surface itself when it is valid,
 * every collected failure otherwise.
 *
 * @typedef {{ok: true, surface: A2UISurface} | {ok: false, errors: ValidationError[]}} SurfaceResult
 */

/**
 * Loads the A2UI component catalog AITab pages are generated against and
 * validates surfaces with it. Everything is static.
 *
 * Private helpers are referenced as `AITabValidation.#name` rather than
 * `this.#name` so the public methods keep working when callers destructure
 * them off the class.
 */
export class AITabValidation {
  /** @type {Promise<A2UICatalog>|undefined} */
  static #packagedCatalogPromise;

  /**
   * Load the component catalog: from the browser.smartwindow.aitab.components
   * pref when it is set (see lazy.overrideCatalog), otherwise from the packaged
   * catalog. Returns a validation `env` built from it.
   *
   * @returns {Promise<{env: ValidationEnv}>}
   */
  static async loadAssets() {
    const override = lazy.overrideCatalog;
    const catalog = override ?? (await AITabValidation.#loadPackagedCatalog());
    // The packaged catalog must declare its version; a dev override may omit
    // it, but when it declares one it is held to the same pairing rule.
    AITabValidation.#checkCatalogVersion(catalog, {
      versionRequired: !override,
    });
    return { env: AITabValidation.#makeEnv(catalog) };
  }

  /**
   * Enforce the catalog/prompt pairing: the catalog's major must equal the
   * aitab major this build reads prompts for, or the prompt and the validator
   * would disagree on which components exist.
   *
   * @param {A2UICatalog} catalog
   * @param {object} options
   * @param {boolean} options.versionRequired - Reject a catalog with no `version`.
   * @throws {Error} with `clientReason` "catalogVersionMismatch".
   */
  static #checkCatalogVersion(catalog, { versionRequired }) {
    const expected = lazy.FEATURE_MAJOR_VERSIONS[lazy.MODEL_FEATURES.AITAB];
    if (catalog?.version == null && !versionRequired) {
      lazy.console.warn(
        `aitab catalog override has no version; assuming major ${expected}`
      );
      return;
    }
    const parsed = lazy.parseVersion(catalog?.version);
    if (!parsed || parsed.major !== expected) {
      const err = new Error(
        `aitab catalog version ${JSON.stringify(catalog?.version)} does not match this build's aitab major ${expected}`
      );
      err.clientReason = "catalogVersionMismatch";
      throw err;
    }
  }

  /**
   * Validate a surface against the catalog. A surface is a flat list of
   * component instances plus a data model; validation covers, in one pass:
   * the shape of the surface, that exactly one component is the `root` Page,
   * that every component's props match its catalog schema, that all id
   * references resolve, and that every absolute data binding resolves in the
   * data model.
   *
   * @param {A2UISurface} surface
   * @param {ValidationEnv} env
   * @returns {SurfaceResult}
   */
  static buildSurface(surface, env) {
    if (!env.validators) {
      return { ok: false, errors: [{ message: "no component catalog" }] };
    }
    const components = surface?.components;
    if (!Array.isArray(components)) {
      return {
        ok: false,
        errors: [{ message: "surface.components must be an array" }],
      };
    }
    const dataModel = surface.dataModel ?? {};
    const errors = [];

    // Structural: unique ids, exactly one root, root is a Page.
    const ids = components.map(c => c?.id);
    const idSet = new Set();
    for (const id of ids) {
      if (typeof id != "string" || !id) {
        errors.push({ message: "every component needs a string id" });
      } else if (idSet.has(id)) {
        errors.push({ message: `duplicate component id "${id}"` });
      } else {
        idSet.add(id);
      }
    }
    const roots = components.filter(c => c?.id === ROOT_ID);
    if (roots.length !== 1) {
      errors.push({
        message: `expected exactly one component with id "${ROOT_ID}", found ${roots.length}`,
      });
    } else if (roots[0].component !== ROOT_COMPONENT) {
      errors.push({
        message: `the "${ROOT_ID}" component must be a ${ROOT_COMPONENT}, got "${roots[0].component}"`,
      });
    }

    // Per-component: known type + props validate against catalog schema.
    for (const comp of components) {
      const validator = env.validators[comp?.component];
      if (!validator) {
        errors.push({
          message: `unknown component "${comp?.component}" (id "${comp?.id}")`,
        });
        continue;
      }
      const { valid, errors: propErrors } = validator.validate(
        AITabValidation.#propsOf(comp)
      );
      if (!valid) {
        for (const e of propErrors) {
          errors.push({ ...e, component: comp.id });
        }
      }
    }

    // Id-reference integrity: header/children (and template targets).
    for (const comp of components) {
      AITabValidation.#checkRefs(
        comp?.header,
        idSet,
        `${comp?.id}.header`,
        errors
      );
      AITabValidation.#checkRefs(
        comp?.children,
        idSet,
        `${comp?.id}.children`,
        errors
      );
    }

    // Binding integrity: absolute { path } bindings must resolve in dataModel.
    for (const comp of components) {
      if (!comp) {
        continue;
      }
      AITabValidation.#checkBindings(
        AITabValidation.#propsOf(comp),
        dataModel,
        comp.id,
        errors
      );
    }

    // Bound values live in the data model, which the per-component schema
    // can't reach. Validate bound objects and array items against the catalog.
    const itemCache = new Map();
    for (const comp of components) {
      const compSchema = comp && env.catalog.components[comp.component];
      if (!compSchema) {
        continue;
      }
      AITabValidation.#checkBoundArrays(
        compSchema,
        AITabValidation.#propsOf(comp),
        env.catalog,
        dataModel,
        comp.id,
        errors,
        itemCache
      );
    }

    const repeater = roots[0]?.children;
    if (
      repeater &&
      !Array.isArray(repeater) &&
      typeof repeater.path == "string" &&
      repeater.path.startsWith("/")
    ) {
      const template = components.find(
        comp => comp?.id === repeater.componentId
      );
      const schema = template && env.catalog.components[template.component];
      const scopes = AITabValidation.resolvePath(dataModel, repeater.path);
      if (schema && Array.isArray(scopes)) {
        for (const [index, scope] of scopes.entries()) {
          AITabValidation.#checkBoundArrays(
            schema,
            AITabValidation.#propsOf(template),
            env.catalog,
            dataModel,
            `${template.id}[${index}]`,
            errors,
            itemCache,
            scope
          );
        }
      }
    }

    if (errors.length) {
      return { ok: false, errors };
    }
    return { ok: true, surface };
  }

  /**
   * Fetch and cache the packaged catalog object from chrome://.
   *
   * @returns {Promise<A2UICatalog>}
   */
  static #loadPackagedCatalog() {
    if (!AITabValidation.#packagedCatalogPromise) {
      AITabValidation.#packagedCatalogPromise = fetch(COMPONENT_SCHEMA_URL)
        .then(r => r.json())
        .catch(error => {
          AITabValidation.#packagedCatalogPromise = undefined;
          throw error;
        });
    }
    return AITabValidation.#packagedCatalogPromise;
  }

  /**
   * Build a validation `env` from an A2UI catalog. Compiles one JsonSchema
   * validator per component type (each rooted at that component's property
   * schema, with the catalog's shared `$defs` inlined so `#/$defs/...` refs
   * resolve), and records the ordered component-name list.
   *
   * @param {A2UICatalog} catalog
   * @returns {ValidationEnv}
   */
  static #makeEnv(catalog) {
    if (!catalog || typeof catalog != "object" || !catalog.components) {
      throw new Error("aitab catalog must be an object with a components map");
    }
    const $defs = catalog.$defs ?? {};
    const names = Object.keys(catalog.components);
    const validators = {};
    for (const name of names) {
      // Each per-type doc carries the shared $defs so the component's internal
      // `#/$defs/...` references resolve. No $id: each validator is standalone
      // and there are no cross-document refs to resolve.
      const doc = {
        $schema: JSON_SCHEMA_DIALECT,
        $defs,
        ...catalog.components[name],
      };
      validators[name] = new lazy.JsonSchema.Validator(doc, {
        shortCircuit: false,
      });
    }
    return { catalog, names, validators };
  }

  /**
   * Push an error for every id reference in `value` that is not a known
   * component id. `value` may be a single id string, an array of id strings, or
   * a template `{ componentId, path }` object (children).
   *
   * @param {A2UIIdReference} value
   * @param {Set<string>} idSet
   * @param {string} where
   * @param {ValidationError[]} errors
   */
  static #checkRefs(value, idSet, where, errors) {
    if (value == null) {
      return;
    }
    if (typeof value == "string") {
      if (!idSet.has(value)) {
        errors.push({ message: `${where} references missing id "${value}"` });
      }
    } else if (Array.isArray(value)) {
      for (const v of value) {
        AITabValidation.#checkRefs(v, idSet, where, errors);
      }
    } else if (
      typeof value == "object" &&
      typeof value.componentId == "string"
    ) {
      if (!idSet.has(value.componentId)) {
        errors.push({
          message: `${where} template references missing id "${value.componentId}"`,
        });
      }
    }
  }

  /**
   * Walk a props object for binding objects `{ path }` and push an error for
   * every absolute path (starting with "/") that does not resolve in the data
   * model. Relative paths (template scope) are not checked here.
   *
   * @param {A2UIComponentProps|*} value - Props object, or any nested value
   *   reached while walking one.
   * @param {A2UIDataModel} dataModel
   * @param {string} where
   * @param {ValidationError[]} errors
   */
  static #checkBindings(value, dataModel, where, errors) {
    if (Array.isArray(value)) {
      for (const v of value) {
        AITabValidation.#checkBindings(v, dataModel, where, errors);
      }
      return;
    }
    if (!value || typeof value != "object") {
      return;
    }
    const keys = Object.keys(value);
    if (keys.length === 1 && typeof value.path == "string") {
      if (
        value.path.startsWith("/") &&
        AITabValidation.resolvePath(dataModel, value.path) === undefined
      ) {
        errors.push({
          message: `${where}: binding path "${value.path}" not found in dataModel`,
        });
      }
      return;
    }
    for (const v of Object.values(value)) {
      AITabValidation.#checkBindings(v, dataModel, where, errors);
    }
  }

  /**
   * A component instance's catalog properties: everything but the `id` and
   * `component` discriminators, which the per-component schemas don't declare.
   *
   * @param {A2UIComponent} comp
   * @returns {A2UIComponentProps}
   */
  static #propsOf(comp) {
    const props = { ...comp };
    delete props.id;
    delete props.component;
    return props;
  }

  /**
   * Resolve a JSON-Pointer (RFC 6901) into `root`. Returns the pointed-at value
   * (truthy check at the callsite treats `undefined` as "not found"; a present
   * value — including empty string/array — is considered resolved).
   *
   * @param {A2UIDataModel} root
   * @param {string} pointer - Absolute pointer starting with "/".
   * @returns {*}
   */
  static resolvePath(root, pointer) {
    let node = root;
    for (let seg of pointer.slice(1).split("/")) {
      if (node == null || typeof node != "object") {
        return undefined;
      }
      seg = seg.replace(/~1/g, "/").replace(/~0/g, "~");
      node = node[seg];
    }
    return node;
  }

  /**
   * True when `v` is an `A2UIDataBinding`: an object with just a string
   * `path`.
   *
   * @param {*} v
   * @returns {boolean}
   */
  static isBinding(v) {
    return (
      !!v &&
      typeof v == "object" &&
      !Array.isArray(v) &&
      typeof v.path == "string" &&
      Object.keys(v).length === 1
    );
  }

  /**
   * Resolve a schema that may be `{ $ref: "#/$defs/X", ...siblings }` to its target `$def`.
   *
   * @param {A2UISchema} schema - Schema that may be a `$ref` into the catalog.
   * @param {A2UICatalog} catalog - The catalog holding `$defs`.
   * @returns {A2UISchema} The resolved `$def`, or `schema` when it is not a `$ref`.
   */
  static #resolveDef(schema, catalog) {
    if (schema && typeof schema.$ref == "string") {
      const name = schema.$ref.replace(/^#\/\$defs\//, "");
      return catalog.$defs?.[name] ?? schema;
    }
    return schema;
  }

  /**
   * Compile + cache a validator for a bound object or array item schema
   * (with catalog `$defs` in scope).
   *
   * @param {A2UISchema} itemSchema - Schema each array element must satisfy.
   * @param {A2UICatalog} catalog - The catalog whose `$defs` the item schema may $ref.
   * @param {Map<string, SchemaValidator>} cache - Per-validation compiled-validator cache.
   * @returns {SchemaValidator} A JsonSchema validator for `itemSchema`.
   */
  static #itemValidator(itemSchema, catalog, cache) {
    return cache.getOrInsertComputed(
      JSON.stringify(itemSchema),
      () =>
        new lazy.JsonSchema.Validator(
          {
            $schema: JSON_SCHEMA_DIALECT,
            $defs: catalog.$defs ?? {},
            ...itemSchema,
          },
          { shortCircuit: false }
        )
    );
  }

  /**
   * Walk `value` against its catalog `schema`; wherever the schema is a
   * `oneOf` of [ array-of-items, DataBinding ] and the value is a `{ path }`
   * binding, resolve the array from the data model and validate each element
   * against the array's item schema. Recurses into object properties so nested
   * arrays (e.g. Header.references.items) are covered. Literal arrays are
   * already validated by the per-component validator, so they are skipped here.
   * Bound objects are validated against the literal object branch.
   * Relative bindings are validated when a repeater scope is provided.
   *
   * @param {A2UISchema} schema
   * @param {*} value
   * @param {A2UICatalog} catalog
   * @param {A2UIDataModel} dataModel
   * @param {string} where
   * @param {ValidationError[]} errors
   * @param {Map<string, SchemaValidator>} cache
   * @param {*} [scope] - Data for the current repeater item.
   */
  static #checkBoundArrays(
    schema,
    value,
    catalog,
    dataModel,
    where,
    errors,
    cache,
    scope = undefined
  ) {
    schema = AITabValidation.#resolveDef(schema, catalog);
    if (!schema || value == null) {
      return;
    }
    if (Array.isArray(schema.oneOf)) {
      const isBinding = AITabValidation.isBinding(value);
      const isAbsolute = isBinding && value.path.startsWith("/");
      if (scope !== undefined && isAbsolute) {
        return;
      }
      const canResolveBinding =
        isBinding && (isAbsolute || scope !== undefined);
      const boundValue = canResolveBinding
        ? AITabValidation.resolvePath(
            isAbsolute ? dataModel : scope,
            isAbsolute ? value.path : `/${value.path}`
          )
        : undefined;
      if (canResolveBinding && !isAbsolute && boundValue === undefined) {
        errors.push({
          message: `${where}: binding path "${value.path}" not found in repeater item`,
        });
        return;
      }
      const objectBranch = schema.oneOf.find(
        s =>
          s?.$ref !== "#/$defs/DataBinding" &&
          AITabValidation.#resolveDef(s, catalog)?.type === "object"
      );
      if (objectBranch && canResolveBinding) {
        if (boundValue !== undefined) {
          const validator = AITabValidation.#itemValidator(
            objectBranch,
            catalog,
            cache
          );
          const { valid, errors: objectErrors } =
            validator.validate(boundValue);
          if (!valid) {
            for (const error of objectErrors) {
              errors.push({ ...error, dataPath: value.path });
            }
          }
        }
        return;
      }
      const arrayBranch = schema.oneOf.find(
        s => s && s.type === "array" && s.items
      );
      if (arrayBranch && canResolveBinding) {
        const arr = boundValue;
        if (arr === undefined) {
          return; // missing path already reported by #checkBindings
        }
        if (!Array.isArray(arr)) {
          errors.push({
            message: `${where}: data at "${value.path}" must be an array`,
          });
          return;
        }
        const iv = AITabValidation.#itemValidator(
          arrayBranch.items,
          catalog,
          cache
        );
        arr.forEach((item, i) => {
          const { valid, errors: itemErrors } = iv.validate(item);
          if (!valid) {
            for (const e of itemErrors) {
              errors.push({ ...e, dataPath: `${value.path}/${i}` });
            }
          }
        });
      }
      return;
    }
    const props = schema.properties;
    if (props && typeof value == "object" && !Array.isArray(value)) {
      for (const [k, sub] of Object.entries(props)) {
        if (k in value) {
          AITabValidation.#checkBoundArrays(
            sub,
            value[k],
            catalog,
            dataModel,
            `${where}/${k}`,
            errors,
            cache,
            scope
          );
        }
      }
    }
  }
}
