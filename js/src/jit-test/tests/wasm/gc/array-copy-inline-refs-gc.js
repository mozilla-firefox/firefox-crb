// |jit-test| test-also=--gc-zeal=4; test-also=--gc-zeal=11

// Reference array.copy into a freshly allocated destination (the only ref case
// the inline path takes), with nursery-allocated source values, under minor
// GC, incremental marking, pretenuring and gczeal modes. Values must survive
// and stay correct after GCs. The gc-zeal variants verify pre (4) and post (11)
// barriers.

const { mk, freshCopy, freshCopyBox, freshMove, freshExtern, sum, boxSum, gcMid, nested } = wasmEvalText(`(module
  (type $box (struct (field (mut i32))))
  (type $a (array (mut anyref)))
  (type $e (array (mut externref)))
  (type $b (array (mut (ref null $box))))
  (import "" "gc" (func $gc))

  (func $mkboxes (param $n i32) (param $base i32) (result (ref $b))
    (local $r (ref $b)) (local $i i32)
    (local.set $r (array.new_default $b (local.get $n)))
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $i) (local.get $n)))
      (array.set $b (local.get $r) (local.get $i)
        (struct.new $box (i32.add (local.get $base) (local.get $i))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l)))
    (local.get $r))

  (func $mkany (param $n i32) (param $base i32) (result (ref $a))
    (local $r (ref $a)) (local $i i32)
    (local.set $r (array.new_default $a (local.get $n)))
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $i) (local.get $n)))
      (array.set $a (local.get $r) (local.get $i)
        (if (result anyref) (i32.and (local.get $i) (i32.const 1))
          (then (struct.new $box (i32.add (local.get $base) (local.get $i))))
          (else (ref.i31 (i32.add (local.get $base) (local.get $i))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l)))
    (local.get $r))

  (func $val (param anyref) (result i32)
    (if (result i32) (ref.test (ref i31) (local.get 0))
      (then (i31.get_s (ref.cast (ref i31) (local.get 0))))
      (else (if (result i32) (ref.is_null (local.get 0))
        (then (i32.const -1))
        (else (struct.get $box 0 (ref.cast (ref $box) (local.get 0))))))))

  (func (export "sum") (param $x (ref $a)) (result i32)
    (local $i i32) (local $s i32)
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $i) (array.len (local.get $x))))
      (local.set $s (i32.add (i32.mul (local.get $s) (i32.const 31))
                             (call $val (array.get $a (local.get $x) (local.get $i)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l)))
    (local.get $s))

  (func (export "boxSum") (param $x (ref $b)) (result i32)
    (local $i i32) (local $s i32)
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $i) (array.len (local.get $x))))
      (local.set $s (i32.add (i32.mul (local.get $s) (i32.const 31))
        (if (result i32) (ref.is_null (array.get $b (local.get $x) (local.get $i)))
          (then (i32.const -1))
          (else (struct.get $box 0 (array.get $b (local.get $x) (local.get $i)))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l)))
    (local.get $s))

  (func (export "mk") (param i32 i32) (result (ref $a)) (call $mkany (local.get 0) (local.get 1)))

  ;; Fresh destination, fresh source.
  (func (export "freshCopy") (param $n i32) (param $di i32) (param $si i32) (param $len i32) (result (ref $a))
    (local $d (ref $a))
    (local.set $d (array.new_default $a (local.get $n)))
    (array.copy $a $a (local.get $d) (local.get $di) (call $mkany (local.get $n) (i32.const 1000))
                (local.get $si) (local.get $len))
    (local.get $d))

  ;; Fresh destination, source passed in (possibly tenured, possibly holding
  ;; nursery cells).
  (func (export "freshCopyBox") (param $n i32) (param $s (ref $b)) (param $di i32) (param $si i32) (param $len i32) (result (ref $b))
    (local $d (ref $b))
    (local.set $d (array.new_default $b (local.get $n)))
    (array.copy $b $b (local.get $d) (local.get $di) (local.get $s) (local.get $si) (local.get $len))
    (local.get $d))

  ;; Fresh destination copied into itself (overlap) after being populated.
  (func (export "freshMove") (param $n i32) (param $di i32) (param $si i32) (param $len i32) (result (ref $a))
    (local $d (ref $a))
    (local.set $d (array.new_default $a (local.get $n)))
    (array.copy $a $a (local.get $d) (i32.const 0) (call $mkany (local.get $n) (i32.const 2000))
                (i32.const 0) (local.get $n))
    (array.copy $a $a (local.get $d) (local.get $di) (local.get $d) (local.get $si) (local.get $len))
    (local.get $d))

  (func (export "freshExtern") (param $n i32) (param $s (ref $e)) (param $len i32) (result (ref $e))
    (local $d (ref $e))
    (local.set $d (array.new_default $e (local.get $n)))
    (array.copy $e $e (local.get $d) (i32.const 0) (local.get $s) (i32.const 0) (local.get $len))
    (local.get $d))

  ;; GC between allocation of the fresh destination and the copy: the
  ;; destination is tenured by then (must take the builtin path).
  (func (export "gcMid") (param $n i32) (param $s (ref $b)) (param $len i32) (result (ref $b))
    (local $d (ref $b))
    (local.set $d (array.new_default $b (local.get $n)))
    (call $gc)
    (array.copy $b $b (local.get $d) (i32.const 0) (local.get $s) (i32.const 0) (local.get $len))
    (local.get $d))

  ;; Copy into a fresh array, store it into a (possibly tenured) holder; the
  ;; post barrier on the holder must cover the fresh array, and the fresh
  ;; array itself must be traced on promotion.
  (func (export "nested") (param $holder (ref $a)) (param $s (ref $b)) (param $len i32)
    (local $d (ref $b))
    (local.set $d (array.new_default $b (i32.const 8)))
    (array.copy $b $b (local.get $d) (i32.const 0) (local.get $s) (i32.const 0) (local.get $len))
    (array.set $a (local.get $holder) (i32.const 0) (local.get $d)))
)`, { "": { gc: () => minorgc() } }).exports;

