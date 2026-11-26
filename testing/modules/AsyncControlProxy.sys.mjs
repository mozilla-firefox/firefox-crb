/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { XPCOMUtils } from "resource://gre/modules/XPCOMUtils.sys.mjs";

const lazy = XPCOMUtils.declareLazy({
  sinon: "resource://testing-common/Sinon.sys.mjs",
});

/**
 * The proxies created by this factory, tracked by identity.
 *
 * @type {WeakSet<object>}
 */
const asyncControlProxies = new WeakSet();

/**
 * The stub targets of controllers waiting for a match, grouped by method name.
 *
 * @type {Map<string, Set<object>>}
 */
const stubTargetsByMethodName = new Map();

/**
 * Synchronously returns whether a call matches, based on its receiver
 * and a shallow copy of its arguments.
 *
 * @template {unknown[]} MethodArgs
 * @typedef {(receiver: unknown, args: [...MethodArgs]) => boolean} CallPredicate
 */

/**
 * The callable static properties of a class.
 *
 * @template {object} Owner
 * @typedef {{
 *   [MethodName in keyof Owner as Owner[MethodName] extends (...args: never[]) => unknown
 *     ? MethodName
 *     : never]: Owner[MethodName]
 * }} AsyncControlStaticMethods
 */

/**
 * The properties considered when selecting a method on an object or class.
 *
 * @template {object} Owner
 * @typedef {Owner extends abstract new (...args: never[]) => infer Instance
 *   ? AsyncControlStaticMethods<Owner> & Omit<Instance, keyof AsyncControlStaticMethods<Owner>>
 *   : Owner} AsyncControlTarget
 */

/**
 * Exposes controls for the target's named promise-returning methods.
 *
 * @template {object} Target
 * @typedef {{
 *   [MethodName in keyof Target as MethodName extends string
 *     ? MethodName extends "then" | "toJSON" | "toString" | "valueOf"
 *       ? never
 *       : Target[MethodName] extends (...args: never[]) => PromiseLike<unknown>
 *         ? MethodName
 *         : never
 *     : never]: Target[MethodName] extends (...args: infer MethodArgs) => PromiseLike<infer MethodResult>
 *       ? (predicate?: CallPredicate<MethodArgs>)
 *         => AsyncCallController<MethodName & string, MethodArgs, MethodResult>
 *       : never
 * }} AsyncControlMethods
 */

/**
 * Exposes async call controls for the selected target.
 *
 * @template {object} Owner
 * @typedef {AsyncControlMethods<AsyncControlTarget<Owner>>} AsyncControlProxy
 */

/**
 * The state needed to run a captured call and deliver its outcome.
 *
 * @template MethodResult
 * @typedef {object} CapturedCall
 * @property {PromiseWithResolvers<MethodResult>} callerResultResolvers
 *   The caller's promise and the functions that settle it.
 * @property {() => PromiseLike<MethodResult>} runOriginalMethod
 *   Invokes the original method and validates its return value.
 * @property {Promise<MethodResult> | null} methodResultPromise
 *   The captured call's outcome once the method starts.
 */

