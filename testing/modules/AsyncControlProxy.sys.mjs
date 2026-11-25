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
 * The targets registered for interception, grouped by method name.
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
 * The state needed to run an intercepted call and deliver its outcome.
 *
 * @template MethodResult
 * @typedef {object} InterceptedCall
 * @property {PromiseWithResolvers<MethodResult>} callerResultResolvers
 *   The caller's promise and the functions that settle it.
 * @property {() => PromiseLike<MethodResult>} runOriginalMethod
 *   Invokes the original method and validates its return value.
 * @property {Promise<MethodResult> | null} methodResultPromise
 *   The original method's outcome once started.
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
   * The name of the method to intercept.
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
   * The signal that tells tests when an intercepted call has been intercepted.
   *
   * @type {PromiseWithResolvers<void>}
   */
  #interceptionSignal = Promise.withResolvers();

  /**
   * Whether the matching call will run, reject, or was canceled by cleanup.
   *
   * @type {{ type: "run" } | { type: "reject", reason: unknown } | { type: "abort", reason: DOMException } | null}
   */
  #branch = null;

  /**
   * The call captured by this controller, if any.
   *
   * @type {InterceptedCall<MethodResult> | null}
   */
  #interceptedCall = null;

  /**
   * Creates a controller for the next call.
   *
   * @param {Record<MethodName, (...args: MethodArgs) => PromiseLike<MethodResult>>} stubTarget
   *   The object on which to install the stub.
   * @param {MethodName} methodName - The name of the method to intercept.
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
       * @param {MethodArgs} methodArgs - The original method arguments.
       * @returns {PromiseLike<MethodResult>}
       */
      function (...methodArgs) {
        return controller.#intercept(this, methodArgs);
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
   * Waits for an intercepted call before the original method starts.
   *
   * @returns {Promise<void>} Rejects with `AbortError` if the control
   *   is restored before a call is intercepted.
   */
  waitForInterception() {
    return this.#interceptionSignal.promise;
  }

  /**
   * Starts the original method so the test can observe its side effects
   * before releasing the result.
   * Safe to call more than once.
   *
   * @throws {unknown} If no call was intercepted, the test rejected the call,
   *   or cleanup canceled the captured call.
   */
  start() {
    this.#startOriginalMethod(this.#requireInterceptedCall());
  }

  /**
   * Waits for a matching call and starts the method if needed. Calling this
   * before interception commits the matching call to running. The caller's
   * promise stays pending until the controller releases the result.
   *
   * @returns {Promise<MethodResult>} Rejects if the method throws or rejects,
   *   or cleanup cancels the wait or call.
   * @throws {Error} If the test chose to reject the call.
   */
  waitForResult() {
    if (this.#branch?.type === "abort") {
      return Promise.reject(this.#branch.reason);
    }

    if (!this.#interceptedCall) {
      // We need to choose the run branch before waiting for interception so
      // another observer cannot reject the call first.
      this.#selectRunBranch();

      return this.waitForInterception().then(() =>
        this.#startOriginalMethod(this.#requireInterceptedCall())
      );
    }

    return this.#startOriginalMethod(this.#requireInterceptedCall());
  }

  /**
   * Releases the original method's outcome to the caller, starting the method
   * if needed. Safe to call more than once.
   *
   * @returns {Promise<MethodResult>} The same promise the caller received.
   *   Rejects if the original method throws or rejects.
   * @throws {unknown} If no call was intercepted, the test rejected the call,
   *   or cleanup canceled the captured call.
   */
  releaseResult() {
    const interceptedCall = this.#requireInterceptedCall();
    const { promise: callerPromise, resolve: resolveCallerPromise } =
      interceptedCall.callerResultResolvers;

    resolveCallerPromise(this.#startOriginalMethod(interceptedCall));

    return callerPromise;
  }

  /**
   * Rejects the intercepted call, or the next matching call if still waiting.
   * The original method does not run.
   *
   * @param {unknown} [reason=new Error("Controlled call rejected")]
   *   The rejection reason to deliver to the caller.
   * @throws {unknown} If the controller was restored or the test already chose
   *   to run or reject the call.
   */
  rejectResult(reason = new Error("Controlled call rejected")) {
    const interceptedCall = this.#stub ? null : this.#requireInterceptedCall();

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
    interceptedCall?.callerResultResolvers.reject(reason);
  }

  /**
   * Cancels waits for an uncaptured call with `AbortError`. After capture,
   * delivers the original outcome if the test chose to run the method,
   * preserves a test-injected rejection, or rejects the caller with
   * `AbortError` without running the method. Safe to call more than once.
   */
  restore() {
    if (this.#stub) {
      this.#removeStub();
      this.#rejectInterception(
        new DOMException(
          `Control for ${this.#methodName} was restored before interception`,
          "AbortError"
        )
      );
      return;
    }

    if (!this.#interceptedCall) {
      return;
    }

    if (this.#branch?.type === "run") {
      this.releaseResult();
    } else if (!this.#branch) {
      const reason = new DOMException(
        `Intercepted call to ${this.#methodName} was canceled by restore()`,
        "AbortError"
      );
      this.#branch = { type: "abort", reason };

      const { promise, reject } = this.#interceptedCall.callerResultResolvers;
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
   * Gets the registered targets for this method before adding a new target.
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
   */
  #removeStub() {
    if (!this.#stub) {
      return;
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
   * Intercepts the next call while the stub is installed.
   *
   * @param {unknown} receiver - The receiver of the original method call.
   * @param {MethodArgs} methodArgs - The original method arguments.
   * @returns {PromiseLike<MethodResult>}
   */
  #intercept(receiver, methodArgs) {
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
    this.#interceptedCall = {
      callerResultResolvers: Promise.withResolvers(),
      runOriginalMethod: () => this.#invokeOriginalMethod(callOriginalMethod),
      methodResultPromise: null,
    };
    this.#interceptionSignal.resolve();

    if (this.#branch?.type === "reject") {
      this.#interceptedCall.callerResultResolvers.reject(this.#branch.reason);
    }

    return this.#interceptedCall.callerResultResolvers.promise;
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
   * Rejects any wait for interception.
   *
   * @param {unknown} reason - Why interception could not happen.
   */
  #rejectInterception(reason) {
    // A branch chosen before capture has no call to act on if interception fails.
    this.#branch = null;

    // We need to handle the rejection in case the test never awaits interception.
    this.#interceptionSignal.promise.catch(() => {});
    this.#interceptionSignal.reject(reason);
  }

  /**
   * Gets the intercepted call required by the controller operations.
   *
   * @returns {InterceptedCall<MethodResult>}
   * @throws {unknown} If no call was intercepted or cleanup canceled the captured call.
   */
  #requireInterceptedCall() {
    if (!this.#interceptedCall) {
      throw new Error(`No intercepted call to ${this.#methodName}`);
    }

    if (this.#branch?.type === "abort") {
      throw this.#branch.reason;
    }

    return this.#interceptedCall;
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
   * Starts the original method once and returns its outcome.
   *
   * @param {InterceptedCall<MethodResult>} interceptedCall - The intercepted call to start.
   * @returns {Promise<MethodResult>}
   * @throws {Error} If the test rejected the call.
   */
  #startOriginalMethod(interceptedCall) {
    this.#selectRunBranch();

    if (!interceptedCall.methodResultPromise) {
      interceptedCall.methodResultPromise = Promise.resolve().then(
        interceptedCall.runOriginalMethod
      );

      // We need to handle the rejection here in case the method rejects before the
      // test waits for the result or releases it.
      interceptedCall.methodResultPromise.catch(() => {});
    }

    return interceptedCall.methodResultPromise;
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
