/**
 * @file Ensure the logModule of a console created with console.createInstance
 * is a string literal that MOZ_LOG can parse.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import helpers from "../helpers.mjs";

// Keep in sync with NSPRLogModulesParser, in xpcom/base/NSPRLogModulesParser.cpp.
const MODULE_NAME = /^[A-Za-z_.-][A-Za-z0-9_.-]*$/;

// Keep in sync with LogModuleManager::Init, in xpcom/base/Logging.cpp.
const OPTION_NAMES = new Set([
  "append",
  "timestamp",
  "sync",
  "raw",
  "rotate",
  "maxsize",
  "prependheader",
  "profilerstacks",
  "jsstacks",
]);

function isValidModuleName(name) {
  return MODULE_NAME.test(name) && !OPTION_NAMES.has(name);
}

function getStringLiteralValue(node) {
  if (node.type == "Literal" && typeof node.value == "string") {
    return node.value;
  }
  return null;
}

export default {
  meta: {
    docs: {
      url: "https://firefox-source-docs.mozilla.org/code-quality/lint/linters/eslint-plugin-mozilla/rules/valid-log-module.html",
    },
    messages: {
      spreadInOptions:
        "Do not spread an object into the options of console.createInstance: write its logModule in the call, so that it can be checked.",
      computedKeyInOptions:
        "Do not use a computed key in the options of console.createInstance: write the keys plainly, so that the logModule can be checked.",
      optionsNotLiteral:
        "Write the options of console.createInstance as an object literal in the call, so that its logModule can be checked.",
      logModuleNotLiteral:
        "Use a string literal as the logModule of the console, and give the parts known at run time in its prefix.",
      invalidLogModule:
        'MOZ_LOG cannot configure the "{{name}}" module: use only ASCII letters, digits, "_", "-" and ".", do not start with a digit, and do not use the name of a MOZ_LOG option such as "sync".',
    },
    schema: [],
    type: "problem",
  },

  create(context) {
    return {
      CallExpression(node) {
        if (!helpers.isConsoleCreateInstanceCall(node)) {
          return;
        }

        let [options] = node.arguments;
        // Without options, the console logs to the "console" module.
        if (!options) {
          return;
        }
        if (options.type != "ObjectExpression") {
          context.report({ node: options, messageId: "optionsNotLiteral" });
          return;
        }

        let spread = options.properties.find(
          property => property.type == "SpreadElement"
        );
        if (spread) {
          context.report({ node: spread, messageId: "spreadInOptions" });
          return;
        }

        let computed = options.properties.find(property => property.computed);
        if (computed) {
          context.report({ node: computed, messageId: "computedKeyInOptions" });
          return;
        }

        // A duplicated logModule is reported by no-dupe-keys.
        let logModule = options.properties.find(
          property => (property.key.name ?? property.key.value) == "logModule"
        )?.value;
        if (!logModule) {
          return;
        }

        let value = getStringLiteralValue(logModule);
        if (value === null) {
          context.report({ node: logModule, messageId: "logModuleNotLiteral" });
        } else if (!isValidModuleName(value)) {
          context.report({
            node: logModule,
            messageId: "invalidLogModule",
            data: { name: value },
          });
        }
      },
    };
  },
};
