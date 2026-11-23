"use strict";

globalThis.wasmProbe = function () {
  if (typeof WebAssembly === "undefined") {
    return "unavailable";
  }
  try {
    const bytes = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
    new WebAssembly.Instance(new WebAssembly.Module(bytes));
    return "instantiated";
  } catch (e) {
    return e.name;
  }
};
