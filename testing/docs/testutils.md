# TestUtils module

```{js:autoclass} TestUtils
:members: *, asyncControlProxy
```

```{rubric} Overview
:heading-level: 2
:name: async-call-control-overview
```

This API lets a test create a controller object that can capture the next matching call
to a promise-returning method. The test can then use the controller to dictate specific
aspects about when the captured call runs, and how its result is delivered to the caller.

A captured call gives the test two special moments at which to pause and make assertions.

1. **After invocation, but before running**

   The controller will be notified when the caller has invoked the method so that
   the test can make assertions before allowing the method to start.

2. **After completion, but before delivery**

   The controller will be notified when the method finishes running so that
   the test can inspect the promise result and make other assertions before
   allowing the caller to receive the outcome.

You can think of this similarly to setting breakpoints for a single promise-returning method,
except instead of pausing the entire execution of the program within a debugger, only the
flow of the captured call is paused.

(create-a-controller-for-an-asynchronous-method)=

```{rubric} AsyncControlProxy and AsyncCallController
:heading-level: 2
:name: async-control-proxy-and-async-call-controller
```

Suppose we have a `Playlist` class with the following methods:

* `addTrack(track)`

  Adds a track to the playlist after the server confirms the addition.

* `removeTrack(track)`

  Removes a track from the playlist after the server confirms the removal.

* `sync()`

  Syncs the playlist with the server.

* `Playlist.syncAll()`

  Syncs all playlists for the account with the server.

We use `TestUtils.waitForTick()` to simulate server communication.

````{admonition} Example
```js
class Playlist {
  // The tests can inspect this list before and after a captured call runs.
  tracks = [];

  static async syncAll() {
    // Simulate waiting for the server to sync all playlists for the account.
    await TestUtils.waitForTick();
  }

  async sync() {
    // Simulate waiting for the server to sync this playlist.
    await TestUtils.waitForTick();
  }

  async addTrack(track) {
    // Simulate waiting for the server to confirm the addition.
    await TestUtils.waitForTick();

    // Once the server confirms the addition, the test can observe the change
    // in tracks even while the caller is waiting for its result.
    this.tracks.push(track);

    return track;
  }

  async removeTrack(track) {
    // Simulate waiting for the server to confirm the removal.
    await TestUtils.waitForTick();

    this.tracks = this.tracks.filter(addedTrack => addedTrack !== track);
  }
}
```
````

`TestUtils.asyncControlProxy()` creates a proxy for an object or class.
For each promise-returning method on the object or class, the returned proxy
provides a method with the same name.

To create a proxy for a particular playlist, pass the playlist instance to
`TestUtils.asyncControlProxy()`.

````{admonition} Example
```js
const playlist = new Playlist();
const playlistProxy = TestUtils.asyncControlProxy(playlist);
```
````

Calling `playlistProxy.addTrack()` creates a controller for the next call to `playlist.addTrack()`.

Calling `playlistProxy.removeTrack()` creates a controller for the next call to `playlist.removeTrack()`.

```{rubric} Control the progression of an asynchronous call
:heading-level: 2
:name: control-the-progression-of-an-asynchronous-call
```

An `AsyncCallController` exposes the following methods:

* `waitForCapture()`

  Waits for the controller to capture a matching call.
  The test can then make assertions before letting the method run.

* `runCapturedCall()`

  Runs the captured call and returns a promise for its outcome without releasing that outcome to the caller.

* `releaseResultToCaller()`

  Lets the caller receive the captured call's outcome.
  Throws if invoked before a call is captured.

* `rejectCallerPromise(reason)`

  Rejects the caller's promise without running the captured call.