const { mkboxes } = wasmEvalText(`(module
  (type $box (struct (field (mut i32))))
  (type $b (array (mut (ref null $box))))
  (func (export "mkboxes") (param $n i32) (param $base i32) (result (ref $b))
    (local $r (ref $b)) (local $i i32)
    (local.set $r (array.new_default $b (local.get $n)))
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $i) (local.get $n)))
      (array.set $b (local.get $r) (local.get $i)
        (struct.new $box (i32.add (local.get $base) (local.get $i))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l)))
    (local.get $r)))`).exports;
// Note: separate module => separate $b type is still structurally equal, so it
// canonicalizes to the same type and can be passed in.

function modelAny(n, base) {
  const m = [];
  for (let i = 0; i < n; i++) m[i] = base + i;
  return m;
}
function hash(m) { let s = 0; for (const v of m) s = (Math.imul(s, 31) + v) | 0; return s; }


const N = 12;
const keep = [];
for (let round = 0; round < 6; round++) {
  if (round === 2 && !gcstate().startsWith("Mark") && gcstate() === "NotActive") startgc(1);
  if (round === 4 && this.finishgc) finishgc();
  for (let len = 0; len <= 10; len++) {
    for (const [di, si] of [[0, 0], [1, 0], [0, 1], [N - len, 0], [0, N - len]]) {
      if (di + len > N || si + len > N) continue;
      // freshCopy
      {
        const d = freshCopy(N, di, si, len);
        const m = new Array(N).fill(-1);
        const s = modelAny(N, 1000);
        for (let i = 0; i < len; i++) m[di + i] = s[si + i];
        keep.push([d, hash(m)]);
        assertEq(sum(d), hash(m), `freshCopy len=${len} di=${di} si=${si}`);
      }
      // freshMove
      {
        const d = freshMove(N, di, si, len);
        const m = modelAny(N, 2000);
        const b = m.slice();
        for (let i = 0; i < len; i++) m[di + i] = b[si + i];
        keep.push([d, hash(m)]);
        assertEq(sum(d), hash(m), `freshMove len=${len} di=${di} si=${si}`);
      }
      // freshCopyBox with nursery and tenured sources
      for (const tenure of [false, true]) {
        const s = mkboxes(N, 3000 + round);
        if (tenure) minorgc();
        const d = freshCopyBox(N, s, di, si, len);
        const m = new Array(N).fill(-1);
        for (let i = 0; i < len; i++) m[di + i] = 3000 + round + si + i;
        keep.push([d, hash(m), "box"]);
        assertEq(boxSum(d), hash(m), `freshCopyBox tenure=${tenure} len=${len}`);
      }
    }
  }
  // gcMid
  for (let len = 1; len <= 9; len++) {
    const s = mkboxes(9, 4000);
    const d = gcMid(9, s, len);
    const m = new Array(9).fill(-1);
    for (let i = 0; i < len; i++) m[i] = 4000 + i;
    keep.push([d, hash(m), "box"]);
    assertEq(boxSum(d), hash(m), `gcMid len=${len}`);
  }
  // nested: tenured holder, nursery fresh array copied into.
  {
    const holder = mk(1, 0);
    minorgc();
    for (let len = 1; len <= 8; len++) {
      const s = mkboxes(8, 5000 + len);
      nested(holder, s, len);
      minorgc();
      gc();
      // re-read through the holder via sum: element 0 is an array of boxes,
      // $val would cast-fail; just check it is non-null via a JS round trip.
    }
  }
  minorgc();
  // Re-verify everything after GC.
  for (const [d, h, kind] of keep) {
    assertEq(kind === "box" ? boxSum(d) : sum(d), h, "after gc");
  }
}
gc();
for (const [d, h, kind] of keep) {
  assertEq(kind === "box" ? boxSum(d) : sum(d), h, "final");
}

// externref: JS objects and strings (nursery strings) as elements.
{
  const { mkext, setext, getext } = wasmEvalText(`(module
    (type $e (array (mut externref)))
    (func (export "mkext") (param i32) (result (ref $e)) (array.new_default $e (local.get 0)))
    (func (export "setext") (param (ref $e) i32 externref) (array.set $e (local.get 0) (local.get 1) (local.get 2)))
    (func (export "getext") (param (ref $e) i32) (result externref) (array.get $e (local.get 0) (local.get 1))))`).exports;
  const out = [];
  for (let len = 0; len <= 9; len++) {
    const s = mkext(9);
    for (let i = 0; i < 9; i++) setext(s, i, i % 2 ? { v: "o" + i } : "s" + i + "x".repeat(i));
    const d = freshExtern(9, s, len);
    out.push([d, len]);
  }
  minorgc(); gc();
  for (const [d, len] of out) {
    for (let i = 0; i < 9; i++) {
      const v = getext(d, i);
      if (i < len) {
        assertEq(i % 2 ? v.v : v, i % 2 ? "o" + i : "s" + i + "x".repeat(i));
      } else {
        assertEq(v, null);
      }
    }
  }
}
