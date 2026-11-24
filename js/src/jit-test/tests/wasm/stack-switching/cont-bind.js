// |jit-test| skip-if: !wasmStackSwitchingEnabled()

// Tests for cont.bind. Covers i32/i64/f32/f64/v128 and externref bound params,
// chained binds, zero-arg binds, bind-after-suspend, multi-result returns,
// binding into a suspendResultsArea, and GC tracing of the bound prefix.
// Stack convention at resume: [...unbound args..., (ref ct)].
// cont.bind binds the LEADING params of the input cont type.

// End-to-end data flow: multi-param resume, a multi-param tag, and a
// multi-result return, run twice. run1 binds nothing, so the resume args go
// through the params area below the base frame and then straight into the
// suspender's frame; run2 binds a prefix of them into the same areas before
// each resume. Both must observe the same values -- cont.bind cannot change
// results.
{
  let { run1, run2, getX, getW } = wasmEvalText(`(module
    (type $ft   (func (param i32 externref) (result i32 f64)))
    (type $ct   (cont $ft))
    (type $ft1  (func (param externref) (result i32 f64)))
    (type $ct1  (cont $ft1))
    (tag  $t    (param i32 externref) (result i64 f64))
    (type $ftR  (func (param i64 f64) (result i32 f64)))
    (type $ctR  (cont $ftR))
    (type $ftR1 (func (param f64) (result i32 f64)))
    (type $ctR1 (cont $ftR1))

    (global $gX (mut i32) (i32.const 0))
    (global $gW (mut externref) (ref.null extern))

    (func $f (param $a i32) (param $b externref) (result i32 f64)
      (local $y i64) (local $z f64)
      local.get $a
      local.get $b
      suspend $t
      local.set $z
      local.set $y
      local.get $a
      local.get $y
      i32.wrap_i64
      i32.add
      local.get $z
      f64.const 2
      f64.mul
    )
    (elem declare func $f)

    (func (export "run1") (param $b externref) (result i32 f64)
      (local $k (ref null $ctR))
      block $h (result i32 externref (ref $ctR))
        i32.const 7
        local.get $b
        ref.func $f
        cont.new $ct
        resume $ct (on $t $h)
        return
      end
      local.set $k
      global.set $gW
      global.set $gX
      i64.const 5
      f64.const 2.5
      local.get $k
      ref.as_non_null
      resume $ctR
    )

    (func (export "run2") (param $b externref) (result i32 f64)
      (local $k (ref null $ctR))
      (local $k1 (ref null $ct1))
      (local $kR1 (ref null $ctR1))
      block $h (result i32 externref (ref $ctR))
        i32.const 7
        ref.func $f
        cont.new $ct
        cont.bind $ct $ct1
        local.set $k1
        local.get $b
        local.get $k1
        ref.as_non_null
        resume $ct1 (on $t $h)
        return
      end
      local.set $k
      global.set $gW
      global.set $gX
      i64.const 5
      local.get $k
      ref.as_non_null
      cont.bind $ctR $ctR1
      local.set $kR1
      f64.const 2.5
      local.get $kR1
      ref.as_non_null
      resume $ctR1
    )
    (func (export "getX") (result i32) global.get $gX)
    (func (export "getW") (result externref) global.get $gW)
  )`).exports;

  let obj = {};
  for (let run of [run1, run2]) {
    let results = run(obj);
    assertEq(results[0], 12);     // bound i32 param 7 + i64 tag result 5
    assertEq(results[1], 5);      // f64 tag result 2.5 * 2
    assertEq(getX(), 7);          // i32 tag param seen by the handler
    assertEq(getW(), obj);        // externref tag param seen by the handler
  }
}