/**
 * Controls one call to a promise-returning method so that tests can exercise
 * behavior that depends on when the method runs and when its caller receives
 * the outcome.
 *
 * Invariants
 *
 * 1. One Capture
 *
 *      Each controller must capture at most one call. If the predicate for
 *      a call returns true while the controller is still waiting, the
 *      controller must capture that call. Calls that do not match must
 *      run without waiting.
 *
 *      While the controller is waiting, a predicate that throws or returns
 *      a non-boolean must stop the controller from waiting for a match.
 *      The controller must report the same failure to the caller and the test.
 *
 * 2. Exclusive Ownership
 *
 *      Controllers waiting for calls to methods of the same name must have
 *      distinct targets. Neither target may be in the other target's
 *      prototype chain.
 *
 * 3. Capture Before Execution
 *
 *      The method must still be waiting to run at capture.
 *      waitForCapture() must report capture without starting the method.
 *
 *      The caller's promise must stay pending until the controller releases,
 *      rejects, or cancels the call.
 *
 *      A successful call to rejectCallerPromise() before capture must reject
 *      the caller's promise when the matching call is captured.
 *
 * 4. One Branch
 *
 *      The first valid choice to run or reject must take effect synchronously.
 *      Once the controller commits to a branch, operations on the other
 *      branch must throw. A second rejectCallerPromise() must throw and
 *      preserve the first rejection reason.
 *
 *      The test may invoke runCapturedCall() or rejectCallerPromise() before
 *      capture to commit the controller to a branch.
 *      releaseResultToCaller() must throw before capture.
 *
 * 5. One Execution
 *
 *      On the run branch, the captured call must run at most once with its
 *      receiver and arguments. On the reject branch, the method must
 *      never run for the captured call.
 *
 * 6. Independent Delivery
 *
 *      On the run branch, the test must be able to observe the captured
 *      call's outcome while the caller's promise is pending.
 *
 *      releaseResultToCaller() must return the caller's promise and deliver
 *      the captured call's outcome. rejectCallerPromise() must reject the
 *      caller's promise with the supplied or default reason.
 *
 * 7. Cleanup Preserves the Decision
 *
 *      If the controller is still waiting for a match, restore() must abort
 *      the test's capture and result waits with AbortError.
 *
 *      After capture, restore() must deliver the outcome if the test chose
 *      to run the method, or preserve the rejection if the test chose to
 *      reject the call.
 *
 *      If the test made neither choice, restore() must reject the caller's
 *      promise with AbortError without running the method.
 *
 *      The controller must not allow a canceled call to run or change its
 *      rejection reason.
 *
 *      restore() must preserve a predicate failure already reported by
 *      the controller and be safe to repeat.
 *
 * @template {string} MethodName
 * @template {unknown[]} MethodArgs
 * @template MethodResult
 */
class AsyncCallController {
  /**
   * The object on which the stub is installed.
   *
   * @type {Record<MethodName, (...args: MethodArgs) => PromiseLike<MethodResult>>}
   */
  #stubTarget;

  /**
   * The name of the method whose calls the controller can capture.
   *
   * @type {MethodName}
   */
  #methodName;

  /**
   * Determines whether a call matches.
   *
   * @type {CallPredicate<MethodArgs>}
   */
  #predicate;

  /**
   * The original function that runs when a call proceeds.
   *
   * @type {(...args: MethodArgs) => PromiseLike<MethodResult>}
   */
  #originalMethod;

  /**
   * The stub installed while the controller waits for a call.
   *
   * @type {(((...args: MethodArgs) => PromiseLike<MethodResult>) & { restore: () => void }) | null}
   */
  #stub = null;

  /**
   * The signal that tells tests when the controller captures a matching call.
   *
   * @type {PromiseWithResolvers<void>}
   */
  #captureSignal = Promise.withResolvers();

  /**
   * Whether the matching call will run, reject, or was canceled by cleanup.
   *
   * @type {{ type: "run" } | { type: "reject", reason: unknown } | { type: "abort", reason: DOMException } | null}
   */
  #branch = null;

  /**
   * The call captured by this controller, if any.
   *
   * @type {CapturedCall<MethodResult> | null}
   */
  #capturedCall = null;

  /**
   * The predicate failure reported by later controller operations.
   *
   * @type {{ reason: unknown } | null}
   */
  #predicateFailure = null;

  /**
   * Creates a controller for the next matching call.
   *
   * @param {Record<MethodName, (...args: MethodArgs) => PromiseLike<MethodResult>>} stubTarget
   *   The object on which to install the stub.
   * @param {MethodName} methodName
   *   The name of the method whose calls the controller can capture.
   * @param {CallPredicate<MethodArgs>} [predicate=() => true]
   *   Determines whether a call matches.
   * @throws {TypeError} If the predicate is invalid or the method cannot be wrapped.
   */
  constructor(stubTarget, methodName, predicate = () => true) {
    if (typeof predicate !== "function") {
      throw new TypeError("The call predicate must be a function");
    }

    this.#stubTarget = stubTarget;
    this.#methodName = methodName;
    this.#predicate = predicate;

    const registeredTargets = this.#getStubTargetsForRegistration();
    this.#originalMethod = this.#getOriginalMethod();

    const controller = this;
    const sandbox = lazy.sinon.createSandbox();
    const stub = sandbox.stub(stubTarget, methodName).callsFake(
      /**
       * @this {unknown}
       * @param {MethodArgs} methodArgs - The arguments passed by the caller.
       * @returns {PromiseLike<MethodResult>}
       */
      function (...methodArgs) {
        return controller.#maybeCaptureCall(this, methodArgs);
      }
    );

    if (
      Object.getOwnPropertyDescriptor(stubTarget, methodName)?.value !== stub
    ) {
      throw new TypeError(`Could not wrap ${methodName} as a method`);
    }

    registeredTargets.add(stubTarget);
    stubTargetsByMethodName.set(methodName, registeredTargets);

    this.#stub = stub;
  }

