/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

const { TestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/TestUtils.sys.mjs"
);
const { PromiseTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/PromiseTestUtils.sys.mjs"
);
const { sinon } = ChromeUtils.importESModule(
  "resource://testing-common/Sinon.sys.mjs"
);

/**
 * An async operation with a configurable result and an observable input.
 */
class TestOperation {
  /** @type {string | null} */
  #lastInput = null;

  /**
   * The number of times the method has run.
   *
   * @type {number}
   */
  #callCount = 0;

  /** @type {string} */
  #value;

  /**
   * @param {string} [value="value"] - The result to return.
   */
  constructor(value = "value") {
    this.#value = value;
  }

  /**
   * The input from the most recent invocation.
   *
   * @returns {string | null}
   */
  get lastInput() {
    return this.#lastInput;
  }

  /**
   * The number of times the method has run.
   *
   * @returns {number}
   */
  get callCount() {
    return this.#callCount;
  }

  /**
   * Records the input and returns the result for this invocation.
   *
   * @param {string | null} [input=null] - The input to record.
   * @param {string} [result=this.#value] - The result to return.
   * @returns {Promise<string>}
   */
  async run(input = null, result = this.#value) {
    this.#lastInput = input;
    this.#callCount++;

    return result;
  }
}

/**
 * This test case ensures that restoring Sinon's default sandbox leaves
 * controller-owned hooks and replaced methods alone.
 */
add_task(async function test_controller_uses_a_private_sandbox() {
  const retiredOperation = new TestOperation();
  const operation = new TestOperation();
  const unrelatedOperation = new TestOperation();
  const unrelatedRun = unrelatedOperation.run;

  {
    using runController = TestUtils.asyncControlProxy(retiredOperation).run();
    runController.restore();
  }
  const replacement = async () => "replacement";
  retiredOperation.run = replacement;

  using runController = TestUtils.asyncControlProxy(operation).run();
  const stubbedRun = operation.run;
  sinon.stub(unrelatedOperation, "run").resolves("stubbed");
  sinon.restore();

  Assert.strictEqual(
    unrelatedOperation.run,
    unrelatedRun,
    "Sinon restored the method stubbed in its default sandbox"
  );
  Assert.strictEqual(
    operation.run,
    stubbedRun,
    "The controller's wrapper is still installed"
  );
  Assert.strictEqual(
    retiredOperation.run,
    replacement,
    "An old controller cannot restore over a replacement"
  );

  const result = operation.run();
  runController.releaseResultToCaller();
  Assert.equal(
    await result,
    "value",
    "The controller can still capture a call"
  );
});

/**
 * This test case ensures that awaiting or converting a proxy cannot
 * install stubs on its target.
 */
add_task(async function test_proxy_conversion_leaves_target_untouched() {
  const operation = {
    async then() {
      return "original";
    },

    async toJSON() {
      return { value: "original" };
    },
  };
  const originalProperties = Object.getOwnPropertyDescriptors(operation);
  const operationProxy = TestUtils.asyncControlProxy(operation);

  Assert.strictEqual(
    operationProxy.then,
    undefined,
    "The proxy should hide the target's then method"
  );
  Assert.strictEqual(
    await Promise.resolve(operationProxy),
    operationProxy,
    "Promise resolution should preserve the proxy"
  );
  Assert.equal(String(operationProxy), "[object AsyncControlProxy]");
  Assert.equal(operationProxy.toString(), "[object AsyncControlProxy]");
  Assert.strictEqual(operationProxy.valueOf(), operationProxy);
  Assert.equal(JSON.stringify(operationProxy), "{}");
  Assert.deepEqual(
    Object.getOwnPropertyDescriptors(operation),
    originalProperties,
    "Conversion leaves the target's own properties unchanged"
  );
});

/**
 * This test case ensures that passing a control proxy to the factory fails
 * immediately and leaves the original proxy usable.
 */
add_task(async function test_control_proxy_cannot_be_proxied_again() {
  const operation = new TestOperation();
  const operationProxy = TestUtils.asyncControlProxy(operation);

  Assert.throws(
    () => TestUtils.asyncControlProxy(operationProxy),
    error =>
      error.name === "TypeError" &&
      error.message ===
        "Cannot create an async control proxy for another async control proxy",
    "The factory rejects an existing control proxy"
  );

  using runController = operationProxy.run();
  const callerPromise = operation.run("target");
  await runController.waitForCapture();
  Assert.equal(
    operation.callCount,
    0,
    "The controller from the original proxy captures the call"
  );

  runController.releaseResultToCaller();
  Assert.equal(
    await callerPromise,
    "value",
    "The controller from the original proxy releases the result"
  );
});

/**
 * This test case ensures that a promise-returning method can be controlled
 * through the same global property its caller uses.
 */