// Chained binds: bind param0, then param1, then resume with param2.
{
  let { run } = wasmEvalText(`(module
    (type $ft (func (param i32 i32 i32) (result i32)))
    (type $ct (cont $ft))
    (type $ft2 (func (param i32 i32) (result i32)))
    (type $ct2 (cont $ft2))
    (type $ft1 (func (param i32) (result i32)))
    (type $ct1 (cont $ft1))
    (func $f (type $ft)
      local.get 0
      local.get 1
      local.get 2
      i32.add
      i32.add
    )
    (elem declare func $f)
    (func (export "run") (result i32)
      i32.const 100
      i32.const 2
      i32.const 1
      ref.func $f
      cont.new $ct
      cont.bind $ct $ct2
      cont.bind $ct2 $ct1
      resume $ct1
    )
  )`).exports;
  assertEq(run(), 103);
}

// externref bound param (verifies tracing across GC).
{
  let { run, build, go } = wasmEvalText(`(module
    (type $ft (func (param externref i32) (result i32)))
    (type $ct (cont $ft))
    (type $ft1 (func (param i32) (result i32)))
    (type $ct1 (cont $ft1))
    (global $g (mut (ref null $ct1)) (ref.null $ct1))
    (func $f (type $ft)
      local.get 1
    )
    (elem declare func $f)
    (func (export "run") (param externref) (param i32) (result i32)
      local.get 1
      local.get 0
      ref.func $f
      cont.new $ct
      cont.bind $ct $ct1
      resume $ct1
    )
    (func (export "build") (param externref)
      local.get 0
      ref.func $f
      cont.new $ct
      cont.bind $ct $ct1
      global.set $g
    )
    (func (export "go") (param i32) (result i32)
      local.get 0
      global.get $g
      ref.as_non_null
      resume $ct1
    )
  )`).exports;
  assertEq(run({}, 7), 7);
  // Trigger GC between bind and resume to exercise tracing.
  let token = { id: "live" };
  build(token);
  gc();
  assertEq(go(42), 42);
}

// f32 bound param.
{
  let { run } = wasmEvalText(`(module
    (type $ft  (func (param f32 f32) (result f32)))
    (type $ct  (cont $ft))
    (type $ft1 (func (param f32) (result f32)))
    (type $ct1 (cont $ft1))
    (func $f (type $ft) local.get 0 local.get 1 f32.add)
    (elem declare func $f)
    (func (export "run") (param f32) (result f32)
      local.get 0
      f32.const 1.5
      ref.func $f
      cont.new $ct
      cont.bind $ct $ct1
      resume $ct1
    )
  )`).exports;
  assertEq(run(Math.fround(0.5)), Math.fround(2.0));
}

// f64 bound param.
{
  let { run } = wasmEvalText(`(module
    (type $ft  (func (param f64 f64) (result f64)))
    (type $ct  (cont $ft))
    (type $ft1 (func (param f64) (result f64)))
    (type $ct1 (cont $ft1))
    (func $f (type $ft) local.get 0 local.get 1 f64.add)
    (elem declare func $f)
    (func (export "run") (param f64) (result f64)
      local.get 0
      f64.const 1.5
      ref.func $f
      cont.new $ct
      cont.bind $ct $ct1
      resume $ct1
    )
  )`).exports;
  assertEq(run(0.5), 2.0);
}

// GC correctness after bind+initial-resume+suspend: the bound arg in the
// initial params area is consumed by the first resume and must no longer be
// traced once the cont is suspended. Uses addMarkObservers/getMarks to check
// liveness reliably.
{
  let { build } = wasmEvalText(`(module
    (type $ft  (func (param externref) (result i32)))
    (type $ct  (cont $ft))
    (type $ft1 (func (result i32)))
    (type $ct1 (cont $ft1))
    (tag $yield)
    (global $k (mut (ref null $ct1)) (ref.null $ct1))
    ;; Null out local 0 before suspending so the suspended frame holds no
    ;; reference to the externref — the only remaining root would be the
    ;; consumed initial params area if it were still traced.
    (func $f (type $ft)
      ref.null extern local.set 0
      suspend $yield
      i32.const 0
    )
    (elem declare func $f)
    (func (export "build") (param externref)
      (block $h (result (ref $ct1))
        local.get 0
        ref.func $f
        cont.new $ct
        cont.bind $ct $ct1
        resume $ct1 (on $yield $h)
        unreachable
      )
      global.set $k
    )
  )`).exports;

  let obj = {};
  addMarkObservers([obj]);
  build(obj);
  obj = null;
  gc();
  assertEq(getMarks()[0], "dead");
}

