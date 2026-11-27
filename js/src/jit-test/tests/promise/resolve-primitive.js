// Promise.resolve with a primitive returns an already fulfilled promise, for
// %Promise% as well as for subclasses and other realms' Promise constructors.

function settledValue(p) {
  // An already fulfilled promise runs its reaction on the next tick, before a
  // reaction registered afterwards on another fulfilled promise.
  const order = [];
  let value;
  p.then(v => { order.push("p"); value = v; });
  new Promise(r => r()).then(() => order.push("other"));
  drainJobQueue();
  assertEq(order.join(), "p,other");
  return value;
}

const primitives = [undefined, null, 0, -0, 1.5, "str", true, Symbol("s"), 10n];

for (const value of primitives) {
  assertEq(Object.is(settledValue(Promise.resolve(value)), value), true);
}

// A subclass constructor is observably constructed.
{
  let constructed = 0;
  class MyPromise extends Promise {
    constructor(executor) {
      constructed++;
      super(executor);
    }
  }
  const p = MyPromise.resolve(1);
  assertEq(constructed, 1);
  assertEq(p instanceof MyPromise, true);
  assertEq(settledValue(p), 1);
}

// Another realm's Promise.resolve creates a promise in that realm.
{
  const g = newGlobal();
  const p = g.Promise.resolve(2);
  assertEq(Object.getPrototypeOf(p), g.Promise.prototype);
  assertEq(settledValue(p), 2);

  const q = Promise.resolve.call(g.Promise, 3);
  assertEq(Object.getPrototypeOf(q), g.Promise.prototype);
  assertEq(settledValue(q), 3);
}

// A primitive passed with a non-Promise constructor goes through its executor.
{
  let resolved;
  function NotPromise(executor) {
    executor(v => { resolved = v; }, () => {});
  }
  Promise.resolve.call(NotPromise, 4);
  assertEq(resolved, 4);
}

// The debugger sees a fulfilled promise with a resolution site.
{
  const g = newGlobal({newCompartment: true});
  const dbg = new Debugger();
  const gw = dbg.addDebuggee(g);
  const p = gw.makeDebuggeeValue(g.eval("Promise.resolve(5)"));
  assertEq(p.promiseState, "fulfilled");
  assertEq(p.promiseValue, 5);
  assertEq(p.promiseResolutionSite !== null, true);
}
