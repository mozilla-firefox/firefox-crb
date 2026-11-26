;; Assembled with the JS shell:
;;   os.file.writeTypedArrayToFile("namespace-instance-cycle.wasm",
;;     wasmTextToBinary(os.file.readFile("namespace-instance-cycle.wat")))
(module
  (import "namespace-instance-cycle.js" "fn" (func))
  (export "fn" (func 0)))
