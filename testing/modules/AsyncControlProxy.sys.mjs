/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { XPCOMUtils } from "resource://gre/modules/XPCOMUtils.sys.mjs";

const lazy = XPCOMUtils.declareLazy({
  sinon: "resource://testing-common/Sinon.sys.mjs",
});

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
 * @typedef {AsyncControlMethods<Owner>} AsyncControlProxy
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
 * @property {boolean} rejectedByController
 *   Whether the test rejected the call before it ran.
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
   * @throws {unknown} If no call was intercepted or the test rejected the call.
   */
  start() {
    this.#startOriginalMethod(this.#requireInterceptedCall());
  }

  /**
   * Waits for the original method's outcome while the caller waits.
   * Starts the method if needed.
   *
   * @returns {Promise<MethodResult>} Rejects if the method throws or rejects.
   * @throws {unknown} If no call was intercepted or the test rejected the call.
   */
  waitForResult() {
    return this.#startOriginalMethod(this.#requireInterceptedCall());
  }

  /**
   * Releases the original method's outcome to the caller, starting the method
   * if needed. Safe to call more than once.
   *
   * @returns {Promise<MethodResult>} The same promise the caller received.
   *   Rejects if the original method throws or rejects.
   * @throws {unknown} If no call was intercepted or the test rejected the call.
   */
  releaseResult() {
    const interceptedCall = this.#requireInterceptedCall();
    const { promise: callerPromise, resolve: resolveCallerPromise } =
      interceptedCall.callerResultResolvers;

    resolveCallerPromise(this.#startOriginalMethod(interceptedCall));

    return callerPromise;
  }

  /**
   * Rejects the intercepted call so the original method never runs.
   *
   * @param {unknown} [reason=new Error("Controlled call rejected")]
   *   The rejection reason to deliver to the caller.
   * @throws {unknown} If no call was intercepted, the method
   *   already started, or the test already rejected the call.
   */
  rejectResult(reason = new Error("Controlled call rejected")) {
    const interceptedCall = this.#requireInterceptedCall();

    if (interceptedCall.methodResultPromise) {
      throw new Error(
        `The original call to ${this.#methodName} has already started`
      );
    }

    if (interceptedCall.rejectedByController) {
      throw new Error(
        `The intercepted call to ${this.#methodName} was rejected`
      );
    }

    interceptedCall.rejectedByController = true;
    interceptedCall.callerResultResolvers.reject(reason);
  }

  /**
   * Stops waiting for a call and releases any intercepted call. Safe to call more than once.
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

    if (this.#interceptedCall && !this.#interceptedCall.rejectedByController) {
      this.releaseResult();
    }
  }

  /**
   * Restores the control when its `using` scope exits.
   */
  [Symbol.dispose]() {
    this.restore();
  }

  /**
   * Gets the original method before the stub is installed.
   *
   * @returns {(...args: MethodArgs) => PromiseLike<MethodResult>}
   * @throws {TypeError} If the property is missing, an accessor, or noncallable.
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
  }

  /**
   * Intercepts the next call while the stub is installed.
   *
   * @param {unknown} receiver - The receiver of the original method call.
   * @param {MethodArgs} methodArgs - The original method arguments.
   * @returns {PromiseLike<MethodResult>}
   */
  #intercept(receiver, methodArgs) {
    const callOriginalMethod = () =>
      this.#originalMethod.apply(receiver, methodArgs);

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
      rejectedByController: false,
    };
    this.#interceptionSignal.resolve();

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
    // We need to handle the rejection in case the test never awaits interception.
    this.#interceptionSignal.promise.catch(() => {});
    this.#interceptionSignal.reject(reason);
  }

  /**
   * Gets the intercepted call required by the controller operations.
   *
   * @returns {InterceptedCall<MethodResult>}
   * @throws {unknown} If no call has been intercepted.
   */
  #requireInterceptedCall() {
    if (!this.#interceptedCall) {
      throw new Error(`No intercepted call to ${this.#methodName}`);
    }

    return this.#interceptedCall;
  }

  /**
   * Starts the original method once and returns its outcome.
   *
   * @param {InterceptedCall<MethodResult>} interceptedCall - The intercepted call to start.
   * @returns {Promise<MethodResult>}
   * @throws {Error} If the test rejected the call.
   */
  #startOriginalMethod(interceptedCall) {
    if (interceptedCall.rejectedByController) {
      throw new Error(
        `The intercepted call to ${this.#methodName} was rejected`
      );
    }

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
 * Creates a proxy for controlling methods on the selected target.
 *
 * @template {object} Owner
 * @param {Owner} owner - The object to control.
 * @returns {AsyncControlProxy<Owner>}
 */
export function asyncControlProxy(owner) {
  return new Proxy(Object.create(null), {
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

      if (!(propertyKey in owner)) {
        return undefined;
      }

      return () => new AsyncCallController(owner, propertyKey);
    },
  });
}
