// |jit-test| skip-if: !wasmStackSwitchingEnabled()

// Regression test: Ion MIR emitters for cont params/results and suspend tag
// results omitted mirGen().ensureBallast() in per-value loops. With a large
// number of values, this exhausts the LifoAlloc ballast and trips an
// infallible-allocation assertion in debug builds.

const N = 500;
const types = new Array(N).fill("i64").join(" ");
const pushes = "(i64.const 0) ".repeat(N);
const drops = "drop ".repeat(N);

// Case 1: cont type with many params — triggers the emitResume args loop
// (MWasmStoreStackResult per arg, no ensureBallast).
wasmEvalText(`(module
  (type $ft (func (param ${types})))
  (type $ct (cont $ft))
  (func $f (type $ft))
  (elem declare func $f)
  (func
    ${pushes}
    ref.func $f
    cont.new $ct
    resume $ct))`);

// Case 2: cont type with many results — triggers the emitResume results loop
// (MWasmStackResult per result, no ensureBallast).
wasmEvalText(`(module
  (type $ft (func (result ${types})))
  (type $ct (cont $ft))
  (func $f (type $ft) ${pushes})
  (elem declare func $f)
  (func
    ref.func $f
    cont.new $ct
    resume $ct
    ${drops}))`);

// Case 3: tag with many results (matching cont params) — triggers the
// emitSuspend tag-results loop (MWasmStackResult per tag result, no
// ensureBallast). $f ignores its N params (in locals) and suspends, then drops
// the N tag results delivered by the resumer.
wasmEvalText(`(module
  (type $ft (func (param ${types})))
  (type $ct (cont $ft))
  (tag $tag (result ${types}))
  (func $f (type $ft)
    suspend $tag
    ${drops})
  (elem declare func $f)
  (func
    (local $k (ref null $ct))
    (block $on_tag (result (ref $ct))
      ${pushes}
      ref.func $f
      cont.new $ct
      resume $ct (on $tag 0)
      unreachable)
    local.set $k
    ${pushes}
    local.get $k
    resume $ct))`);

// Case 4: cont.bind with many bound params — triggers the emitContBind loop
// (an MWasmStoreField per scalar arg).
// MBinaryInstruction nodes are smaller than MTernaryInstruction, so a larger N
// is needed to exhaust the 16 KiB ballast.
{
  const N4 = 900;
  const types4 = new Array(N4).fill("i64").join(" ");
  const pushes4 = "(i64.const 0) ".repeat(N4);
  wasmEvalText(`(module
    (type $ft (func (param ${types4})))
    (type $ct (cont $ft))
    (type $ft0 (func))
    (type $ct0 (cont $ft0))
    (func $f (type $ft))
    (elem declare func $f)
    (func
      ${pushes4}
      ref.func $f
      cont.new $ct
      cont.bind $ct $ct0
      resume $ct0))`);
}
