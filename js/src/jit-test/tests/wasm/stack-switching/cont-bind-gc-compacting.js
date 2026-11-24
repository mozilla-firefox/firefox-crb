// |jit-test| skip-if: !wasmStackSwitchingEnabled(); --gc-zeal=14,1

// Regression test: a bound ref must survive a compacting GC during cont.bind.
//
// emitContBind writes the bound args into the cont's initial params area, then
// contBind allocates the output ContObject. Those refs are traced -- and
// relocated -- only through an owning ContObject, so the stack must stay
// attached across that allocation; detaching first leaves them dangling.
// --gc-zeal=14,1 compacts on every allocation.

let m = new WebAssembly.Module(wasmTextToBinary(`(module
  (type $ft  (func (param externref) (result externref)))
  (type $ct  (cont $ft))
  (type $ft0 (func (result externref)))   ;; after binding the externref
  (type $ct0 (cont $ft0))
  (func $f (param externref) (result externref) (local.get 0))
  (elem declare func $f)
  (func (export "run") (param $o externref) (result externref)
    (local $k (ref null $ct0))
    local.get $o
    ref.func $f
    cont.new $ct
    cont.bind $ct $ct0
    local.set $k
    (resume $ct0 (local.get $k))))`));
let i = new WebAssembly.Instance(m);

for (let n = 0; n < 20; n++) {
  let obj = { id: n };
  // Tenure obj so the compacting GC inside contBind relocates it.
  gc();
  assertEq(i.exports.run(obj), obj);
}
