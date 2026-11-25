// |jit-test| test-also=--spectre-mitigations=on

// Exhaustive-ish array.copy semantics per element type, around the inline
// threshold (64 bytes), with overlap and bounds edge cases. Values are compared
// as raw bits (i32/i64 views) so NaN payloads are checked too.

// t: element storage type, w: wasm value type used to set/get, bits: function
// to produce the stored bit pattern for index i.
const types = [
  { t: "i8", get: "array.get_u", w: "i32", conv: "", unconv: "", val: i => (i * 37 + 0x81) & 0xff, limit: 64 },
  { t: "i16", get: "array.get_u", w: "i32", conv: "", unconv: "", val: i => (i * 977 + 0x8001) & 0xffff, limit: 32 },
  { t: "i32", get: "array.get", w: "i32", conv: "", unconv: "", val: i => (i * 0x01010101 + 0x80000001) | 0, limit: 16 },
  { t: "f32", get: "array.get", w: "i32", conv: "f32.reinterpret_i32", unconv: "i32.reinterpret_f32",
    val: i => (0x7f800001 + i) | 0, limit: 16 },  // signaling NaN payloads
  { t: "i64", get: "array.get", w: "i64", conv: "", unconv: "", val: i => BigInt.asIntN(64, BigInt(i) * 0x0101010101010101n + 0x8000000000000001n), limit: 8 },
  { t: "f64", get: "array.get", w: "i64", conv: "f64.reinterpret_i64", unconv: "i64.reinterpret_f64",
    val: i => BigInt.asIntN(64, 0x7ff0000000000001n + BigInt(i)), limit: 8 },
];

function build(t, get, w, conv, unconv) {
  const setBody = conv ? `(${conv} (local.get 2))` : `(local.get 2)`;
  const getBody = unconv ? `(${unconv} (${get} $a (local.get 0) (local.get 1)))`
                         : `(${get} $a (local.get 0) (local.get 1))`;
  return wasmEvalText(`(module
    (type $a (array (mut ${t})))
    (func (export "make") (param i32) (result (ref $a)) (array.new_default $a (local.get 0)))
    (func (export "set") (param (ref $a) i32 ${w})
      (array.set $a (local.get 0) (local.get 1) ${setBody}))
    (func (export "read") (param (ref $a) i32) (result ${w}) ${getBody})
    (func (export "copy") (param (ref null $a) i32 (ref null $a) i32 i32)
      (array.copy $a $a (local.get 0) (local.get 1) (local.get 2) (local.get 3) (local.get 4)))
    (func (export "copySame") (param (ref $a) i32)
      (array.copy $a $a (local.get 0) (local.get 1) (local.get 0) (local.get 1) (local.get 1)))
    (func (export "copyLen0") (param (ref null $a) i32 (ref null $a) i32)
      (array.copy $a $a (local.get 0) (local.get 1) (local.get 2) (local.get 3) (i32.const 0)))
    ;; Read-copy-read in one function: the second read must see the copy.
    (func (export "readCopyRead") (param $d (ref $a)) (param $s (ref $a)) (param $len i32) (result ${w})
      (drop (${get} $a (local.get $d) (i32.const 0)))
      (array.copy $a $a (local.get $d) (i32.const 0) (local.get $s) (i32.const 0) (local.get $len))
      ${unconv ? `(${unconv} (${get} $a (local.get $d) (i32.const 0)))` : `(${get} $a (local.get $d) (i32.const 0))`})
    ;; Loop: shift-by-one memmove repeated; LICM must not hoist the read.
    (func (export "loopShift") (param $d (ref $a)) (param $n i32) (param $len i32) (result ${w})
      (local $i i32) (local $acc ${w})
      (block $done (loop $l
        (br_if $done (i32.ge_u (local.get $i) (local.get $n)))
        (array.copy $a $a (local.get $d) (i32.const 1) (local.get $d) (i32.const 0) (local.get $len))
        (local.set $acc ${unconv ? `(${unconv} (${get} $a (local.get $d) (local.get $len)))` : `(${get} $a (local.get $d) (local.get $len))`})
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $l)))
      (local.get $acc))
  )`).exports;
}

