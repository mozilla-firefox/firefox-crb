// |jit-test| skip-if: !wasmSimdEnabled()

// v128 arrays: 16-byte elements copied as two 8-byte chunks; overlap by one
// element in both directions, around the 4-element inline limit.

const SIZE = 16;
const { make, set, read, copy } = wasmEvalText(`(module
  (type $a (array (mut v128)))
  (func (export "make") (result (ref $a)) (array.new_default $a (i32.const ${SIZE})))
  (func (export "set") (param (ref $a) i32 i64 i64)
    (array.set $a (local.get 0) (local.get 1)
      (i64x2.replace_lane 1 (i64x2.splat (local.get 2)) (local.get 3))))
  (func (export "read") (param (ref $a) i32 i32) (result i64)
    (if (result i64) (local.get 2)
      (then (i64x2.extract_lane 1 (array.get $a (local.get 0) (local.get 1))))
      (else (i64x2.extract_lane 0 (array.get $a (local.get 0) (local.get 1))))))
  (func (export "copy") (param (ref $a) i32 (ref $a) i32 i32)
    (array.copy $a $a (local.get 0) (local.get 1) (local.get 2) (local.get 3) (local.get 4))))`).exports;

const lo = i => BigInt(i) * 0x1111n + 0x0102030405060708n;
const hi = i => BigInt.asIntN(64, BigInt(i) * 0x2222n + 0x8877665544332211n);
const fill = (a, seed) => { const m = []; for (let i = 0; i < SIZE; i++) { m[i] = [lo(i + seed), hi(i + seed)]; set(a, i, m[i][0], m[i][1]); } return m; };
const check = (a, m, what) => {
  for (let i = 0; i < SIZE; i++) {
    assertEq(read(a, i, 0), m[i][0], `${what} lo[${i}]`);
    assertEq(read(a, i, 1), m[i][1], `${what} hi[${i}]`);
  }
};
for (let len = 0; len <= 6; len++) {
  for (const [di, si] of [[0, 0], [1, 0], [0, 1], [3, 0], [0, 3], [SIZE - len, 0], [0, SIZE - len]]) {
    if (di + len > SIZE || si + len > SIZE) continue;
    const d = make(), s = make();
    const dm = fill(d, 100), sm = fill(s, 0);
    copy(d, di, s, si, len);
    for (let i = 0; i < len; i++) dm[di + i] = sm[si + i];
    check(d, dm, `copy len=${len} di=${di} si=${si}`);
    const a = make();
    const m = fill(a, 0);
    copy(a, di, a, si, len);
    const b = m.slice();
    for (let i = 0; i < len; i++) m[di + i] = b[si + i];
    check(a, m, `move len=${len} di=${di} si=${si}`);
  }
}