add_task(async function test_controls_global_method() {
  const operation = new TestOperation();
  globalThis.asyncControlTestOperation = operation.run.bind(operation);

  try {
    using asyncControlTestOperationController =
      TestUtils.asyncControlProxy(globalThis).asyncControlTestOperation();
    const result = globalThis.asyncControlTestOperation("target");

    await asyncControlTestOperationController.waitForCapture();
    Assert.equal(operation.lastInput, null, "The global call should be paused");
    asyncControlTestOperationController.releaseResultToCaller();
    Assert.equal(
      await result,
      "value",
      "The global caller should get the result"
    );
  } finally {
    delete globalThis.asyncControlTestOperation;
  }
});

/**
 * This test case ensures that creating a controller for a non-function
 * property fails and leaves the target unchanged.
 */
add_task(function test_invalid_method_leaves_owner_untouched() {
  const operation = new TestOperation();
  operation.status = "ready";
  const original = operation.run;

  Assert.throws(
    () => TestUtils.asyncControlProxy(operation).status(),
    /Expected status to be a method/,
    "Creating a controller for a non-function property should throw"
  );
  Assert.strictEqual(operation.run, original, "The method should be unchanged");
  Assert.equal(operation.status, "ready", "The property should be unchanged");
});

/**
 * This test case ensures that a controller cannot leave a permanent own
 * property when the original method is inherited and non-configurable.
 */
add_task(function test_rejects_nonconfigurable_inherited_method() {
  const originalRun = TestOperation.prototype.run;
  const sealedPrototype = Object.seal({ run: originalRun });
  const frozenPrototype = Object.freeze({ run: originalRun });

  for (const prototype of [sealedPrototype, frozenPrototype]) {
    const operation = Object.create(prototype);

    Assert.throws(
      () => TestUtils.asyncControlProxy(operation).run(),
      /Cannot control inherited non-configurable method run/,
      "Creating a controller for the inherited method should throw"
    );
    Assert.ok(!Object.hasOwn(operation, "run"), "No stub should be installed");
    Assert.strictEqual(operation.run, originalRun, "The method is unchanged");
  }
});

/**
 * This test case ensures that own and inherited accessors are rejected
 * without evaluating their getters.
 */
add_task(function test_callable_accessor_cannot_be_controlled() {
  const operation = new TestOperation();
  let getterReads = 0;
  const target = {
    get run() {
      ++getterReads;
      return operation.run;
    },
  };
  const original = Object.getOwnPropertyDescriptor(target, "run");

  for (const owner of [target, Object.create(target)]) {
    Assert.throws(
      () => TestUtils.asyncControlProxy(owner).run(),
      /Cannot control accessor run/,
      "Creating a controller for the accessor should throw"
    );
  }
  Assert.equal(
    getterReads,
    0,
    "Creating a controller should leave the getter unread"
  );
  Assert.deepEqual(
    Object.getOwnPropertyDescriptor(target, "run"),
    original,
    "The accessor should be unchanged"
  );
});

/**
 * This test case ensures that the test can trigger side effects while the
 * caller is still waiting for the result.
 */
add_task(async function test_run_captured_call_holds_result() {
  const operation = new TestOperation();
  using runController = TestUtils.asyncControlProxy(operation).run();
  const callerPromise = operation.run("target");
  let callerResumed = false;

  callerPromise.then(() => {
    callerResumed = true;
  });

  await runController.waitForCapture();
  Assert.equal(operation.lastInput, null, "The operation should be paused");
  const methodResultPromise = runController.runCapturedCall();

  await TestUtils.waitForTick();
  Assert.equal(operation.lastInput, "target", "The method should run");
  Assert.ok(!callerResumed, "The caller should still be waiting for release");

  const releasedPromise = runController.releaseResultToCaller();

  Assert.strictEqual(
    releasedPromise,
    callerPromise,
    "Release should return the same promise the caller received"
  );
  Assert.equal(
    await releasedPromise,
    "value",
    "Release should deliver the result"
  );
  Assert.ok(callerResumed, "The caller should have resumed before the test");
  Assert.equal(
    await methodResultPromise,
    "value",
    "The test can read the result later"
  );
});

/**
 * This test case ensures that waiting for the result before a call arrives
 * runs the captured call without delivering its result to the caller.
 */
add_task(async function test_run_captured_call_before_capture() {
  const operation = new TestOperation();
  using runController = TestUtils.asyncControlProxy(operation).run();
  Assert.throws(
    () => runController.releaseResultToCaller(),
    /No captured call to run/,
    "Releasing before capture should throw"
  );

  const methodResultPromise = runController.runCapturedCall();
  const callerPromise = operation.run("target");
  let callerResumed = false;
  callerPromise.then(() => {
    callerResumed = true;
  });

  Assert.equal(
    await methodResultPromise,
    "value",
    "The test should receive the captured call's result"
  );
  Assert.equal(operation.lastInput, "target", "The method should run");

  await TestUtils.waitForTick();
  Assert.ok(!callerResumed, "The caller should still be waiting for release");

  runController.releaseResultToCaller();
  Assert.equal(
    await callerPromise,
    "value",
    "The caller should receive the result after release"
  );
});