  /**
   * Resolves when the controller captures a call.
   *
   * @returns {Promise<void>} Rejects with the predicate failure or with
   *   `AbortError` if the controller is restored before capture.
   */
  waitForCapture() {
    return this.#captureSignal.promise;
  }

  /**
   * Runs the captured call if needed and returns a promise for its outcome.
   *
   * If called before capture, the controller starts the method as soon as
   * it captures a matching call.
   *
   * The controller holds the outcome for the caller until release or cleanup.
   *
   * @returns {Promise<MethodResult>} Rejects if the predicate fails, the method
   *   throws or rejects, or cleanup cancels the wait or call.
   * @throws {Error} If the test chose to reject the call.
   */
  runCapturedCall() {
    if (this.#capturedCall && this.#branch?.type !== "abort") {
      return this.#startCapturedCall(this.#requireCapturedCall());
    }

    if (this.#stub) {
      // We need to choose the run branch before waiting for capture so that
      // another observer cannot reject the call first.
      this.#selectRunBranch();
    }

    let methodResultPromise;
    if (this.#branch?.type === "abort") {
      methodResultPromise = Promise.reject(this.#branch.reason);
    } else {
      methodResultPromise = this.waitForCapture().then(() =>
        this.#startCapturedCall(this.#requireCapturedCall())
      );
    }

    // The test may await the result after cancellation or failure. We need to
    // handle the rejection here while preserving it on the returned promise.
    methodResultPromise.catch(() => {});

    return methodResultPromise;
  }

  /**
   * Releases the captured call's outcome to the caller, running the call
   * if needed.
   *
   * Safe to call more than once.
   *
   * @returns {Promise<MethodResult>} The same promise the caller received.
   *   Rejects if the method throws or rejects.
   * @throws {unknown} If the predicate failed, no call has been captured,
   *   the test rejected the call, or cleanup canceled the captured call.
   */
  releaseResultToCaller() {
    const capturedCall = this.#requireCapturedCall();
    const { promise: callerPromise, resolve: resolveCallerPromise } =
      capturedCall.callerResultResolvers;

    resolveCallerPromise(this.#startCapturedCall(capturedCall));

    return callerPromise;
  }

  /**
   * Rejects the captured call, or the next matching call if still waiting.
   *
   * The method does not run.
   *
   * @param {unknown} [reason=new Error("Controlled call rejected")]
   *   The rejection reason to deliver to the caller.
   * @throws {unknown} If capture failed, the controller was restored,
   *   or the test already chose to run or reject the call.
   */
  rejectCallerPromise(reason = new Error("Controlled call rejected")) {
    const capturedCall = this.#stub ? null : this.#requireCapturedCall();

    if (this.#branch?.type === "run") {
      throw new Error(
        `Cannot reject the call to ${this.#methodName} after choosing to run it`
      );
    }

    if (this.#branch?.type === "reject") {
      throw new Error(
        `The controller already chose to reject the call to ${this.#methodName}`
      );
    }

    this.#branch = { type: "reject", reason };
    capturedCall?.callerResultResolvers.reject(reason);
  }

  /**
   * Cancels waits for an uncaptured call with `AbortError`.
   *
   * After capture, delivers the original outcome if the test chose to run
   * the method, preserves a test-injected rejection, or rejects the caller
   * with `AbortError` without running the method.
   *
   * Safe to call more than once.
   */
  restore() {
    if (this.#stub) {
      this.#removeStub();
      this.#abandonPendingCapture(
        new DOMException(
          `Control for ${this.#methodName} was restored before capture`,
          "AbortError"
        )
      );
      return;
    }

    if (!this.#capturedCall) {
      return;
    }

    if (this.#branch?.type === "run") {
      this.releaseResultToCaller();
    } else if (!this.#branch) {
      const reason = new DOMException(
        `Captured call to ${this.#methodName} was canceled by restore()`,
        "AbortError"
      );
      this.#branch = { type: "abort", reason };

      const { promise, reject } = this.#capturedCall.callerResultResolvers;
      // Cleanup can cancel a call whose caller promise the test never awaits.
      promise.catch(() => {});
      reject(reason);
    }
  }

  /**
   * Restores the control when its `using` scope exits.
   */
  [Symbol.dispose]() {
    this.restore();
  }

  /**
   * Returns the registered targets for this method, or an empty set.
   *
   * @returns {Set<object>}
   * @throws {TypeError} If a registered target overlaps this target.
   */
  #getStubTargetsForRegistration() {
    const registeredTargets =
      stubTargetsByMethodName.get(this.#methodName) ?? new Set();
    const stubTarget = this.#stubTarget;

    // A prototype stub and an instance stub can compete for the same call,
    // so we need to check for overlap before installing the stub.
    for (const registeredTarget of registeredTargets) {
      if (
        registeredTarget === stubTarget ||
        Object.prototype.isPrototypeOf.call(registeredTarget, stubTarget) ||
        Object.prototype.isPrototypeOf.call(stubTarget, registeredTarget)
      ) {
        throw new TypeError(
          `A controller for ${this.#methodName} is already waiting on an overlapping target`
        );
      }
    }

    return registeredTargets;
  }

  /**
   * Gets the original method before the stub is installed.
   *
   * @returns {(...args: MethodArgs) => PromiseLike<MethodResult>}
   * @throws {TypeError} If the property is missing, is an accessor, is
   *   noncallable, or is inherited and non-configurable.
   */
  #getOriginalMethod() {
    const methodName = this.#methodName;
    let descriptor;

    // We need to inspect the property descriptors to avoid invoking a getter
    // when creating the controller.
    for (
      let target = this.#stubTarget;
      target;
      target = Object.getPrototypeOf(target)
    ) {
      descriptor = Object.getOwnPropertyDescriptor(target, methodName);
      if (descriptor) {
        break;
      }
    }

    // We could support getters that return promises in the future, but I don't see an immediate need
    // for it, and I'd keep things simpler to start.
    if (descriptor && !Object.hasOwn(descriptor, "value")) {
      throw new TypeError(`Cannot control accessor ${methodName}`);
    }

    const originalMethod = descriptor?.value;
    if (typeof originalMethod !== "function") {
      throw new TypeError(`Expected ${methodName} to be a method`);
    }

    // Sinon copies the inherited descriptor onto the target. We need to
    // reject non-configurable descriptors because restore() cannot delete
    // a non-configurable stub.
    if (
      descriptor?.configurable === false &&
      !Object.hasOwn(this.#stubTarget, methodName)
    ) {
      throw new TypeError(
        `Cannot control inherited non-configurable method ${methodName}`
      );
    }

    return originalMethod;
  }

  /**
   * Stops waiting for a call and removes the stub if it is still installed.
   *
   * @throws {Error} If the controller has no active stub.
   */
  #removeStub() {
    if (!this.#stub) {
      throw new Error(`No active stub for ${this.#methodName}`);
    }

    const descriptor = Object.getOwnPropertyDescriptor(
      this.#stubTarget,
      this.#methodName
    );

    // A test may have replaced the stub, so we need to leave the replacement in place.
    if (descriptor?.value === this.#stub) {
      this.#stub.restore();
    }

    this.#stub = null;

    const registeredTargets = stubTargetsByMethodName.get(this.#methodName);
    if (
      registeredTargets?.delete(this.#stubTarget) &&
      !registeredTargets.size
    ) {
      stubTargetsByMethodName.delete(this.#methodName);
    }
  }

  /**
   * Evaluates the predicate and captures the call if it matches while the
   * controller is still waiting.
   *
   * @param {unknown} receiver - The receiver of the call.
   * @param {MethodArgs} methodArgs - The arguments passed by the caller.
   * @returns {PromiseLike<MethodResult>}
   */
  #maybeCaptureCall(receiver, methodArgs) {
    // We need to use Reflect.apply() because the original method can define
    // its own apply property.
    const callOriginalMethod = () =>
      Reflect.apply(this.#originalMethod, receiver, methodArgs);

    // A caller can keep a reference to this wrapper, so we need to let the
    // original method run if the stub has already been removed.
    if (!this.#stub) {
      return callOriginalMethod();
    }

    const predicate = this.#predicate;
    /**
     * @type {unknown}
     */
    let predicateResult;

    try {
      predicateResult = predicate(receiver, [...methodArgs]);
    } catch (reason) {
      return this.#handlePredicateFailure(reason, callOriginalMethod);
    }

    // If the predicate returned a promise by mistake, we need to handle its
    // rejection separately from the error we report for the invalid result.
    if (
      typeof predicateResult === "object" &&
      predicateResult !== null &&
      ChromeUtils.getClassName(predicateResult) === "Promise"
    ) {
      try {
        Promise.prototype.then.call(predicateResult, undefined, () => {});
      } catch {
        // A Promise subclass can throw when then() reads Symbol.species.
        // We still need to report the invalid predicate result.
      }
    }

    return this.#applyPredicateResult(predicateResult, callOriginalMethod);
  }

  /**
   * Captures a matching call, lets the call proceed, or reports an invalid
   * predicate result.
   *
   * @param {unknown} predicateResult - The value returned by the predicate.
   * @param {() => PromiseLike<MethodResult>} callOriginalMethod - Runs the original method.
   * @returns {PromiseLike<MethodResult>}
   */
  #applyPredicateResult(predicateResult, callOriginalMethod) {
    // The predicate can invoke the method again, and the controller can
    // capture that nested call before the outer predicate returns. We need
    // to check that the controller is still waiting before using the result.
    if (!this.#stub || predicateResult === false) {
      return callOriginalMethod();
    }

    if (predicateResult !== true) {
      const failure = new TypeError(
        `The call predicate for ${this.#methodName} must return a boolean`
      );

      return this.#handlePredicateFailure(failure, callOriginalMethod);
    }

    this.#removeStub();
    this.#capturedCall = {
      callerResultResolvers: Promise.withResolvers(),
      runOriginalMethod: () => this.#invokeOriginalMethod(callOriginalMethod),
      methodResultPromise: null,
    };
    this.#captureSignal.resolve();

    if (this.#branch?.type === "reject") {
      this.#capturedCall.callerResultResolvers.reject(this.#branch.reason);
    }

    return this.#capturedCall.callerResultResolvers.promise;
  }

  /**
   * Runs the original method and checks that it returns a promise-like value.
   *
   * @param {() => PromiseLike<MethodResult>} callOriginalMethod - Runs the original method.
   * @returns {PromiseLike<MethodResult>}
   * @throws {TypeError} If the original method returns a non-awaitable value.
   */
  #invokeOriginalMethod(callOriginalMethod) {
    const originalResult = callOriginalMethod();
    const originalThen = originalResult?.then;

    if (typeof originalThen !== "function") {
      throw new TypeError(`${this.#methodName} must return a promise`);
    }

    // The method can return a thenable with a `then` getter instead of a
    // native promise. Returning `originalResult` directly would make JavaScript
    // read `then` again when settling the promise, so we need to reuse the
    // function we already read to ensure the getter runs only once.
    return {
      then(resolve, reject) {
        return Reflect.apply(originalThen, originalResult, [resolve, reject]);
      },
    };
  }