for (const { t, get, w, conv, unconv, val, limit } of types) {
  const SIZE = limit * 3 + 4;
  const { make, set, read, copy, copySame, copyLen0, readCopyRead, loopShift } = build(t, get, w, conv, unconv);
  const fill = (arr, seed) => {
    const m = [];
    for (let i = 0; i < SIZE; i++) { m[i] = val(i + seed); set(arr, i, m[i]); }
    return m;
  };
  const check = (arr, m, what) => {
    for (let i = 0; i < SIZE; i++) {
      const got = read(arr, i);
      if (got !== m[i]) {
        throw new Error(`${t} ${what} [${i}] got ${got} expected ${m[i]}`);
      }
    }
  };
  const lens = [0, 1, 2, 3, limit - 2, limit - 1, limit, limit + 1, limit + 2, 2 * limit];
  for (const len of lens) {
    if (len < 0) continue;
    const offs = [[0, 0], [1, 0], [0, 1], [2, 0], [0, 2], [limit, 0], [0, limit],
                  [SIZE - len, 0], [0, SIZE - len], [SIZE - len, SIZE - len]];
    for (const [di, si] of offs) {
      if (di < 0 || si < 0 || di + len > SIZE || si + len > SIZE) continue;
      const dst = make(SIZE), src = make(SIZE);
      const dm = fill(dst, 1000), sm = fill(src, 0);
      copy(dst, di, src, si, len);
      for (let i = 0; i < len; i++) dm[di + i] = sm[si + i];
      check(dst, dm, `copy len=${len} di=${di} si=${si}`);
      check(src, sm, `src untouched len=${len} di=${di} si=${si}`);

      const same = make(SIZE);
      const m = fill(same, 0);
      copy(same, di, same, si, len);
      const before = m.slice();
      for (let i = 0; i < len; i++) m[di + i] = before[si + i];
      check(same, m, `move len=${len} di=${di} si=${si}`);
    }
  }

  // copySame: idx == len == k on the same array; valid when 2k <= SIZE.
  for (let k = 0; 2 * k <= SIZE; k++) {
    const a = make(SIZE);
    const m = fill(a, 7);
    copySame(a, k);
    check(a, m, `copySame k=${k}`);
  }
  {
    const a = make(SIZE);
    assertErrorMessage(() => copySame(a, SIZE), WebAssembly.RuntimeError, /index out of bounds/);
  }

  // Bounds: len 0 at exactly length is OK, length+1 traps; overflow cases trap.
  const a = make(SIZE), b = make(SIZE);
  copy(a, SIZE, b, SIZE, 0);
  copyLen0(a, SIZE, b, SIZE);
  for (const [di, si, len] of [[SIZE + 1, 0, 0], [0, SIZE + 1, 0], [SIZE, 0, 1], [0, SIZE, 1],
                               [SIZE - 1, 0, 2], [0, SIZE - 1, 2],
                               [-1, 0, 1], [0, -1, 1], [1, 0, -1], [0, 1, -1], [-1, -1, 0],
                               [0x7fffffff, 0, 2], [1, 1, 0x7fffffff], [0, 0, SIZE + 1]]) {
    assertErrorMessage(() => copy(a, di, b, si, len), WebAssembly.RuntimeError, /index out of bounds/);
  }
  assertErrorMessage(() => copyLen0(a, SIZE + 1, b, 0), WebAssembly.RuntimeError, /index out of bounds/);
  assertErrorMessage(() => copyLen0(a, 0, b, SIZE + 1), WebAssembly.RuntimeError, /index out of bounds/);
  // Null with length 0 still traps.
  assertErrorMessage(() => copy(null, 0, b, 0, 0), WebAssembly.RuntimeError, /null/);
  assertErrorMessage(() => copy(a, 0, null, 0, 0), WebAssembly.RuntimeError, /null/);
  assertErrorMessage(() => copy(null, 0, b, 0, 1), WebAssembly.RuntimeError, /null/);
  assertErrorMessage(() => copy(a, 0, null, 0, 1), WebAssembly.RuntimeError, /null/);

  // Zero-length arrays.
  const z = make(0);
  copy(z, 0, z, 0, 0);
  assertErrorMessage(() => copy(z, 0, z, 0, 1), WebAssembly.RuntimeError, /index out of bounds/);

  // readCopyRead / loopShift.
  for (const len of [1, limit, limit + 1]) {
    const d = make(SIZE), s = make(SIZE);
    fill(d, 500);
    const sm = fill(s, 3);
    assertEq(readCopyRead(d, s, len), sm[0], `${t} readCopyRead len=${len}`);
  }
  for (const len of [1, 2, limit - 1, limit, limit + 1]) {
    const d = make(SIZE);
    const m = fill(d, 0);
    const n = 3;
    const r = loopShift(d, n, len);
    // After each shift, element len equals former element len-1.
    for (let it = 0; it < n; it++) {
      const before = m.slice();
      for (let i = 0; i < len; i++) m[1 + i] = before[i];
    }
    assertEq(r, m[len], `${t} loopShift len=${len}`);
    check(d, m, `loopShift len=${len}`);
  }
}
