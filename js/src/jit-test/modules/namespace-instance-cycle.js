import * as ns from "namespace-instance-cycle.wasm";

export function fn() {}

export let earlyError = null;
try {
  WebAssembly.namespaceInstance(ns);
} catch (e) {
  earlyError = e;
}
