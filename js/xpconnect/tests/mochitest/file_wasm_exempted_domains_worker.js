"use strict";

importScripts("file_wasm_exempted_domains_probe.js");

const OPAQUE_CHILD =
  "data:text/javascript," +
  encodeURIComponent(
    "postMessage(typeof WebAssembly === 'undefined' ? 'unavailable' : 'available');"
  );

function spawn(url, options) {
  return new Promise((resolve, reject) => {
    const child = new Worker(url, options);
    child.onmessage = e => {
      child.terminate();
      resolve(e.data);
    };
    child.onerror = e => {
      e.preventDefault();
      child.terminate();
      reject(new Error(`child worker: ${e.message}`));
    };
  });
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
