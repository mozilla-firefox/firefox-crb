/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

import rule from "../lib/rules/valid-log-module.mjs";
import { RuleTester } from "eslint";

const ruleTester = new RuleTester();

function invalidLogModule(name) {
  return [{ messageId: "invalidLogModule", data: { name } }];
}

const logModuleNotLiteral = [{ messageId: "logModuleNotLiteral" }];

const optionsNotLiteral = [{ messageId: "optionsNotLiteral" }];

const spreadInOptions = [{ messageId: "spreadInOptions" }];

const computedKeyInOptions = [{ messageId: "computedKeyInOptions" }];

ruleTester.run("valid-log-module", rule, {
  valid: [
    'console.createInstance({ logModule: "Foo" });',
    'console.createInstance({ logModule: "URLBar.MerinoClient.amp" });',
    'console.createInstance({ logModule: "devtools_rdp-2" });',
    'console.createInstance({ "logModule": "Foo" });',
    'lazy.console.createInstance({ logModule: "Foo" });',
    'console.createInstance({ logModule: "Foo", prefix: "Foo bar" });',
    'console.createInstance({ logModule: "Foo", prefix: `Foo (${name})` });',
    'console.createInstance({ logModule: "Foo", prefix: name });',
    'console.createInstance({ prefix: "Foo bar" });',
    "console.createInstance({ prefix: name });",
    "console.createInstance({ maxLogLevel: 'Warn' });",
    "console.createInstance();",
    "Cc[contractID].createInstance(Ci.nsIFoo);",
    "logger.createInstance({ logModule: name });",
    "logger.createInstance({ prefix: name });",
    'console.createInstance({ logModule: "LoginHelper.Main", maxLogLevelPref: "signon.loglevel" });',
  ],
  invalid: [
    {
      code: 'console.createInstance({ logModule: "Login storage" });',
      errors: invalidLogModule("Login storage"),
    },
    {
      code: 'console.createInstance({ logModule: "ML:OpenAIPipeline", prefix: "ML:OpenAIPipeline" });',
      errors: invalidLogModule("ML:OpenAIPipeline"),
    },
    {
      code: 'console.createInstance({ logModule: "LoginHelper(Main)" });',
      errors: invalidLogModule("LoginHelper(Main)"),
    },
    {
      code: 'console.createInstance({ logModule: "Foo*" });',
      errors: invalidLogModule("Foo*"),
    },
    {
      code: 'console.createInstance({ logModule: "2Foo" });',
      errors: invalidLogModule("2Foo"),
    },
    {
      code: 'console.createInstance({ logModule: "sync" });',
      errors: invalidLogModule("sync"),
    },
    {
      code: 'console.createInstance({ logModule: "" });',
      errors: invalidLogModule(""),
    },
    {
      code: 'globalThis.console.createInstance({ logModule: "Foo Bar" });',
      errors: invalidLogModule("Foo Bar"),
    },
    {
      code: 'console.createInstance({ logModule: "crate::module" });',
      errors: invalidLogModule("crate::module"),
    },
    {
      code: 'console.createInstance({ logModule: "crate::module::*" });',
      errors: invalidLogModule("crate::module::*"),
    },
    {
      code: "console.createInstance({ logModule: `Foo` });",
      errors: logModuleNotLiteral,
    },
    {
      code: "console.createInstance({ logModule: name });",
      errors: logModuleNotLiteral,
    },
    {
      code: "console.createInstance({ logModule, prefix: 'Foo' });",
      errors: logModuleNotLiteral,
    },
    {
      code: "console.createInstance({ logModule: `Foo.${name}` });",
      errors: logModuleNotLiteral,
    },
    {
      code: 'console.createInstance({ logModule: "Foo." + name });',
      errors: logModuleNotLiteral,
    },
    {
      code: "console.createInstance({ logModule: `LoginHelper.${processName}` });",
      errors: logModuleNotLiteral,
    },
    {
      code: "console.createInstance({ ...options, prefix: name });",
      errors: spreadInOptions,
    },
    {
      code: 'console.createInstance({ logModule: "Foo", ...options });',
      errors: spreadInOptions,
    },
    {
      code: 'console.createInstance({ ["logModule"]: name });',
      errors: computedKeyInOptions,
    },
    {
      code: "console.createInstance({ [key]: name });",
      errors: computedKeyInOptions,
    },
    {
      code: 'console.createInstance({ logModule: "Foo", ["logModule"]: name });',
      errors: computedKeyInOptions,
    },
    {
      code: "console.createInstance(options);",
      errors: optionsNotLiteral,
    },
    {
      code: "lazy.console.createInstance(this.consoleOptions);",
      errors: optionsNotLiteral,
    },
    {
      code: "console.createInstance(getOptions());",
      errors: optionsNotLiteral,
    },
    {
      code: "console.createInstance(...args);",
      errors: optionsNotLiteral,
    },
  ],
});
