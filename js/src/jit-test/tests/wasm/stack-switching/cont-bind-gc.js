// |jit-test| skip-if: !wasmStackSwitchingEnabled()

// Regression test: the bound-ref store must not read its destination slot.
//
// emitContBind appends a ref-typed bound arg at unboundParamsArea. With a
// Normal SATB pre-barrier that store first greys the slot's current bytes,
// which past the bound params are uninitialized or a stale, possibly freed ref,
// so greying them is a use-after-free. The fix is WasmPreBarrierKind::None,
// since this store is initialization.
{
  let { setup, phase2 } = wasmEvalText(`(module
    ;; Original cont: leading externref param, bound in phase 1.
    (type $ft   (func (param externref) (result i32)))
    (type $ct   (cont $ft))
    (type $ft0  (func (result i32)))            ;; after binding the externref
    (type $ct0  (cont $ft0))
    ;; The tag's results become the post-suspend cont's params: (externref i32).
    (tag  $t    (result externref i32))
    (type $ftR  (func (param externref i32) (result i32)))
    (type $ctR  (cont $ftR))
    (type $ftR1 (func (param i32) (result i32)))   ;; after binding the externref
    (type $ctR1 (cont $ftR1))
    (global $k  (mut (ref null $ctR))  (ref.null $ctR))
    (global $k1 (mut (ref null $ctR1)) (ref.null $ctR1))

    ;; Drop the bound externref so that after the suspend its only would-be root
    ;; is the (untraced) consumed params slot, then suspend through $t.
    (func $f (type $ft)
      ref.null extern
      local.set 0
      suspend $t
      drop drop
      i32.const 0
    )
    (elem declare func $f)

    ;; Phase 1: bind obj at slot 0, resume; $f suspends; capture the suspended
    ;; continuation (post-suspend type $ctR) in $k.
    (func (export "setup") (param $obj externref)
      (block $h (result (ref $ctR))
        local.get $obj
        ref.func $f
        cont.new $ct
        cont.bind $ct $ct0
        resume $ct0 (on $t $h)
        unreachable
      )
      global.set $k
    )

    ;; Phase 2: bind a new externref at slot 0 of the suspended cont. The bound
    ;; store's pre-barrier reads the stale slot-0 bytes left by phase 1.
    (func (export "phase2") (param $obj2 externref)
      local.get $obj2
      global.get $k
      ref.as_non_null
      cont.bind $ctR $ctR1
      global.set $k1
    )
  )`).exports;

  let obj = {};
  // Observing obj tenures it, so the gc() below poisons it and the buggy read
  // becomes a hard crash rather than a quiet misread.
  addMarkObservers([obj]);
  setup(obj);          // phase-1 bind + resume + suspend; $k holds the cont
  obj = null;
  gc();                // collect obj -> the consumed params slot now dangling
  gczeal(8);           // YieldBeforeMarking: the next GC pauses in the Mark phase
  startgc(1);          // enter incremental marking -> SATB pre-barriers are on
  phase2({});          // a Normal pre-barrier here reads the dangling slot -> UAF
  finishgc();
  gczeal(0);

  // Reaching here without a crash means the store never read the stale slot.
  assertEq(true, true);
}
