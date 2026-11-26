function check(o, expected) {
  assertEq(Object.keys(o).join(), Object.keys(expected).join());
  for (var k of Object.keys(o)) {
    assertEq(o[k], expected[k]);
  }
}

for (var n = 1; n < 40; n++) {
  for (var del = 0; del < n; del++) {
    var o = {};
    var e = {};
    for (var i = 0; i < n; i++) {
      o["p" + i] = i;
      e["p" + i] = i;
    }
    delete o["p" + del];
    delete e["p" + del];
    check(o, e);

    o["p" + del] = "x";
    e["p" + del] = "x";
    check(o, e);

    Object.defineProperty(o, "acc", {
      get() { return this.p0; }, configurable: true, enumerable: true
    });
    delete o["p" + ((del + 1) % n)];
    assertEq(o.acc, o.p0);
  }
}

// mobx-style: replace class fields with accessors.
class C {
  a = 1;
  b = 2;
  c = 3;
  d = 4;
  constructor() {
    for (var k of ["a", "b", "c", "d"]) {
      let v = this[k];
      delete this[k];
      Object.defineProperty(this, k, {
        get() { return v; }, set(x) { v = x; }, enumerable: true,
        configurable: true
      });
    }
  }
}
var sum = 0;
for (var i = 0; i < 2000; i++) {
  var c = new C();
  c.b = i;
  sum += c.a + c.b + c.c + c.d;
  assertEq(Object.keys(c).join(), "a,b,c,d");
  delete c.a;
  assertEq(c.a, undefined);
  assertEq(Object.keys(c).join(), "b,c,d");
}
assertEq(sum, 2000 * 8 + (2000 * 1999) / 2);

var f = function() {};
f.x = 1;
f.y = 2;
delete f.prototype;
delete f.x;
assertEq(f.y, 2);
assertEq("x" in f, false);

var a = [1, 2, 3];
a.foo = 1;
a.bar = 2;
delete a.foo;
assertEq(a.bar, 2);
assertEq(a.length, 3);

// Custom data properties: removing one and re-adding following ones.
function testArgs() {
  var args = arguments;
  args.x = 1;
  var unused = args.callee;
  args.y = 2;
  args[Symbol.iterator];
  args.z = 3;
  delete args.length;
  assertEq(args.length, undefined);
  assertEq(args.x + args.y + args.z, 6);
  assertEq(args.callee, testArgs);
  delete args.x;
  assertEq(args.x, undefined);
  assertEq(args.y + args.z, 5);
  assertEq(args.callee, testArgs);
  delete args.callee;
  assertEq(args.callee, undefined);
  assertEq(args.y + args.z, 5);
  assertEq(args[0] + args[1], 3);
  args.w = 4;
  assertEq(args.y + args.z + args.w, 9);
}
for (var i = 0; i < 50; i++) {
  testArgs(1, 2);
}

// Properties stored in reserved slots.
for (var i = 0; i < 50; i++) {
  var err = new Error("msg", {cause: "c"});
  err.x = 1;
  err.y = 2;
  var line = err.lineNumber;
  var col = err.columnNumber;
  delete err.fileName;
  assertEq(err.fileName, Error.prototype.fileName);
  assertEq(err.lineNumber, line);
  assertEq(err.columnNumber, col);
  assertEq(err.message, "msg");
  assertEq(err.cause, "c");
  assertEq(err.x + err.y, 3);
  delete err.message;
  assertEq(err.message, "");
  assertEq(err.cause, "c");
  assertEq(err.x + err.y, 3);
  delete err.x;
  assertEq(err.x, undefined);
  assertEq(err.y, 2);
  assertEq(err.cause, "c");
  err.z = 3;
  assertEq(err.y + err.z, 5);
  assertEq(Object.getOwnPropertyNames(err).join(), "lineNumber,columnNumber,cause,y,z");
}