// v128 bound param (stays entirely in wasm; extracts a lane for assertEq).
if (wasmSimdEnabled()) {
  let { run } = wasmEvalText(`(module
    (type $ft  (func (param v128 v128) (result i32)))
    (type $ct  (cont $ft))
    (type $ft1 (func (param v128) (result i32)))
    (type $ct1 (cont $ft1))
    (func $f (type $ft)
      local.get 0
      local.get 1
      i32x4.add
      i32x4.extract_lane 0
    )
    (elem declare func $f)
    (func (export "run") (result i32)
      v128.const i32x4 10 20 30 40   ;; remaining unbound arg
      v128.const i32x4 1 2 3 4       ;; bound arg
      ref.func $f
      cont.new $ct
      cont.bind $ct $ct1
      resume $ct1
    )
  )`).exports;
  assertEq(run(), 11);  // lane 0: 10 + 1 = 11
}

// cont.bind on a suspended cont whose post-suspend type has MORE params than
// the original cont type, so the bound args go into the suspender's
// suspendResultsArea rather than the (empty) initial params area, since the
// original cont type takes no params at all.
{
  let { run } = wasmEvalText(`(module
    (type $ft  (func (result i32)))
    (type $ct  (cont $ft))
    (type $ftR (func (param i32 i32 i32) (result i32)))
    (type $ctR (cont $ftR))
    (tag $t (result i32 i32 i32))

    ;; $f has no params; suspends through $t, receiving 3 i32 results.
    (func $f (type $ft)
      suspend $t
      i32.add i32.add
    )
    (elem declare func $f)

    (func (export "run") (param i32 i32 i32) (result i32)
      (local $k (ref null $ctR))
      (block $h (result (ref $ctR))
        ref.func $f
        cont.new $ct
        resume $ct (on $t $h)
        return
      )
      local.set $k
      ;; Bind all 3 tag results into the suspendResultsArea.
      local.get 2   ;; param[2] of $ctR (pushed first = deepest)
      local.get 1   ;; param[1]
      local.get 0   ;; param[0] (on top = bound first)
      local.get $k  ref.as_non_null
      cont.bind $ctR $ct
      resume $ct
    )
  )`).exports;
  assertEq(run(3, 5, 7), 15);  // 3 + 5 + 7
  assertEq(run(1, 2, 4), 7);
}

// Post-suspend cont.bind of an externref tag result, kept alive across GC only
// by the bound prefix in the suspended cont's suspendResultsArea. The
// post-suspend cont type ($ctR) has the tag results as its params, and the
// suspender's stackmap must trace the externref slot; were it walked with the
// original cont type ($ct, param i32), the externref would be missed ->
// collected.
{
  let { build } = wasmEvalText(`(module
    (type $ft (func (param i32) (result i32)))
    (type $ct (cont $ft))
    (tag $t (param i32) (result externref i32))
    (type $ftR (func (param externref i32) (result i32)))
    (type $ctR (cont $ftR))
    (type $ftR1 (func (param i32) (result i32)))
    (type $ctR1 (cont $ftR1))
    (global $k (mut (ref null $ctR1)) (ref.null $ctR1))
    ;; $f suspends before the tag results arrive, so the only root for the
    ;; bound externref while suspended is the suspendResultsArea.
    (func $f (type $ft)
      local.get 0
      suspend $t
      drop drop
      i32.const 0
    )
    (elem declare func $f)
    (func (export "build") (param $obj externref)
      (local $kk (ref null $ctR))
      (block $h (result i32 (ref $ctR))
        i32.const 1
        ref.func $f
        cont.new $ct
        resume $ct (on $t $h)
        unreachable
      )
      local.set $kk
      drop                    ;; discard delivered tag param (i32)
      local.get $obj          ;; externref tag-result to bind (leading param)
      local.get $kk
      cont.bind $ctR $ctR1
      global.set $k           ;; store suspended+bound cont; do not resume
    )
  )`).exports;

  let obj = {};
  addMarkObservers([obj]);
  build(obj);
  obj = null;
  gc();
  // getMarks() reports one mark per observer registered so far; an earlier test
  // in this file registers its own, so ours is the most recently appended (last
  // entry). "black" means the object was fully marked, i.e. still reachable --
  // here only via the suspended cont's suspendResultsArea, which the
  // suspender's stackmap traces with the post-suspend cont type. Were the slot
  // mis-typed, the externref would be unreachable and collected, and
  // getMarks() would report "dead".
  let marks = getMarks();
  assertEq(marks[marks.length - 1], "black");
}

