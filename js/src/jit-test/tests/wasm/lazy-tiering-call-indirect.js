// |jit-test| -P wasm_lazy_tiering; -P wasm_lazy_tiering_synchronous; -P wasm_lazy_tiering_level=9; skip-if: wasmCompileMode() != "baseline+ion" || !getPrefValue("wasm_lazy_tiering")

// Each function tiers up on its first call, so table entries written before
// that point at baseline code of a function that later tiers up. Calls through
// those entries, and table operations on them, must keep working.

const N = 8;

const lib = wasmEvalText(`(module
  (type $t (func (param i32) (result i32)))
  ${Array.from({ length: N }, (_, i) =>
    `(func $g${i} (export "g${i}") (type $t) (i32.add (local.get 0) (i32.const ${100 * (i + 1)})))`
  ).join("\n")}
)`).exports;

const { exports } = wasmEvalText(`(module
  (type $t (func (param i32) (result i32)))
  (type $u (func (param i64) (result i64)))
  ${Array.from({ length: N }, (_, i) => `(import "lib" "g${i}" (func $g${i} (type $t)))`).join("\n")}
  (table $tab (export "tab") ${4 * N} funcref)
  ${Array.from({ length: N }, (_, i) =>
    `(func $f${i} (export "f${i}") (type $t) (i32.add (local.get 0) (i32.const ${i + 1})))`
  ).join("\n")}
  (elem (table $tab) (i32.const 0) func ${Array.from({ length: N }, (_, i) => `$f${i}`).join(" ")})
  (elem (table $tab) (i32.const ${N}) func ${Array.from({ length: N }, (_, i) => `$g${i}`).join(" ")})
  (elem declare func $f0)

  (func (export "call") (param $x i32) (param $i i32) (result i32)
    (call_indirect $tab (type $t) (local.get $x) (local.get $i)))
  (func (export "tailCall") (param $x i32) (param $i i32) (result i32)
    (return_call_indirect $tab (type $t) (local.get $x) (local.get $i)))
  (func (export "callWrongSig") (param $i i32) (result i64)
    (call_indirect $tab (type $u) (i64.const 0) (local.get $i)))
  (func (export "fill") (param $dst i32) (param $len i32)
    (table.fill $tab (local.get $dst) (ref.func $f0) (local.get $len)))
  (func (export "copy") (param $dst i32) (param $src i32) (param $len i32)
    (table.copy $tab $tab (local.get $dst) (local.get $src) (local.get $len)))
  (func (export "grow") (param $n i32) (result i32)
    (table.grow $tab (ref.null func) (local.get $n)))
)`, { lib });

const tab = exports.tab;
const expected = i => i < N ? i + 1 : 100 * (i - N + 1);

function checkTable(base, len, expectedAt) {
  for (let i = 0; i < len; i++) {
    const want = expectedAt(i);
    assertEq(exports.call(i, base + i), i + want);
    assertEq(exports.tailCall(i, base + i), i + want);
    assertErrorMessage(() => exports.callWrongSig(base + i),
                       WebAssembly.RuntimeError, /indirect call signature mismatch/);
  }
}

for (let iter = 0; iter < 5; iter++) {
  checkTable(0, 2 * N, expected);
  for (let i = 0; i < N; i++) {
    assertEq(tab.get(i), exports["f" + i]);
    assertEq(tab.get(N + i), lib["g" + i]);
  }
  assertEq(tab.get(2 * N), null);
  assertErrorMessage(() => exports.call(0, 2 * N),
                     WebAssembly.RuntimeError, /indirect call to null/);
}

for (let i = 0; i < N; i++) {
  tab.set(2 * N + i, exports["f" + (N - 1 - i)]);
}
checkTable(2 * N, N, i => N - i);

exports.fill(3 * N, N);
checkTable(3 * N, N, () => 1);
assertEq(tab.get(3 * N), exports.f0);

exports.copy(3 * N, N, N);
checkTable(3 * N, N, i => 100 * (i + 1));
assertEq(tab.get(3 * N), lib.g0);

assertEq(exports.grow(N), 4 * N);
tab.set(4 * N, lib.g3);
assertEq(exports.call(1, 4 * N), 401);
assertEq(exports.tailCall(1, 4 * N), 401);
assertEq(tab.get(4 * N), lib.g3);
assertErrorMessage(() => exports.call(0, 4 * N + 1),
                   WebAssembly.RuntimeError, /indirect call to null/);