  /**
   * Reports a predicate failure while the controller is waiting for a match.
   *
   * @param {unknown} reason - The predicate failure.
   * @param {() => PromiseLike<MethodResult>} callOriginalMethod - Runs the original method.
   * @returns {PromiseLike<MethodResult>}
   */
  #handlePredicateFailure(reason, callOriginalMethod) {
    if (!this.#stub) {
      return callOriginalMethod();
    }

    this.#removeStub();
    // We need to record the failure even when the rejection reason is undefined.
    this.#predicateFailure = { reason };
    this.#abandonPendingCapture(reason);

    return Promise.reject(reason);
  }

  /**
   * Clears any decision made before capture and rejects the capture wait.
   *
   * @param {unknown} reason - Why capture could not happen.
   * @throws {Error} If a call was already captured.
   */
  #abandonPendingCapture(reason) {
    if (this.#capturedCall) {
      throw new Error("Cannot abandon capture after a call was captured");
    }

    // A branch chosen before capture has no call to act on if capture fails.
    this.#branch = null;

    // We need to handle the rejection in case the test never awaits capture.
    this.#captureSignal.promise.catch(() => {});
    this.#captureSignal.reject(reason);
  }

  /**
   * Gets the captured call required by the controller operations.
   *
   * @returns {CapturedCall<MethodResult>}
   * @throws {unknown} If the predicate failed, no call has been captured,
   *   or cleanup canceled the captured call.
   */
  #requireCapturedCall() {
    if (this.#predicateFailure) {
      throw this.#predicateFailure.reason;
    }

    if (!this.#capturedCall) {
      throw new Error(`No captured call to ${this.#methodName}`);
    }

    if (this.#branch?.type === "abort") {
      throw this.#branch.reason;
    }

    return this.#capturedCall;
  }

  /**
   * Commits the controller to running the matching call.
   *
   * @throws {Error} If the test already rejected the call.
   */
  #selectRunBranch() {
    if (this.#branch?.type === "reject") {
      throw new Error(
        `The controller already chose to reject the call to ${this.#methodName}`
      );
    }

    this.#branch ??= { type: "run" };
  }

  /**
   * Runs the captured call once and returns its outcome.
   *
   * @param {CapturedCall<MethodResult>} capturedCall
   *   The captured call to run.
   * @returns {Promise<MethodResult>}
   * @throws {Error} If the test rejected the call.
   */
  #startCapturedCall(capturedCall) {
    this.#selectRunBranch();

    if (!capturedCall.methodResultPromise) {
      capturedCall.methodResultPromise = Promise.resolve().then(
        capturedCall.runOriginalMethod
      );

      // We need to handle the rejection here in case the method rejects before the
      // test waits for the result or releases it.
      capturedCall.methodResultPromise.catch(() => {});
    }

    return capturedCall.methodResultPromise;
  }
}

