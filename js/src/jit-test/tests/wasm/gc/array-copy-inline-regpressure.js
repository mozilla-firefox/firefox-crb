// Register pressure across the inline array.copy (refs path needs 11 GPRs on
// x64): keep 14 i64 values live across the copy, plus all copy operands
// distinct. Result must match the JS model.
const { f, g } = wasmEvalText(`(module
  (type $a (array (mut anyref)))
  (type $i (array (mut i8)))
  (func (export "f") (param $seed i64) (param $s (ref $a)) (param $di i32) (param $si i32) (param $len i32) (result i64)
    (local $d (ref $a)) (local $x0 i64) (local $x1 i64) (local $x2 i64) (local $x3 i64) (local $x4 i64) (local $x5 i64) (local $x6 i64) (local $x7 i64) (local $x8 i64) (local $x9 i64) (local $x10 i64) (local $x11 i64) (local $x12 i64) (local $x13 i64)
    (local.set $x0 (i64.mul (local.get $seed) (i64.const 3)))
(local.set $x1 (i64.mul (local.get $seed) (i64.const 5)))
(local.set $x2 (i64.mul (local.get $seed) (i64.const 7)))
(local.set $x3 (i64.mul (local.get $seed) (i64.const 9)))
(local.set $x4 (i64.mul (local.get $seed) (i64.const 11)))
(local.set $x5 (i64.mul (local.get $seed) (i64.const 13)))
(local.set $x6 (i64.mul (local.get $seed) (i64.const 15)))
(local.set $x7 (i64.mul (local.get $seed) (i64.const 17)))
(local.set $x8 (i64.mul (local.get $seed) (i64.const 19)))
(local.set $x9 (i64.mul (local.get $seed) (i64.const 21)))
(local.set $x10 (i64.mul (local.get $seed) (i64.const 23)))
(local.set $x11 (i64.mul (local.get $seed) (i64.const 25)))
(local.set $x12 (i64.mul (local.get $seed) (i64.const 27)))
(local.set $x13 (i64.mul (local.get $seed) (i64.const 29)))
    (local.set $d (array.new_default $a (i32.const 16)))
    (array.copy $a $a (local.get $d) (local.get $di) (local.get $s) (local.get $si) (local.get $len))
    (i64.add (i64.add (i64.mul (i64.add (i64.mul (i64.add (i64.mul (i64.add (i64.mul (i64.add (i64.mul (i64.add (i64.mul (i64.add (i64.mul (i64.add (i64.mul (i64.add (i64.mul (i64.add (i64.mul (i64.add (i64.mul (i64.add (i64.mul (i64.add (i64.mul (i64.add (i64.mul (i64.const 0) (i64.const 3)) (local.get $x0)) (i64.const 3)) (local.get $x1)) (i64.const 3)) (local.get $x2)) (i64.const 3)) (local.get $x3)) (i64.const 3)) (local.get $x4)) (i64.const 3)) (local.get $x5)) (i64.const 3)) (local.get $x6)) (i64.const 3)) (local.get $x7)) (i64.const 3)) (local.get $x8)) (i64.const 3)) (local.get $x9)) (i64.const 3)) (local.get $x10)) (i64.const 3)) (local.get $x11)) (i64.const 3)) (local.get $x12)) (i64.const 3)) (local.get $x13))
      (i64.extend_i32_s (i31.get_s (ref.cast (ref i31) (array.get $a (local.get $d) (i32.add (local.get $di) (i32.sub (local.get $len) (i32.const 1)))))))))
  (func (export "g") (param $seed i64) (param $d (ref $i)) (param $s (ref $i)) (param $di i32) (param $si i32) (param $len i32) (result i64)
    (local $x0 i64) (local $x1 i64) (local $x2 i64) (local $x3 i64) (local $x4 i64) (local $x5 i64) (local $x6 i64) (local $x7 i64) (local $x8 i64) (local $x9 i64) (local $x10 i64) (local $x11 i64) (local $x12 i64) (local $x13 i64)
    (local.set $x0 (i64.mul (local.get $seed) (i64.const 3)))
(local.set $x1 (i64.mul (local.get $seed) (i64.const 5)))
(local.set $x2 (i64.mul (local.get $seed) (i64.const 7)))
(local.set $x3 (i64.mul (local.get $seed) (i64.const 9)))
(local.set $x4 (i64.mul (local.get $seed) (i64.const 11)))
(local.set $x5 (i64.mul (local.get $seed) (i64.const 13)))
(local.set $x6 (i64.mul (local.get $seed) (i64.const 15)))
(local.set $x7 (i64.mul (local.get $seed) (i64.const 17)))
(local.set $x8 (i64.mul (local.get $seed) (i64.const 19)))
(local.set $x9 (i64.mul (local.get $seed) (i64.const 21)))
(local.set $x10 (i64.mul (local.get $seed) (i64.const 23)))
(local.set $x11 (i64.mul (local.get $seed) (i64.const 25)))
(local.set $x12 (i64.mul (local.get $seed) (i64.const 27)))
(local.set $x13 (i64.mul (local.get $seed) (i64.const 29)))
    (array.copy $i $i (local.get $d) (local.get $di) (local.get $s) (local.get $si) (local.get $len))
    (i64.add (i64.add (i64.mul (i64.add (i64.mul (i64.add (i64.mul (i64.add (i64.mul (i64.add (i64.mul (i64.add (i64.mul (i64.add (i64.mul (i64.add (i64.mul (i64.add (i64.mul (i64.add (i64.mul (i64.add (i64.mul (i64.add (i64.mul (i64.add (i64.mul (i64.add (i64.mul (i64.const 0) (i64.const 3)) (local.get $x0)) (i64.const 3)) (local.get $x1)) (i64.const 3)) (local.get $x2)) (i64.const 3)) (local.get $x3)) (i64.const 3)) (local.get $x4)) (i64.const 3)) (local.get $x5)) (i64.const 3)) (local.get $x6)) (i64.const 3)) (local.get $x7)) (i64.const 3)) (local.get $x8)) (i64.const 3)) (local.get $x9)) (i64.const 3)) (local.get $x10)) (i64.const 3)) (local.get $x11)) (i64.const 3)) (local.get $x12)) (i64.const 3)) (local.get $x13))
      (i64.extend_i32_u (array.get_u $i (local.get $d) (i32.add (local.get $di) (i32.sub (local.get $len) (i32.const 1))))))))`).exports;
