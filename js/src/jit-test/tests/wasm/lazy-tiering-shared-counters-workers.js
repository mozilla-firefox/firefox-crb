// |jit-test| skip-if: helperThreadCount() === 0 || typeof SharedArrayBuffer === "undefined"

// Lazy tiering hotness counters are shared by all instances of a module, so
// instances running on different threads update and reset the same counters
// concurrently. With level 9 every counter starts at zero, so concurrent
// tier-up requests can observe counters that went below -127 or that another
// thread already reset.

setPrefValue("wasm_lazy_tiering", true);
setPrefValue("wasm_lazy_tiering_level", 9);

const NUM_FUNCS = 1000;
const NUM_WORKERS = 8;

let funcs = "";
let calls = "";
for (let i = 0; i < NUM_FUNCS; i++) {
  funcs += `
  (func $f${i} (result i32) (local i32)
    (loop $l
      (br_if $l (i32.lt_u (local.tee 0 (i32.add (local.get 0) (i32.const 1)))
                          (i32.const 2000))))
    (local.get 0))`;
  calls += `(drop (call $f${i}))\n`;
}

const mod = new WebAssembly.Module(wasmTextToBinary(`
(module
  ${funcs}
  (func (export "run") ${calls})
)`));

// state[0]: workers that picked up the SharedArrayBuffer.
// state[1]: set once the module has been published.
// state[2]: workers ready to run.
// state[3]: set to start all threads at once.
const sab = new SharedArrayBuffer(16);
const state = new Int32Array(sab);
setSharedObject(sab);

for (let w = 0; w < NUM_WORKERS; w++) {
  evalInWorker(`
    setPrefValue("wasm_lazy_tiering", true);
    setPrefValue("wasm_lazy_tiering_level", 9);
    const state = new Int32Array(getSharedObject());
    Atomics.add(state, 0, 1);
    while (Atomics.load(state, 1) === 0) {}
    const run = new WebAssembly.Instance(getSharedObject()).exports.run;
    Atomics.add(state, 2, 1);
    while (Atomics.load(state, 3) === 0) {}
    run();
  `);
}

while (Atomics.load(state, 0) < NUM_WORKERS) {}
setSharedObject(mod);
Atomics.store(state, 1, 1);

const run = new WebAssembly.Instance(mod).exports.run;
while (Atomics.load(state, 2) < NUM_WORKERS) {}
Atomics.store(state, 3, 1);
run();
