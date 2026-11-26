// |jit-test| module; skip-if: !wasmIsSupported() || getBuildConfiguration("release_or_beta"); --enable-wasm-esm-integration

// WebAssembly.namespaceInstance returns the WebAssembly.Instance backing a
// Wasm module namespace, and throws a TypeError for anything else.

import * as ns from "exports-mutable-global.wasm";
import * as jsNs from "empty.js";
// Importing the Wasm module first makes its JS dependency execute before it.
import * as cycleNs from "namespace-instance-cycle.wasm";
import { earlyError } from "namespace-instance-cycle.js";

load(libdir + "asserts.js");

const instance = WebAssembly.namespaceInstance(ns);
assertEq(instance instanceof WebAssembly.Instance, true);
assertEq(WebAssembly.namespaceInstance(ns), instance);
assertEq(WebAssembly.namespaceInstance(await import("exports-mutable-global.wasm")), instance);

// The namespace and the instance share state.
assertEq(instance.exports.g.value, 1);
ns.set(42);
assertEq(instance.exports.g.value, 42);
instance.exports.set(43);
assertEq(ns.g, 43);

for (const value of [undefined, null, 42, "ns", {}, [], function () {}, instance,
                     instance.exports, jsNs]) {
  assertThrowsInstanceOf(() => WebAssembly.namespaceInstance(value), TypeError);
}
assertThrowsInstanceOf(() => WebAssembly.namespaceInstance(), TypeError);

// Before the Wasm module has executed there is no instance to return, see
// https://github.com/WebAssembly/esm-integration/pull/132.
assertEq(earlyError instanceof TypeError, true);
assertEq(earlyError.message, "WebAssembly module has not been instantiated");

const cycleInstance = WebAssembly.namespaceInstance(cycleNs);
assertEq(cycleInstance instanceof WebAssembly.Instance, true);
assertEq(cycleInstance !== instance, true);
assertEq(cycleInstance.exports.fn, cycleNs.fn);

// A namespace from another compartment is unwrapped, and the instance is
// wrapped for the caller.
const g = newGlobal({newCompartment: true});
assertEq(g.WebAssembly.namespaceInstance(ns), instance);
