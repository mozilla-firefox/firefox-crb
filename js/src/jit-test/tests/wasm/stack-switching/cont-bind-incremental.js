// |jit-test| skip-if: !wasmStackSwitchingEnabled() || !hasFunction.gczeal

// cont.bind during incremental marking must keep the bound continuation's
// stack contents alive.

function bindDuringMarking(setup, bind2, run) {
  let chain;
  (function () {
    let obj = {x: 42};
    chain = {box: setup(obj)};
    for (let i = 0; i < 200000; i++) {
      chain = {next: chain};
    }
  })();
  gc();
  let c = chain;
  while (c.next) {
    c = c.next;
  }
  gczeal(8);
  startgc(1);
  bind2(c.box);
  finishgc();
  gczeal(0);
  gc();
  assertEq(run().x, 42);
}

{
  let {setup, bind2, run} = wasmEvalText(`(module
    (type $ft (func (param externref externref) (result externref)))
    (type $ct (cont $ft))
    (type $ft1 (func (param externref) (result externref)))
    (type $ct1 (cont $ft1))
    (type $ft0 (func (result externref)))
    (type $ct0 (cont $ft0))
    (type $box (struct (field (mut (ref null $ct1)))))
    (global $g0 (mut (ref null $ct0)) (ref.null $ct0))
    (func $f (type $ft) local.get 0)
    (elem declare func $f)
    (func (export "setup") (param externref) (result anyref)
      local.get 0
      ref.func $f
      cont.new $ct
      cont.bind $ct $ct1
      struct.new $box)
    (func (export "bind2") (param anyref)
      ref.null extern
      local.get 0
      ref.cast (ref $box)
      struct.get $box 0
      ref.as_non_null
      cont.bind $ct1 $ct0
      global.set $g0)
    (func (export "run") (result externref)
      global.get $g0
      resume $ct0)
  )`).exports;
  bindDuringMarking(setup, bind2, run);
}

{
  let {setup, bind2, run} = wasmEvalText(`(module
    (tag $t (result i32))
    (type $ftR (func (param i32) (result externref)))
    (type $ctR (cont $ftR))
    (type $ftR0 (func (result externref)))
    (type $ctR0 (cont $ftR0))
    (type $ft (func (param externref) (result externref)))
    (type $ct (cont $ft))
    (type $box (struct (field (mut (ref null $ctR)))))
    (global $k0 (mut (ref null $ctR0)) (ref.null $ctR0))
    (func $f (type $ft)
      suspend $t
      drop
      local.get 0)
    (elem declare func $f)
    (func (export "setup") (param externref) (result anyref)
      (block $h (result (ref $ctR))
        local.get 0
        ref.func $f
        cont.new $ct
        resume $ct (on $t $h)
        drop
        ref.null any
        return)
      struct.new $box)
    (func (export "bind2") (param anyref)
      i32.const 5
      local.get 0
      ref.cast (ref $box)
      struct.get $box 0
      ref.as_non_null
      cont.bind $ctR $ctR0
      global.set $k0)
    (func (export "run") (result externref)
      global.get $k0
      resume $ctR0)
  )`).exports;
  bindDuringMarking(setup, bind2, run);
}