/**
 * Gets the object on which to install the stub.
 *
 * A callable static method takes precedence over a same-named instance
 * method.
 *
 * If a static accessor uses that name, pass the prototype directly to create
 * a controller for the instance method.
 *
 * @param {object} owner - The object or class to control.
 * @param {string} methodName - The name of the method to select.
 * @returns {object} The target on which to install the stub.
 */
function getStubTarget(owner, methodName) {
  if (typeof owner !== "function" || !owner.prototype) {
    return owner;
  }

  const prototype = owner.prototype;

  for (
    let candidate = owner;
    // We need to stop at Function.prototype, which has no own `prototype`
    // property. Otherwise its built-in `call` could hide an instance method
    // with the same name.
    typeof candidate === "function" && Object.hasOwn(candidate, "prototype");
    candidate = Object.getPrototypeOf(candidate)
  ) {
    const descriptor = Object.getOwnPropertyDescriptor(candidate, methodName);
    if (descriptor) {
      // TypeScript can see a callable getter as a static method, so we need
      // to reject the accessor before creating a controller for the instance method.
      const isAccessor = !Object.hasOwn(descriptor, "value");

      return isAccessor || typeof descriptor.value === "function"
        ? owner
        : prototype;
    }
  }

  return prototype;
}

/**
 * Creates a proxy for controlling methods on the selected target.
 *
 * @template {object} Owner
 * @param {Owner} owner - The object or class to control.
 * @returns {AsyncControlProxy<Owner>}
 * @throws {TypeError} If the owner is an async control proxy.
 */
export function asyncControlProxy(owner) {
  if (asyncControlProxies.has(owner)) {
    throw new TypeError(
      "Cannot create an async control proxy for another async control proxy"
    );
  }

  const proxy = new Proxy(Object.create(null), {
    get(_target, propertyKey) {
      if (propertyKey === Symbol.toStringTag) {
        return "AsyncControlProxy";
      }

      if (propertyKey === "toString" || propertyKey === "valueOf") {
        return Object.prototype[propertyKey];
      }

      // Promise resolution and JSON serialization can call `then` and
      // `toJSON` implicitly, which could otherwise install a stub.
      if (
        typeof propertyKey !== "string" ||
        propertyKey === "then" ||
        propertyKey === "toJSON"
      ) {
        return undefined;
      }

      const stubTarget = getStubTarget(owner, propertyKey);
      if (!(propertyKey in stubTarget)) {
        return undefined;
      }

      return predicate =>
        new AsyncCallController(stubTarget, propertyKey, predicate);
    },
  });

  asyncControlProxies.add(proxy);

  return proxy;
}
