# TestUtils module

```{js:autoclass} TestUtils
:members: *, asyncControlProxy
```

```{mermaid}
flowchart TD
    accTitle: Async call control
    accDescr {
      A proxy creates a controller that waits for one matching call. Once
      the intercepted method starts, the test can wait for its result
      before releasing it to the caller. The rejection branch shows how
      to make the caller's promise reject before the method runs.
    }
    Factory["TestUtils.asyncControlProxy(owner)"] -->|Returns| Proxy["AsyncControlProxy&lt;Owner&gt;"]
    Proxy -->|Create a controller| AsyncCallController
    AsyncCallController -->|Wait for a match| Wait["waitForInterception()"]
    Wait -->|Allow the promise to run| Start["start()"]
    Wait -->|Force the promise to reject| Reject["rejectResult(reason)"]
    Start -->|Release the result<br/>to the caller| Release
    Start -->|Wait for the result| Result["waitForResult()"]
    Result -->|Release the result<br/>to the caller| Release["releaseResult()"]
```

```{rubric} How to create a proxy and controller
:heading-level: 2
:name: create-a-controller-for-an-asynchronous-method
```

To create a proxy, pass an object or class to `TestUtils.asyncControlProxy()`.
The proxy exposes methods with the same names as the original object's promise-returning methods.

```js
class Loader {
  static loadedResources = [];

  async load(resource) {
    Loader.loadedResources.push(resource);

    return resource;
  }
}

const loader = new Loader();
const loaderProxy = TestUtils.asyncControlProxy(loader);
```

To create a controller for a method, call the method on the proxy object.

Here, `loaderProxy.load()` creates a controller that will intercept the next call to
`loader.load()` before the method starts. The caller will instead receive a promise
that is controlled by the controller.

```{note}
Instantiate the controller with
[using](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/using)
to ensure that it is automatically cleaned up at the end of the lexical scope.
```

```js
using loadController = loaderProxy.load();

// The load controller intercepts this next call.
// loadPromise is a Promise that the controller is able to control.
const loadPromise = loader.load();
```

```{rubric} Control the progression of an asynchronous call
:heading-level: 2
:name: control-the-progression-of-an-asynchronous-call
```

Intercepting an asynchronous call is like setting a breakpoint at the start
of the method. Once you await `waitForInterception()`, the state is effectively paused
_before_ the underlying promise runs.

The test can make assertions before the method starts, then call `start()`
to let it run. The test can await `waitForResult()` to wait for the method
to finish and use its result if needed. The caller's promise stays pending
until the test calls `releaseResult()`.


````{admonition} Example
```js
class Loader {
  static loadedResources = [];

  async load(resource) {
    Loader.loadedResources.push(resource);

    return resource;
  }
}

const loader = new Loader();

// Create a controller for the next call to loader.load().
using loadController = TestUtils.asyncControlProxy(loader).load();

// The caller receives a promise from the loadController instead,
// which will remain pending until we call releaseResult().
const callerPromise = loader.load("A");

// Once interception is confirmed, the original method has yet to start.
await loadController.waitForInterception();
Assert.deepEqual(Loader.loadedResources, [], "The method has yet to start");

// start() lets the method run while the caller's promise stays pending.
// This step is optional because waitForResult() and releaseResult()
// will necessarily start the method if needed.
loadController.start();

// Wait for the method to finish while the caller is still waiting.
const result = await loadController.waitForResult();
Assert.equal(result, "A");
Assert.deepEqual(Loader.loadedResources, ["A"], "The method has run");

// Even though the method has run to completion, the caller's promise
// will remain pending until we call releaseResult().
const nextTick = TestUtils.waitForTick().then(() => "next tick");
Assert.equal(
  await Promise.race([callerPromise, nextTick]),
  "next tick",
  "The caller is still waiting for releaseResult()"
);

// releaseResult() gives the caller its result so it can continue.
const releasedPromise = loadController.releaseResult();

Assert.strictEqual(releasedPromise, callerPromise);
Assert.equal(await releasedPromise, result);
```
````

