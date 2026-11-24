// |jit-test| skip-if: !wasmStackSwitchingEnabled()

// Continuations that survive minor GCs and then die must free their stacks.

let {suspended, resume} = wasmEvalText(`(module
  (type $ft (func))
  (type $ct (cont $ft))
  (tag $t)
  (global $k (mut (ref null $ct)) (ref.null $ct))
  (func $f (type $ft) (suspend $t))
  (elem declare func $f)
  (func (export "suspended")
    (block $h (result (ref $ct))
      (resume $ct (on $t $h) (cont.new $ct (ref.func $f)))
      (return))
    (global.set $k))
  (func (export "resume") (resume $ct (global.get $k)))
)`).exports;

for (let semispace of [0, 1]) {
  gcparam("semispaceNurseryEnabled", semispace);
  for (let i = 0; i < 200; i++) {
    suspended();
    minorgc();
    if (i % 50 == 0) {
      gc();
    }
  }
  resume();
  gc();
}