// Chained binds whose LEADING bound param is an externref, kept alive across GC
// only by the initial params area. The second bind's input type ($ct2 = (i32))
// does not describe the externref slot at offset 0, so traceFields must walk
// the bound params with the cont.new function's type, or the externref would
// be missed and collected.
{
  let { build } = wasmEvalText(`(module
    (type $ft (func (param externref i32) (result i32)))
    (type $ct (cont $ft))
    (type $ft2 (func (param i32) (result i32)))
    (type $ct2 (cont $ft2))
    (type $ft1 (func (result i32)))
    (type $ct1 (cont $ft1))
    (global $k (mut (ref null $ct1)) (ref.null $ct1))
    (func $f (type $ft) local.get 1)
    (elem declare func $f)
    (func (export "build") (param $obj externref)
      (local $c2 (ref null $ct2))
      local.get $obj          ;; leading externref to bind
      ref.func $f
      cont.new $ct
      cont.bind $ct $ct2      ;; bind externref -> (ref $ct2)
      local.set $c2
      i32.const 7             ;; second bound param (i32)
      local.get $c2
      ref.as_non_null
      cont.bind $ct2 $ct1     ;; bind i32 -> (ref $ct1); traced as $ct
      global.set $k           ;; store bound cont; do not resume
    )
  )`).exports;

  let obj = {};
  addMarkObservers([obj]);
  build(obj);
  obj = null;
  gc();
  // "black" == still reachable, here only via the initial params area.
  let marks = getMarks();
  assertEq(marks[marks.length - 1], "black");
}

// Zero-arg cont.bind: the bound prefix may be empty (input and output cont
// types coincide), which the proposal's own validation.wast asserts is valid.
// It still consumes the input and produces a fresh continuation, but leaves
// unboundParamsArea where it was, so the output resumes as if unbound.
{
  let { init, bindZero, resumeOrig, bindZeroThenParam } = wasmEvalText(`(module
    (type $ft (func (param i32) (result i32)))
    (type $ct (cont $ft))
    (type $ft0 (func (result i32)))
    (type $ct0 (cont $ft0))
    (global $orig (mut (ref null $ct)) (ref.null $ct))
    (func $f (type $ft)
      local.get 0
      i32.const 1
      i32.add
    )
    (elem declare func $f)
    (func (export "init")
      ref.func $f
      cont.new $ct
      global.set $orig
    )
    ;; Bind nothing, then resume the output with the still-unbound param.
    (func (export "bindZero") (result i32)
      (local $k (ref null $ct))
      global.get $orig
      ref.as_non_null
      cont.bind $ct $ct
      local.set $k
      i32.const 41
      local.get $k
      ref.as_non_null
      resume $ct
    )
    ;; The input is consumed even though nothing was bound.
    (func (export "resumeOrig") (result i32)
      i32.const 41
      global.get $orig
      ref.as_non_null
      resume $ct
    )
    ;; A zero-arg bind followed by a real bind: the prefix starts at offset 0.
    (func (export "bindZeroThenParam") (result i32)
      (local $k (ref null $ct))
      ref.func $f
      cont.new $ct
      cont.bind $ct $ct
      local.set $k
      i32.const 7
      local.get $k
      ref.as_non_null
      cont.bind $ct $ct0
      resume $ct0
    )
  )`).exports;

  init();
  assertEq(bindZero(), 42);
  assertErrorMessage(resumeOrig, WebAssembly.RuntimeError,
                     /null pointer/);
  assertEq(bindZeroThenParam(), 8);
}
