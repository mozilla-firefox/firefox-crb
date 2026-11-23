import "./file_wasm_exempted_domains_probe.js";

registerProcessor(
  "wasm-probe",
  class extends AudioWorkletProcessor {
    constructor() {
      super();
      this.port.postMessage(globalThis.wasmProbe());
    }
    process() {
      return false;
    }
  }
);