* `restore()`

  Cleans up the controller. See [Cleanup on scope exit](#cleanup-on-scope-exit) for what happens before and after capture.

We can use these functions to capture calls to our playlist's methods and deterministically control the flow of the test.

```{note}
Prefer instantiating a controller with
[using](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/using)
to ensure that `restore()` is automatically called at the end of the lexical scope.
```

::::{grid} 1 1 1 2
:gutter: 3

:::{grid-item}

````{admonition} Example
```js
// Create a playlist and a proxy.
const playlist = new Playlist();
const playlistProxy = TestUtils.asyncControlProxy(playlist);

// Create a controller for the next call to playlist.addTrack().
using addTrackController = playlistProxy.addTrack();

// The controller captures the call and gives the caller a pending promise.
const callerPromise = playlist.addTrack("A");

await addTrackController.waitForCapture();

// Breakpoint 1: The caller has invoked addTrack(), and the method has yet to run.
Assert.deepEqual(playlist.tracks, [], "The method has yet to start");

const result = await addTrackController.runCapturedCall();

// Breakpoint 2: The method has finished, and the caller is still waiting.
Assert.equal(result, "A");
Assert.deepEqual(playlist.tracks, ["A"], "The method has run");

// Even though the method has run to completion, the caller's promise
// will remain pending until we call releaseResultToCaller().
const nextTick = TestUtils.waitForTick().then(() => "next tick");
Assert.equal(
  await Promise.race([callerPromise, nextTick]),
  "next tick",
  "The caller is still waiting for releaseResultToCaller()"
);

// releaseResultToCaller() gives the caller its result so that it can continue.
addTrackController.releaseResultToCaller();

Assert.equal(await callerPromise, result);
```
````

:::

:::{grid-item}

```{mermaid}
:config: {"flowchart": {"rankSpacing": 60}}

flowchart TD
    accTitle: Run a captured call and release its result
    accDescr {
      The test creates a controller, then calls playlist.addTrack().
      At the first breakpoint, the playlist is still empty. At the second
      breakpoint, the method has returned track A and added it to the playlist.
      The test makes assertions at both breakpoints. The caller's promise
      stays pending until the test calls releaseResultToCaller().
    }
    Controller(["<code>using addTrackController = playlistProxy.addTrack()</code>"])
    Call(["<code>const callerPromise = playlist.addTrack(#quot;A#quot;)</code>"])
    Capture(["<b>Breakpoint 1</b><br/><code>await addTrackController.waitForCapture()</code>"])
    BeforeRun(["Make assertions"])
    Result(["<b>Breakpoint 2</b><br/><code>await addTrackController.runCapturedCall()</code>"])
    AfterRun(["Make assertions"])
    Release(["<code>addTrackController.releaseResultToCaller()</code>"])

    Controller --> Call --> Capture
    Capture --> BeforeRun --> Result --> AfterRun --> Release

    classDef highlight stroke:#b06b00,stroke-width:4px;
    class Capture,Result,Release highlight;
```

:::

::::

```{rubric} Reject the caller's promise
:heading-level: 2
:name: reject-a-captured-asynchronous-call
```

Use `rejectCallerPromise(reason)` to reject the caller's promise without running the captured call.

::::{grid} 1 1 1 2
:gutter: 3

:::{grid-item}

````{admonition} Example
```js
const playlist = new Playlist();

// Create a controller for the next call to playlist.addTrack().
using addTrackController = TestUtils.asyncControlProxy(playlist).addTrack();

// The caller receives a promise from the addTrackController instead,
// which will remain pending until we call rejectCallerPromise().
const callerPromise = playlist.addTrack("A");

// The method has yet to start when the controller captures the call.
await addTrackController.waitForCapture();
Assert.deepEqual(playlist.tracks, [], "The method has yet to start");

// rejectCallerPromise() sends the failure to the caller and skips the method.
const failure = new Error("Could not save track A");
addTrackController.rejectCallerPromise(failure);

await Assert.rejects(callerPromise, error => error === failure);
Assert.deepEqual(playlist.tracks, [], "The method never ran");
```
````

:::

:::{grid-item}

```{mermaid}
:config: {"flowchart": {"rankSpacing": 60}}

flowchart TD
    accTitle: Reject the caller's promise
    accDescr {
      The test calls playlist.addTrack() and waits for capture.
      The test checks that the playlist is empty before rejecting the call.
      The test rejects the caller's promise at the first breakpoint.
      The caller receives the rejection, and the playlist stays empty.
    }
    Call(["<code>const callerPromise = playlist.addTrack(#quot;A#quot;)</code>"])
    Capture(["<b>Breakpoint 1</b><br/><code>await addTrackController.waitForCapture()</code>"])
    BeforeReject(["Make assertions"])
    Reject(["<code>addTrackController.rejectCallerPromise(failure)</code>"])

    Call --> Capture --> BeforeReject --> Reject

    classDef highlight stroke:#b06b00,stroke-width:4px;
    class Capture,Reject highlight;
```

:::

::::

```{rubric} Capture calls at class scope
:heading-level: 2
:name: select-a-method-on-a-class
```

```{rubric} Create a proxy for a class
:heading-level: 3
:name: create-a-proxy-for-a-class
```

So far, we have passed a playlist instance to `TestUtils.asyncControlProxy()`
so that the controller captures calls on that particular playlist. We can
also create a proxy for the `Playlist` class.

Calling `playlistProxy.syncAll()` creates a controller for the next call to
the static `Playlist.syncAll()` method.

Calling `playlistProxy.sync()` creates a controller for the next call on
any playlist instance that uses `Playlist.prototype.sync`.

We can create the proxy before we have any playlist instances. Each controller
can still capture only one call, so we create a new controller for each call.

````{admonition} Example
```js
// Pass the class so that the proxy can create controllers for static and instance methods.
const playlistProxy = TestUtils.asyncControlProxy(Playlist);

// Create a controller on the proxy, then invoke the static method on Playlist.
using syncAllController = playlistProxy.syncAll();
const syncAllPromise = Playlist.syncAll();

await syncAllController.waitForCapture();
syncAllController.releaseResultToCaller();
await syncAllPromise;

for (const playlist of [new Playlist(), new Playlist()]) {
  // Create a fresh controller from the same proxy for each instance call.
  using syncController = playlistProxy.sync();
  const syncPromise = playlist.sync();

  await syncController.waitForCapture();
  syncController.releaseResultToCaller();
  await syncPromise;
}
```
````

```{rubric} When static and instance methods share a name
:heading-level: 3
:name: when-static-and-instance-methods-share-a-name
```

Suppose we rename the static `Playlist.syncAll()` method to `Playlist.sync()`.
The static method still syncs all playlists for the account, and the instance
method still syncs a single playlist.

Since both methods now have the same name, the static method takes precedence
when you pass `Playlist`, and `TestUtils.asyncControlProxy(Playlist).sync()`
creates a controller for the static method.

To disambiguate, pass `Playlist.prototype` explicitly. Calling `sync()` on that
proxy creates a controller for the next call on any playlist instance that uses
`Playlist.prototype.sync`.

````{admonition} Example
```js
class Playlist {
  static async sync() {
    // Simulate waiting for the server to sync all playlists for the account.
    await TestUtils.waitForTick();
  }

  async sync() {
    // Simulate waiting for the server to sync this playlist.
    await TestUtils.waitForTick();
  }
}

{
  // Captures the next call to the static Playlist.sync().
  using syncController = TestUtils.asyncControlProxy(Playlist).sync();
}

{
  // Captures the next call on any playlist that uses Playlist.prototype.sync.
  using syncController = TestUtils.asyncControlProxy(Playlist.prototype).sync();
}
```
````

```{rubric} Match a call by its receiver or arguments
:heading-level: 2
:name: match-a-call-by-its-receiver-or-arguments
```

There may be situations in which you may not want to capture the _very next_
call to a promise-returning method, but instead be a little more selective about
capturing a _specific_ call to a promise-returning method.

You can optionally create a controller with a predicate callback to filter
for a specific invocation of the method.

As soon as the controller is notified that its corresponding method has been called,
it invokes the predicate callback to determine if that call should be captured.

The predicate callback receives the method's `this` value as its first parameter
and an array of the call's arguments in its second parameter.

The predicate callback must synchronously return a boolean.

* A return value of `true` means that the call matches and the controller will capture the call.

* A return value of `false` means that the call does not match. The non-matching call will execute
  as it normally would, unaffected by the controller, and the controller will continue waiting for
  a matching call.

````{admonition} Example
```js
const firstPlaylist = new Playlist();
const secondPlaylist = new Playlist();

// Create a controller for Playlist.prototype.addTrack() that matches calls on secondPlaylist.
using classAddTrackController = TestUtils.asyncControlProxy(Playlist).addTrack(
  receiver => receiver === secondPlaylist
);

// "A" doesn't match, so it is added normally. The controller captures "B".
// "C" is added normally because the controller has already captured "B",
// though it wouldn't have matched regardless.
const addAPromise = firstPlaylist.addTrack("A");
const addBPromise = secondPlaylist.addTrack("B");
const addCPromise = firstPlaylist.addTrack("C");

await classAddTrackController.waitForCapture();

Assert.equal(await addAPromise, "A");
Assert.equal(await addCPromise, "C");
Assert.deepEqual(firstPlaylist.tracks, ["A", "C"]);
Assert.deepEqual(secondPlaylist.tracks, []);

classAddTrackController.releaseResultToCaller();

Assert.equal(await addBPromise, "B");
Assert.deepEqual(secondPlaylist.tracks, ["B"]);

// Match by the track argument so that we can reject the removal of "C".
using removeTrackController = TestUtils.asyncControlProxy(
  firstPlaylist
).removeTrack((_, [track]) => track === "C");

// "A" is removed normally. The controller captures the removal of "C".
const removeAPromise = firstPlaylist.removeTrack("A");
const removeCPromise = firstPlaylist.removeTrack("C");

await removeTrackController.waitForCapture();
await removeAPromise;

const failure = new Error("Could not remove track C");
removeTrackController.rejectCallerPromise(failure);

await Assert.rejects(removeCPromise, error => error === failure);
Assert.deepEqual(firstPlaylist.tracks, ["C"], "Track C stays on the playlist");
```
````

```{rubric} Additional usage details
:heading-level: 2
:name: additional-usage-details
```

```{rubric} Waiting for capture is optional
:heading-level: 3
:name: choose-whether-to-run-the-method-before-capture
```

In the earlier examples, we called `waitForCapture()` so that we could make
assertions after the caller invoked the method, but before the method ran.

If we have no reason to pause and make assertions at this stage, we can move
directly to the phase where we choose to run or reject the next captured call.

When `runCapturedCall()` is invoked before a call is captured, it will let the method
run as soon as the controller captures a matching call.

When `rejectCallerPromise(reason)` is invoked before a call is captured, it will
reject the caller's promise as soon as the controller captures a matching call.

````{admonition} Example
```js
const playlist = new Playlist();
const playlistProxy = TestUtils.asyncControlProxy(playlist);

{
  using addTrackController = playlistProxy.addTrack();

  // Let the method run as soon as the next call is captured.
  const resultPromise = addTrackController.runCapturedCall();
  const callerPromise = playlist.addTrack("A");

  Assert.equal(await resultPromise, "A");

  addTrackController.releaseResultToCaller();
  Assert.equal(await callerPromise, "A");
}

{
  using addTrackController = playlistProxy.addTrack();
  const failure = new Error("Could not save track B");

  // Supply the failure before invoking the method.
  addTrackController.rejectCallerPromise(failure);

  await Assert.rejects(playlist.addTrack("B"), error => error === failure);
  Assert.deepEqual(playlist.tracks, ["A"], "Track B was never added");
}
```
````

```{rubric} Choose whether to run or reject a call, never both
:heading-level: 3
:name: choose-whether-to-run-or-reject-a-call
```

A controller commits to running the method or rejecting the caller's promise
as soon as the test makes that choice. This applies even if the controller is
still waiting for a matching call.

* **Run the method**

  After a successful call to `runCapturedCall()` or `releaseResultToCaller()`,
  calling `rejectCallerPromise()` will throw.

* **Reject the caller's promise**

  After a successful call to `rejectCallerPromise()`, calling
  `runCapturedCall()` or `releaseResultToCaller()` will throw.

```{rubric} Cleanup on scope exit
:heading-level: 3
:name: cleanup-on-scope-exit
```

A test can leave its `using` scope while a controller is still waiting for a
call or while the caller's promise is still pending. This usually happens
only in exceptional situations when a failed assertion or an unexpected error
ends the test before it can finish using the controller.

Cleanup preserves any choice the test already made so that the caller can continue
without another operation on the controller.

* **Scope exit before capture**

  The controller stops waiting for a matching call. Any pending promises from
  `waitForCapture()` or `runCapturedCall()` reject with `AbortError`.

* **Scope exit after capture**

  If the test chose to run the method, cleanup lets the caller receive the
  method's outcome when it is ready. If the test chose to reject the caller's
  promise, cleanup preserves that rejection.

  If the test made neither choice, cleanup rejects the caller's promise with
  `AbortError` without starting the method. This avoids introducing side
  effects after a test has already failed.
