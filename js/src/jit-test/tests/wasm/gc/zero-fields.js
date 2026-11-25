// struct.new_default and array.new_default with a constant length must zero
// every field, even when the allocation reuses memory that held other data.

const types = [
  { t: "i8", get: "_u", nonZero: "(i32.const -1)", isZero: x => `(i32.eqz ${x})` },
  { t: "i16", get: "_u", nonZero: "(i32.const -1)", isZero: x => `(i32.eqz ${x})` },
  { t: "i32", get: "", nonZero: "(i32.const -1)", isZero: x => `(i32.eqz ${x})` },
  { t: "i64", get: "", nonZero: "(i64.const -1)", isZero: x => `(i64.eqz ${x})` },
  { t: "f32", get: "", nonZero: "(f32.const 1)", isZero: x => `(f32.eq ${x} (f32.const 0))` },
  { t: "f64", get: "", nonZero: "(f64.const 1)", isZero: x => `(f64.eq ${x} (f64.const 0))` },
  { t: "anyref", get: "", nonZero: "(ref.i31 (i32.const 1))", isZero: x => `(ref.is_null ${x})` },
];

function checkFields(get, count, isZero) {
  let body = "(i32.const 1)";
  for (let i = 0; i < count; i++) {
    body = `(i32.and ${body} ${isZero(get(i))})`;
  }
  return body;
}

for (const { t, get, nonZero, isZero } of types) {
  for (let n = 0; n <= 20; n++) {
    const fields = Array(n).fill(`(field (mut ${t}))`).join(" ");
    const values = Array(n).fill(nonZero).join(" ");
    const ins = wasmEvalText(`(module
      (type $s (struct ${fields}))
      (type $a (array (mut ${t})))
      (func (export "fill") (param $count i32)
        (loop $l
          (drop (struct.new $s ${values}))
          (drop (array.new $a ${nonZero} (i32.const ${n})))
          (br_if $l (local.tee $count (i32.sub (local.get $count) (i32.const 1))))))
      (func (export "check") (result i32)
        (local $s (ref $s)) (local $a (ref $a))
        (local.set $s (struct.new_default $s))
        (local.set $a (array.new_default $a (i32.const ${n})))
        (i32.and
          ${checkFields(i => `(struct.get${get} $s ${i} (local.get $s))`, n, isZero)}
          ${checkFields(i => `(array.get${get} $a (local.get $a) (i32.const ${i}))`, n, isZero)})))`).exports;
    for (let round = 0; round < 3; round++) {
      ins.fill(200);
      minorgc();
      for (let i = 0; i < 50; i++) {
        assertEq(ins.check(), 1, `${t} x ${n}`);
      }
    }
  }
}
