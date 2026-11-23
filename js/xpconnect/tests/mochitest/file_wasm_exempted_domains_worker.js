"use strict";

importScripts("file_wasm_exempted_domains_probe.js");

const OPAQUE_CHILD =
  "data:text/javascript," +
  encodeURIComponent(
    "postMessage(typeof WebAssembly === 'undefined' ? 'unavailable' : 'available');"
  );

async function spawn(url, options) {
  const child = new Worker(url, options);
  const data = await nextWorkerMessage(child);
  child.terminate();
  return data;
}

async function probeAll() {
  try {
    const [nested, opaque] = await Promise.all([
      spawn("file_wasm_exempted_domains_worker.js", { name: "nested" }),
      spawn(OPAQUE_CHILD),
    ]);
    postMessage({ worker: wasmProbe(), nested, opaque });
  } catch (e) {
    postMessage({ error: String(e) });
  }
}

if (self.name === "nested") {
  postMessage(wasmProbe());
} else {
  onmessage = probeAll;
  probeAll();
}