/**
 * This test case ensures that two early result waits and disposal after
 * capture all use the same execution of the captured call.
 */
add_task(async function test_disposal_releases_call_with_early_result_waits() {
  const operation = new TestOperation();
  let firstResultPromise;
  let secondResultPromise;
  let callerPromise;

  {
    using runController = TestUtils.asyncControlProxy(operation).run();
    firstResultPromise = runController.runCapturedCall();
    secondResultPromise = runController.runCapturedCall();
    callerPromise = operation.run("target", "original result");

    Assert.equal(
      operation.callCount,
      0,
      "The method is paused before disposal"
    );
  }

  Assert.deepEqual(
    await Promise.all([firstResultPromise, secondResultPromise, callerPromise]),
    ["original result", "original result", "original result"],
    "Both waits and the caller receive the original result"
  );
  Assert.equal(operation.callCount, 1, "The captured call ran once");
});

/**
 * This test case ensures that a failed attempt to create a second controller
 * leaves the first controller waiting for a call.
 */
add_task(async function test_duplicate_controller_preserves_first() {
  const operation = new TestOperation();
  using runController = TestUtils.asyncControlProxy(operation).run();

  Assert.throws(
    () => TestUtils.asyncControlProxy(operation).run().restore(),
    error => error.name === "TypeError",
    "Creating a second controller for the same method should throw"
  );

  const result = operation.run();

  Assert.equal(
    await runController.runCapturedCall(),
    "value",
    "The first controller still captures the call"
  );
  runController.releaseResultToCaller();
  Assert.equal(
    await result,
    "value",
    "The first controller releases the result"
  );
});

/**
 * This test case ensures that restoring a hook leaves a replacement getter
 * untouched and allows a new controller to be created.
 */
add_task(async function test_restore_leaves_replacement_getter_alone() {
  const operation = new TestOperation();
  const operationProxy = TestUtils.asyncControlProxy(operation);
  using runController = operationProxy.run();
  const replacement = {
    configurable: true,
    get() {
      throw new Error("Cleanup should not call the replacement getter");
    },
  };
  Object.defineProperty(operation, "run", replacement);

  try {
    runController.restore();
    Assert.strictEqual(
      Object.getOwnPropertyDescriptor(operation, "run").get,
      replacement.get,
      "Restore should leave the replacement in place"
    );
  } finally {
    delete operation.run;
  }

  using nextRunController = operationProxy.run();
  const result = operation.run();
  nextRunController.releaseResultToCaller();
  Assert.equal(await result, "value", "The method can be controlled again");
});

/**
 * This test case ensures that a captured call and a saved wrapper both
 * run the original method even when the method shadows Function.prototype.apply.
 */
add_task(async function test_original_method_with_own_apply_property() {
  const operation = new TestOperation();
  operation.run = Object.assign(operation.run.bind(operation), {
    apply: undefined,
  });

  using runController = TestUtils.asyncControlProxy(operation).run();
  const savedRun = operation.run.bind(operation);
  const result = operation.run("captured call", "captured result");
  await runController.waitForCapture();

  Assert.equal(
    await savedRun("saved call", "saved result"),
    "saved result",
    "The saved wrapper runs the original method after capture"
  );

  runController.releaseResultToCaller();
  Assert.equal(
    await result,
    "captured result",
    "The controller runs the captured call when released"
  );
});

/**
 * This test case ensures that calling a saved wrapper after restore leaves
 * a newer controller waiting.
 */
add_task(async function test_stale_wrapper_preserves_new_control() {
  const operation = new TestOperation();
  using runController = TestUtils.asyncControlProxy(operation).run();
  const savedRun = operation.run.bind(operation);
  runController.restore();

  using nextRunController = TestUtils.asyncControlProxy(operation).run();
  const stubbedRun = operation.run;
  const savedResult = savedRun("saved call");
  Assert.strictEqual(
    operation.run,
    stubbedRun,
    "The new wrapper remains installed"
  );
  Assert.equal(
    operation.lastInput,
    "saved call",
    "The saved call runs normally"
  );
  Assert.equal(await savedResult, "value", "The saved call gets its result");

  const nextResult = operation.run("current call");
  nextRunController.releaseResultToCaller();
  Assert.equal(
    await nextResult,
    "value",
    "The new control can release its call"
  );
});

/**
 * This test case ensures that restoring a controller after choosing to
 * run the method delivers the original outcome to both the test and caller.
 */
