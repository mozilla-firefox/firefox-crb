// |jit-test| skip-if: !wasmStackSwitchingEnabled() || !hasFunction.oomAtAllocation

// A cont.bind that fails with OOM must leave the input continuation's params
// unchanged.

{
  let {make, bind, run} = wasmEvalText(`(module
    (type $ft (func (param i64 i64 i64 i64) (result i64 i64 i64 i64)))
    (type $ct (cont $ft))
    (type $ft2 (func (param i64 i64) (result i64 i64 i64 i64)))
    (type $ct2 (cont $ft2))
    (global $g (mut (ref null $ct)) (ref.null $ct))
    (func $f (type $ft) local.get 0 local.get 1 local.get 2 local.get 3)
    (elem declare func $f)
    (func (export "make") ref.func $f cont.new $ct global.set $g)
    (func (export "bind")
      i64.const 100
      i64.const 200
      global.get $g
      ref.as_non_null
      cont.bind $ct $ct2
      drop)
    (func (export "run") (result i64 i64 i64 i64)
      i64.const 1 i64.const 2 i64.const 3 i64.const 4
      global.get $g
      resume $ct)
  )`).exports;
  let failed = false;
  for (let n = 1; n < 200 && !failed; n++) {
    make();
    oomAtAllocation(n);
    try {
      bind();
    } catch (e) {
      failed = true;
    }
    resetOOMFailure();
  }
  assertEq(failed, true);
  assertEq(run().join(","), "1,2,3,4");
}

{
  let {setup, bind, run} = wasmEvalText(`(module
    (tag $t (result i64 i64 i64 i64))
    (type $ftR (func (param i64 i64 i64 i64) (result i64)))
    (type $ctR (cont $ftR))
    (type $ftR2 (func (param i64 i64) (result i64)))
    (type $ctR2 (cont $ftR2))
    (type $ft (func (result i64)))
    (type $ct (cont $ft))
    (global $k (mut (ref null $ctR)) (ref.null $ctR))
    (func $f (type $ft) (local $a i64) (local $b i64) (local $c i64) (local $d i64)
      suspend $t
      local.set $d local.set $c local.set $b local.set $a
      (i64.add (i64.mul (local.get $a) (i64.const 1000))
               (i64.add (i64.mul (local.get $b) (i64.const 100))
                        (i64.add (i64.mul (local.get $c) (i64.const 10))
                                 (local.get $d)))))
    (elem declare func $f)
    (func (export "setup")
      (block $h (result (ref $ctR))
        ref.func $f cont.new $ct
        resume $ct (on $t $h)
        drop return)
      global.set $k)
    (func (export "bind")
      i64.const 7 i64.const 8
      global.get $k ref.as_non_null
      cont.bind $ctR $ctR2 drop)
    (func (export "run") (result i64)
      i64.const 1 i64.const 2 i64.const 3 i64.const 4
      global.get $k resume $ctR)
  )`).exports;
  setup();
  let fails = 0;
  for (let i = 0; i < 3; i++) {
    oomAtAllocation(1);
    try {
      bind();
    } catch (e) {
      fails++;
    }
    resetOOMFailure();
  }
  assertEq(fails, 3);
  assertEq(run(), 1234n);
}
