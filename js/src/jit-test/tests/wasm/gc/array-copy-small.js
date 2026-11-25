// array.copy of up to and past the inline copy limit, between and within
// arrays, checked against a reference model.

const SIZE = 80;

const types = [
  { t: "i8", get: "array.get_u", ty: "i32", mask: v => v & 0xff },
  { t: "i16", get: "array.get_u", ty: "i32", mask: v => v & 0xffff },
  { t: "i32", get: "array.get", ty: "i32", mask: v => v | 0 },
  { t: "i64", get: "array.get", ty: "i64", mask: v => BigInt.asIntN(64, v) },
  { t: "f64", get: "array.get", ty: "f64", mask: v => v },
];

function value(t, i) {
  return t === "i64" ? BigInt(i) * 0x100000001n + 7n : t === "f64" ? i + 0.5 : i * 37 + 11;
}

for (const { t, get, ty, mask } of types) {
  const { make, set, read, copy } = wasmEvalText(`(module
    (type $a (array (mut ${t})))
    (func (export "make") (result (ref $a)) (array.new_default $a (i32.const ${SIZE})))
    (func (export "set") (param (ref $a) i32 ${ty}) (array.set $a (local.get 0) (local.get 1) (local.get 2)))
    (func (export "read") (param (ref $a) i32) (result ${ty}) (${get} $a (local.get 0) (local.get 1)))
    (func (export "copy") (param (ref $a) i32 (ref $a) i32 i32)
      (array.copy $a $a (local.get 0) (local.get 1) (local.get 2) (local.get 3) (local.get 4))))`).exports;

  const fill = (arr, model, seed) => {
    for (let i = 0; i < SIZE; i++) {
      const v = mask(value(t, i + seed));
      set(arr, i, v);
      model[i] = v;
    }
  };
  const check = (arr, model, what) => {
    for (let i = 0; i < SIZE; i++) {
      assertEq(read(arr, i), model[i], `${t} ${what} [${i}]`);
    }
  };

  for (let len = 0; len <= 70; len++) {
    for (const [di, si] of [[0, 0], [3, 0], [0, 3], [5, 9], [9, 5], [SIZE - len, 0], [0, SIZE - len]]) {
      if (di + len > SIZE || si + len > SIZE) {
        continue;
      }
      // Between two arrays.
      const dst = make(), src = make(), dm = [], sm = [];
      fill(dst, dm, 1000);
      fill(src, sm, 0);
      copy(dst, di, src, si, len);
      for (let i = 0; i < len; i++) {
        dm[di + i] = sm[si + i];
      }
      check(dst, dm, `copy len=${len} di=${di} si=${si}`);
      check(src, sm, `src len=${len}`);

      // Within one array, overlapping in either direction.
      const same = make(), m = [];
      fill(same, m, 0);
      copy(same, di, same, si, len);
      const before = m.slice();
      for (let i = 0; i < len; i++) {
        m[di + i] = before[si + i];
      }
      check(same, m, `move len=${len} di=${di} si=${si}`);
    }
  }

  const a = make(), b = make();
  for (const [di, si, len] of [[SIZE - 3, 0, 4], [0, SIZE - 3, 4], [SIZE + 1, 0, 0], [0, -1, 2], [-1, 0, 2]]) {
    assertErrorMessage(() => copy(a, di, b, si, len), WebAssembly.RuntimeError, /index out of bounds/);
  }
}

// References, including copies into an array allocated in the same function.
const { fresh, into, size } = wasmEvalText(`(module
  (type $a (array (mut anyref)))
  (func $src (param i32) (result (ref $a))
    (local $r (ref $a)) (local $i i32)
    (local.set $r (array.new_default $a (local.get 0)))
    (block $done (loop $l
      (br_if $done (i32.ge_u (local.get $i) (local.get 0)))
      (array.set $a (local.get $r) (local.get $i) (ref.i31 (i32.add (local.get $i) (i32.const 100))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l)))
    (local.get $r))
  (func (export "fresh") (param $n i32) (param $si i32) (param $len i32) (param $k i32) (result i32)
    (local $d (ref $a))
    (local.set $d (array.new_default $a (local.get $n)))
    (array.copy $a $a (local.get $d) (i32.const 0) (call $src (local.get $n)) (local.get $si) (local.get $len))
    (i31.get_s (ref.cast (ref i31) (array.get $a (local.get $d) (local.get $k)))))
  (func (export "into") (param $d (ref $a)) (param $len i32) (param $k i32) (result i32)
    (array.copy $a $a (local.get $d) (i32.const 0) (call $src (i32.const 16)) (i32.const 0) (local.get $len))
    (i31.get_s (ref.cast (ref i31) (array.get $a (local.get $d) (local.get $k)))))
  (func (export "size") (result (ref $a)) (array.new_default $a (i32.const 16))))`).exports;

for (const marking of [false, true]) {
  if (marking) {
    startgc(1);
  }
  for (let len = 1; len <= 12; len++) {
    for (let k = 0; k < len; k++) {
      assertEq(fresh(16, 2, len, k), 100 + 2 + k);
    }
  }
  const tenured = size();
  minorgc();
  for (let len = 1; len <= 12; len++) {
    assertEq(into(tenured, len, len - 1), 100 + len - 1);
  }
  if (marking) {
    finishgc();
  }
}