```{rubric} Reject an intercepted asynchronous call
:heading-level: 2
:name: reject-an-intercepted-asynchronous-call
```

Intercept a call to simulate a failure before the method runs. Call
`rejectResult(reason)` after interception and before the method starts.
The caller's promise rejects with that reason, and the controller skips
the original method.

````{admonition} Example
```js
class Loader {
  static loadedResources = [];

  async load(resource) {
    Loader.loadedResources.push(resource);

    return resource;
  }
}

const loader = new Loader();

// Create a controller for the next call to loader.load().
using loadController = TestUtils.asyncControlProxy(loader).load();

// The caller receives a promise from the loadController instead,
// which will remain pending until we call rejectResult().
const callerPromise = loader.load("A");

// Once interception is confirmed, the original method has yet to start.
await loadController.waitForInterception();
Assert.deepEqual(Loader.loadedResources, [], "The method has yet to start");

// rejectResult() sends the failure to the caller and skips the method.
const failure = new Error("Resource A is unavailable");
loadController.rejectResult(failure);

await Assert.rejects(callerPromise, error => error === failure);
Assert.deepEqual(Loader.loadedResources, [], "The method never ran");
```
````

```{rubric} Match a call by its receiver or arguments
:heading-level: 2
:name: match-a-call-by-its-receiver-or-arguments
```

You can optionally pass a predicate function when you create a controller
for a method on the proxy. While the controller waits for a match, it calls
the predicate before each call in its scope can run. The predicate receives
the method's `this` value as its first parameter and an array of the call's
arguments in its second parameter.

* When the predicate returns or resolves to `true`, the controller will
  intercept that call.

* When the predicate returns or resolves to `false`, the controller will allow
  the call to pass through and run as normal, then continue waiting for a
  matching call.

````{admonition} Example
```js
class Loader {
  static loadedResources = [];

  async load(resource) {
    Loader.loadedResources.push(resource);

    return resource;
  }
}

const firstLoader = new Loader();
const secondLoader = new Loader();

// Create a controller for Loader.load() that matches calls on secondLoader.
using classLoadController = TestUtils.asyncControlProxy(Loader).load(
  receiver => receiver === secondLoader
);

// "A" doesn't match, so it loads normally. The controller intercepts "B".
// "C" loads normally because the controller has already intercepted "B",
// though it wouldn't have matched regardless.
const loadAPromise = firstLoader.load("A");
const loadBPromise = secondLoader.load("B");
const loadCPromise = firstLoader.load("C");

await classLoadController.waitForInterception();

Assert.equal(await loadAPromise, "A");
Assert.equal(await loadCPromise, "C");
Assert.deepEqual(Loader.loadedResources, ["A", "C"]);

classLoadController.releaseResult();

Assert.equal(await loadBPromise, "B");
Assert.deepEqual(Loader.loadedResources, ["A", "C", "B"]);

using instanceLoadController = TestUtils.asyncControlProxy(firstLoader).load(
  (_, [resource]) => resource === "2"
);

// "1" doesn't match, so it loads normally. The controller intercepts "2".
// "3" loads normally because the controller has already intercepted "2",
// though it wouldn't have matched regardless.
const load1Promise = firstLoader.load("1");
const load2Promise = firstLoader.load("2");
const load3Promise = firstLoader.load("3");

await instanceLoadController.waitForInterception();

Assert.equal(await load1Promise, "1");
Assert.equal(await load3Promise, "3");
Assert.deepEqual(Loader.loadedResources, ["A", "C", "B", "1", "3"]);

instanceLoadController.releaseResult();

Assert.equal(await load2Promise, "2");
Assert.deepEqual(Loader.loadedResources, ["A", "C", "B", "1", "3", "2"]);
```
````
