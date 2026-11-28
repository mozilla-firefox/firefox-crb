// |jit-test| skip-if: !wasmJSPromiseIntegrationEnabled()

// Import calls made while wasm runs on a continuation stack use the JIT exit,
// which switches to the main stack to run the JS callee.

let options = getJitCompilerOptions();
let warmup = options["baseline.enable"]
  ? options["baseline.warmup.trigger"] + 1
  : 1;

let mode = "plain";
let valueToConvert = 0;
let capturedStack = null;
let pending = [];

let inner = wasmEvalText(`(module
  (import "" "s" (func $s (result i32)))
  (func (export "viaSuspending") (result i32) call $s)
)`, {"": {s: new WebAssembly.Suspending(async () => 7)}}).exports;
let innerPromising = WebAssembly.promising(inner.viaSuspending);

let e;

function ffi(n) {
  switch (mode) {
    case "plain":
      return n + 1;
    case "convert":
      return valueToConvert;
    case "throw":
      throw new Error("ffi threw " + n);
    case "gc":
      gc();
      minorgc();
      return n + 1;
    case "stack":
      capturedStack = new Error();
      return n + 1;
    case "nested":
      pending.push(innerPromising());
      return n + 1;
    case "suspendError":
      try {
        inner.viaSuspending();
      } catch (err) {
        return err instanceof WebAssembly.SuspendError ? n + 1 : -1;
      }
      return -2;
    case "reenter":
      return e.dbl(n) | 0;
    case "profile":
      readGeckoProfilingStack();
      return n + 1;
  }
  throw new Error("bad mode " + mode);
}
function sum(a, b, c) {
  return (a | 0) + (b | 0) + (c | 0);
}
function dbl(x) {
  return x * 2;
}

for (let i = 0; i < warmup; i++) {
  ffi(i);
  sum(i, i, i);
  dbl(i);
}

e = wasmEvalText(`(module
  (import "" "ffi" (func $ffi (param i32) (result i32)))
  (import "" "sum" (func $sum1 (param i32) (result i32)))
  (import "" "dbl" (func $dbl (param f64) (result f64)))
  (import "" "s" (func $s (result i32)))
  (func $leaf (param i32) (result i32)
    local.get 0
    call $ffi)
  (func (export "call") (param i32) (result i32)
    local.get 0
    call $leaf)
  (func (export "underflow") (param i32) (result i32)
    local.get 0
    call $sum1)
  (func (export "dbl") (param f64) (result f64)
    local.get 0
    call $dbl)
  (func (export "catching") (param i32) (result i32)
    try (result i32)
      local.get 0
      call $ffi
    catch_all
      i32.const -100
    end)
  (func (export "catchThenSuspend") (param i32) (result i32)
    try (result i32)
      local.get 0
      call $ffi
    catch_all
      i32.const -100
    end
    call $s
    i32.add)
)`, {"": {ffi, sum, dbl, s: new WebAssembly.Suspending(async () => 7)}}).exports;

// The first call of each import installs its JIT exit.
assertEq(e.call(1), 2);
assertEq(e.underflow(5), 5);
assertEq(e.dbl(1.5), 3);
assertEq(e.catching(1), 2);

let P = {};
for (let name of ["call", "underflow", "dbl", "catching", "catchThenSuspend"]) {
  P[name] = WebAssembly.promising(e[name]);
}

async function assertRejectsWith(promise, message) {
  try {
    await promise;
  } catch (err) {
    assertEq(err.message, message);
    return;
  }
  throw new Error("expected a rejection with: " + message);
}

function topFrames(err, n) {
  return err.stack.trim().split("\n").slice(0, n)
    .map(WasmHelpers.extractStackFrameFunction);
}

(async function () {
  for (let i = 0; i < 100; i++) {
    assertEq(await P.call(i), i + 1);
    assertEq(await P.underflow(i), i);
    assertEq(await P.dbl(i + 0.5), 2 * i + 1);
    assertEq(await P.catching(i), i + 1);
    assertEq(await P.catchThenSuspend(i), i + 8);
  }

  mode = "convert";
  valueToConvert = 2 ** 31;
  assertEq(await P.call(0), -(2 ** 31));
  valueToConvert = { valueOf() { return 17; } };
  assertEq(await P.call(0), 17);
  valueToConvert = { valueOf() { throw new Error("valueOf threw"); } };
  await assertRejectsWith(P.call(0), "valueOf threw");
  assertEq(await P.catching(0), -100);

  mode = "throw";
  await assertRejectsWith(P.call(3), "ffi threw 3");
  for (let i = 0; i < 20; i++) {
    assertEq(await P.catching(i), -100);
    assertEq(await P.catchThenSuspend(i), -93);
  }

  mode = "gc";
  for (let i = 0; i < 20; i++) {
    assertEq(await P.call(i), i + 1);
  }

  mode = "stack";
  e.call(1);
  let direct = topFrames(capturedStack, 3);
  assertEq(await P.call(1), 2);
  let onContStack = topFrames(capturedStack, 3);
  assertEq(direct.join("|"), onContStack.join("|"));

  mode = "nested";
  assertEq(await P.call(2), 3);
  assertEq(await pending.pop(), 7);

  mode = "suspendError";
  assertEq(await P.call(2), 3);

  mode = "reenter";
  assertEq(await P.call(4), 8);

  if (typeof enableGeckoProfiling === "function") {
    enableGeckoProfiling();
    mode = "profile";
    for (let i = 0; i < 20; i++) {
      assertEq(await P.call(i), i + 1);
    }
    disableGeckoProfiling();
  }

  mode = "plain";
  assertEq(await P.call(41), 42);
  assertEq(e.call(41), 42);
})().catch(err => {
  print(err.stack);
  quit(1);
});