const { mka, mki } = wasmEvalText(`(module
  (type $a (array (mut anyref)))
  (type $i (array (mut i8)))
  (func (export "mka") (result (ref $a))
    (local $r (ref $a)) (local $k i32)
    (local.set $r (array.new_default $a (i32.const 16)))
    (block $d (loop $l (br_if $d (i32.ge_u (local.get $k) (i32.const 16)))
      (array.set $a (local.get $r) (local.get $k) (ref.i31 (i32.add (local.get $k) (i32.const 50))))
      (local.set $k (i32.add (local.get $k) (i32.const 1))) (br $l)))
    (local.get $r))
  (func (export "mki") (result (ref $i))
    (local $r (ref $i)) (local $k i32)
    (local.set $r (array.new_default $i (i32.const 100)))
    (block $d (loop $l (br_if $d (i32.ge_u (local.get $k) (i32.const 100)))
      (array.set $i (local.get $r) (local.get $k) (i32.add (local.get $k) (i32.const 7)))
      (local.set $k (i32.add (local.get $k) (i32.const 1))) (br $l)))
    (local.get $r)))`).exports;
function model(seed) {
  let u = 0n;
  for (let i = 0; i < 14; i++) u = BigInt.asIntN(64, u * 3n + BigInt.asIntN(64, seed * BigInt(i * 2 + 3)));
  return u;
}
for (let it = 0; it < 3; it++) {
  for (let len = 1; len <= 10; len++) {
    for (const [di, si] of [[0, 0], [2, 3], [16 - len, 0], [0, 16 - len]]) {
      if (di + len > 16 || si + len > 16) continue;
      const seed = 0x123456789n + BigInt(len);
      assertEq(f(seed, mka(), di, si, len), BigInt.asIntN(64, model(seed) + BigInt(50 + si + len - 1)), `f len=${len}`);
    }
  }
  for (let len = 1; len <= 66; len++) {
    const di = 5, si = 9, seed = 77n + BigInt(len);
    const d = mki(), s = mki();
    assertEq(g(seed, d, s, di, si, len), BigInt.asIntN(64, model(seed) + BigInt(si + len - 1 + 7)), `g len=${len}`);
    const m = mki();
    assertEq(g(seed, m, m, si, di, len), BigInt.asIntN(64, model(seed) + BigInt(di + len - 1 + 7)), `g same len=${len}`);
  }
}
