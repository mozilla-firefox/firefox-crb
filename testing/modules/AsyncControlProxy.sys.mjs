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
 * The instance properties considered when selecting a method on a class.
 *
 * @template {object} Owner
 * @typedef {Owner extends abstract new (...args: never[]) => infer Instance
 *   ? Instance
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
 *       ? () => AsyncCallController<MethodName & string, MethodArgs, MethodResult>
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
 * Controls whether a single async method call runs and what its caller receives.
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
   * The signal that tells tests when the controller captures a call.
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
   * Creates a controller for the next call.
   *
   * @param {Record<MethodName, (...args: MethodArgs) => PromiseLike<MethodResult>>} stubTarget
   *   The object on which to install the stub.
   * @param {MethodName} methodName
   *   The name of the method whose calls the controller can capture.
   * @throws {TypeError} If the method cannot be wrapped.
   */
  constructor(stubTarget, methodName) {
    this.#stubTarget = stubTarget;
    this.#methodName = methodName;

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
   * @returns {Promise<void>} Rejects with `AbortError` if the control
   *   is restored before a call is captured.
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
   * @returns {Promise<MethodResult>} Rejects if the method throws or rejects,
   *   or cleanup cancels the wait or call.
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
   * @throws {unknown} If no call was captured, the test rejected the call,
   *   or cleanup canceled the captured call.
   */
  releaseToCaller() {
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
   * @throws {unknown} If the controller was restored or the test already chose
   *   to run or reject the call.
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
      this.releaseToCaller();
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
   * Captures the next call while the stub is installed.
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
   * @throws {unknown} If no call was captured or cleanup canceled the captured call.
   */
  #requireCapturedCall() {
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
 * @param {object} owner - The object or class to control.
 * @returns {object} The target on which to install the stub.
 */
function getStubTarget(owner) {
  return typeof owner === "function" && owner.prototype
    ? owner.prototype
    : owner;
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

      const stubTarget = getStubTarget(owner);
      if (!(propertyKey in stubTarget)) {
        return undefined;
      }

      return () => new AsyncCallController(stubTarget, propertyKey);
    },
  });

  asyncControlProxies.add(proxy);

  return proxy;
}