add_task(async function test_result_remains_available_after_restore() {
  const originalResult = Promise.withResolvers();
  const operation = {
    run() {
      return originalResult.promise;
    },
  };
  using runController = TestUtils.asyncControlProxy(operation).run();
  const callerPromise = operation.run();
  let delivered = false;
  callerPromise.then(() => {
    delivered = true;
  });

  try {
    await runController.waitForCapture();
    runController.runCapturedCall();
    runController.restore();
    await TestUtils.waitForTick();
    Assert.ok(!delivered, "Restore should leave the original work pending");
  } finally {
    originalResult.resolve("value");
  }

  Assert.equal(
    await callerPromise,
    "value",
    "The caller should receive the result without an explicit release"
  );
  Assert.equal(
    await runController.runCapturedCall(),
    "value",
    "Restore should leave the original result available to the test"
  );
  Assert.strictEqual(
    runController.releaseResultToCaller(),
    callerPromise,
    "Release should return the same caller promise after restore"
  );
});

/**
 * This test case ensures that leaving a scope with an error cancels a
 * captured call before the method runs and preserves the original exception.
 */
add_task(async function test_disposal_aborts_a_captured_call_on_error() {
  const operation = new TestOperation();
  const failure = new Error("Failure while the call is paused");
  let callerPromise;

  await Assert.rejects(
    (async () => {
      using runController = TestUtils.asyncControlProxy(operation).run();
      callerPromise = operation.run("target");
      await runController.waitForCapture();
      throw failure;
    })(),
    error => error === failure,
    "Disposal preserves the original exception"
  );

  await Assert.rejects(
    callerPromise,
    error => error.name === "AbortError",
    "Disposal rejects the caller's promise with AbortError"
  );
  Assert.equal(operation.callCount, 0, "Disposal never starts the method");
});

/**
 * This test case ensures that repeated restore() cannot restart a canceled
 * call and that subsequent calls still run normally.
 */
add_task(async function test_cancellation_is_final_after_restore() {
  const operation = new TestOperation();
  using runController = TestUtils.asyncControlProxy(operation).run();
  const callerPromise = operation.run("canceled call");
  await runController.waitForCapture();

  runController.restore();
  runController.restore();

  await runController.waitForCapture();
  const methodResultPromise = runController.runCapturedCall();

  PromiseTestUtils.ensureDOMPromiseRejectionsProcessed();
  PromiseTestUtils.assertNoUncaughtRejections();

  let abortReason;
  await Assert.rejects(
    callerPromise,
    error => {
      abortReason = error;
      return error.name === "AbortError";
    },
    "Restore rejects the caller's promise with AbortError"
  );
  await Assert.rejects(
    methodResultPromise,
    error => error === abortReason,
    "Waiting for the result reports the caller's AbortError"
  );
  Assert.throws(
    () => runController.releaseResultToCaller(),
    error => error === abortReason,
    "Release cannot change the canceled call's outcome"
  );
  Assert.equal(operation.callCount, 0, "The canceled call never ran");

  Assert.equal(await operation.run("later call"), "value");
  Assert.equal(operation.lastInput, "later call", "Later calls run normally");
});

/**
 * This test case ensures that repeated cleanup leaves a newer controller waiting.
 */
add_task(async function test_manual_restore_is_idempotent() {
  const operation = new TestOperation();
  const original = operation.run;
  let nextRunController;

  try {
    {
      using runController = TestUtils.asyncControlProxy(operation).run();
      const methodResultPromise = runController.runCapturedCall();
      runController.restore();

      PromiseTestUtils.ensureDOMPromiseRejectionsProcessed();
      PromiseTestUtils.assertNoUncaughtRejections();

      await Assert.rejects(
        Promise.race([runController.waitForCapture(), TestUtils.waitForTick()]),
        error => error.name === "AbortError",
        "Manual restore cancels capture for later observers"
      );
      Assert.strictEqual(
        operation.run,
        original,
        "Manual restore removes the stub"
      );
      await Assert.rejects(
        methodResultPromise,
        error => error.name === "AbortError",
        "Restore cancels an outstanding result wait"
      );
      await Assert.rejects(
        runController.runCapturedCall(),
        error => error.name === "AbortError",
        "Restore cancels result waits from later observers"
      );

      nextRunController = TestUtils.asyncControlProxy(operation).run();
      runController.restore();
    }

    const result = operation.run();

    Assert.equal(
      await nextRunController.runCapturedCall(),
      "value",
      "Repeated restore and disposal should leave the newer controller waiting"
    );
    nextRunController.releaseResultToCaller();
    Assert.equal(
      await result,
      "value",
      "The newer hold should release normally"
    );
  } finally {
    nextRunController?.restore();
  }
});
