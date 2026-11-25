# valid-log-module

Ensures the `logModule` passed to `console.createInstance`
is a string literal that `MOZ_LOG` can parse.

A module name:

- may only contain ASCII letters, digits, `_`, `-` and `.`;
- may not start with a digit;
- may not be the name of a `MOZ_LOG` option, such as `sync`.

`console.createInstance` must be called with an object literal, so that the
parameters can be checked by ESLint.

## Examples of incorrect code for this rule

```js
console.createInstance({ logModule: "ML:OpenAIPipeline" });
console.createInstance({ logModule: `LoginHelper.${processName}` });
console.createInstance({ logModule: name });
console.createInstance(consoleOptions);
console.createInstance({ ...consoleOptions, prefix: name });
console.createInstance({ [key]: name });
```

## Examples of correct code for this rule

```js
console.createInstance({ logModule: "LoginStorage" });
console.createInstance({ logModule: "Sqlite", prefix: `Connection ${identifier}` });
console.createInstance({ logModule: "URLBar", prefix: `MerinoClient [${name}]` });
```
