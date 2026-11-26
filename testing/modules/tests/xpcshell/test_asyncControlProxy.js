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
   * The number of times the original method has run.
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
   * The number of times the original method has run.
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
  runController.releaseResult();
  Assert.equal(
    await result,
    "value",
    "The controller can still capture a call"
  );
});

/**
 * This test case ensures that a reusable proxy can control multiple methods and
 * that a class's static method takes precedence over an instance method.
 */
add_task(async function test_proxy_creates_multiple_controllers() {
  class Operation extends TestOperation {
    static async run() {
      return "static";
    }

    static async prepare() {
      return "prepared";
    }
  }
  const original = Operation.run;
  const operationProxy = TestUtils.asyncControlProxy(Operation);

  Assert.strictEqual(
    await Promise.resolve(operationProxy),
    operationProxy,
    "The proxy should be an ordinary value in async code"
  );
  Assert.strictEqual(
    Operation.run,
    original,
    "Creating a proxy installs no stub"
  );

  using runController = operationProxy.run();
  using prepareController = operationProxy.prepare();
  using instanceRunController = TestUtils.asyncControlProxy(
    Operation.prototype
  ).run();
  const staticResult = Operation.run();
  const prepareResult = Operation.prepare();
  const instanceResult = new Operation("instance").run();

  runController.releaseResult();
  prepareController.releaseResult();
  instanceRunController.releaseResult();

  Assert.equal(
    await staticResult,
    "static",
    "The class selects the static method"
  );
  Assert.equal(
    await prepareResult,
    "prepared",
    "The proxy can control another method"
  );
  Assert.equal(
    await instanceResult,
    "instance",
    "Passing the prototype selects the instance method"
  );
});

/**
 * This test case ensures that inherited static methods take precedence,
 * while built-in function methods leave instance methods selectable.
 */
add_task(async function test_proxy_selects_methods_declared_on_the_class() {
  class Operation {
    async call() {
      return "instance call";
    }

    async bind() {
      return "instance bind";
    }

    static async bind() {
      return "static bind";
    }
  }
  class DerivedOperation extends Operation {}
  const operationProxy = TestUtils.asyncControlProxy(DerivedOperation);
  using callController = operationProxy.call();
  using bindController = operationProxy.bind();
  const operation = new DerivedOperation();

  Assert.strictEqual(
    DerivedOperation.call,
    Function.prototype.call,
    "Creating the instance controller leaves the built-in unchanged"
  );
  const callResult = operation.call();
  const bindResult = DerivedOperation.bind();
  callController.releaseResult();
  bindController.releaseResult();

  Assert.equal(
    await callResult,
    "instance call",
    "The instance call is captured"
  );
  Assert.equal(
    await bindResult,
    "static bind",
    "The inherited static call is captured"
  );
  Assert.equal(
    await operation.bind(),
    "instance bind",
    "The instance bind is unaffected"
  );
});

/**
 * This test case ensures that noncallable class properties leave same-named
 * instance methods selectable through the class proxy.
 */
add_task(async function test_proxy_skips_noncallable_class_properties() {
  class Operation {
    static label = "static label";

    async name() {
      return "instance name";
    }

    async length() {
      return "instance length";
    }

    async label() {
      return "instance label";
    }
  }

  const operationProxy = TestUtils.asyncControlProxy(Operation);
  const operation = new Operation();
  for (const method of ["name", "length", "label"]) {
    using controller = operationProxy[method]();
    const result = operation[method]();
    controller.releaseResult();
    Assert.equal(
      await result,
      `instance ${method}`,
      "The control intercepts the instance method"
    );
  }
});

/**
 * This test case ensures that a static accessor cannot silently select a
 * same-named instance method through the class proxy.
 */
add_task(async function test_proxy_rejects_static_accessors() {
  let getterReads = 0;
  class Operation extends TestOperation {
    static get run() {
      getterReads++;

      return async () => 42;
    }
  }
  class DerivedOperation extends Operation {}

  for (const owner of [Operation, DerivedOperation]) {
    Assert.throws(
      () => TestUtils.asyncControlProxy(owner).run().restore(),
      /Cannot control accessor run/,
      "A static accessor should prevent creating a controller through the class"
    );
  }

  const operation = new DerivedOperation();
  using runController = TestUtils.asyncControlProxy(
    DerivedOperation.prototype
  ).run();
  const result = operation.run("target");

  await runController.waitForInterception();
  Assert.equal(operation.lastInput, null, "The instance call was intercepted");

  runController.releaseResult();
  Assert.equal(
    await result,
    "value",
    "The instance method remains controllable"
  );
  Assert.equal(
    getterReads,
    0,
    "Creating a controller should leave the static getter unread"
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
  await runController.waitForInterception();
  Assert.equal(
    operation.callCount,
    0,
    "The original proxy still intercepts calls"
  );

  runController.releaseResult();
  Assert.equal(
    await callerPromise,
    "value",
    "The original proxy releases the call"
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

    await asyncControlTestOperationController.waitForInterception();
    Assert.equal(operation.lastInput, null, "The global call should be paused");
    asyncControlTestOperationController.releaseResult();
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
 * This test case ensures that an invalid predicate leaves the original method
 * callable without an interceptor.
 */
add_task(async function test_invalid_predicate_leaves_method_untouched() {
  const operation = new TestOperation();
  const original = operation.run;

  Assert.throws(
    () => TestUtils.asyncControlProxy(operation).run(null),
    /The call predicate must be a function/,
    "Creating a controller with an invalid predicate should throw"
  );
  Assert.strictEqual(operation.run, original, "The method should be unchanged");
  Assert.equal(
    await operation.run(),
    "value",
    "The original method should run"
  );
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
 * This test case ensures that a control pauses the first matching invocation
 * and leaves calls with other arguments or receivers unaffected.
 */
add_task(async function test_pauses_only_the_first_matching_call() {
  const selectedOperation = new TestOperation("selected");
  const otherOperation = new TestOperation("other");
  using runController = TestUtils.asyncControlProxy(TestOperation).run(
    (receiver, [input]) => receiver === selectedOperation && input === "target"
  );
  let intercepted = false;
  runController.waitForInterception().then(() => {
    intercepted = true;
  });

  Assert.equal(
    await otherOperation.run("target"),
    "other",
    "A call on another receiver should proceed"
  );
  const skippedResult = selectedOperation.run("other");
  Assert.equal(
    selectedOperation.lastInput,
    "other",
    "A nonmatching call should run without waiting"
  );
  Assert.equal(
    await skippedResult,
    "selected",
    "A call with different arguments should proceed"
  );
  Assert.ok(
    !intercepted,
    "Non-matching calls should leave the interception signal pending"
  );

  const result = selectedOperation.run("target");
  let delivered = false;
  const delivery = result.then(value => {
    delivered = true;

    return value;
  });

  await runController.waitForInterception();
  Assert.equal(
    selectedOperation.lastInput,
    "other",
    "The matching call should pause before running the method"
  );
  Assert.equal(
    await runController.waitForResult(),
    "selected",
    "The test should see the original result before release"
  );
  Assert.equal(
    selectedOperation.lastInput,
    "target",
    "Waiting for the result runs the method"
  );
  Assert.equal(
    await selectedOperation.run("target"),
    "selected",
    "A second matching call should proceed while the first result is held"
  );
  await TestUtils.waitForTick();
  Assert.ok(!delivered, "The first result should remain held");

  runController.releaseResult();
  Assert.equal(
    await delivery,
    "selected",
    "The original result should reach the caller after release"
  );
});

/**
 * This test case ensures that a queued rejection stays pending through
 * skipped calls and is delivered only to the first matching caller.
 */
add_task(async function test_queued_rejection_skips_nonmatching_call() {
  const operation = new TestOperation();
  using runController = TestUtils.asyncControlProxy(operation).run(
    (_, [input]) => input === "match"
  );
  const reason = new Error("Matching call rejected");
  runController.rejectResult(reason);

  Assert.equal(
    await operation.run("skip", "skipped result"),
    "skipped result",
    "The skipped call gets its original result"
  );
  await Assert.rejects(
    operation.run("match"),
    error => error === reason,
    "The matching caller gets the queued rejection"
  );
  Assert.equal(operation.lastInput, "skip", "Only the skipped call ran");
  Assert.equal(operation.callCount, 1, "The matching method was never invoked");
});

/**
 * This test case ensures that a predicate failure ends a queued rejection
 * and is reported to the caller and subsequent waiters.
 */
add_task(async function test_predicate_failure_discards_queued_rejection() {
  const operation = new TestOperation();
  const failure = new Error("Predicate failed");
  using runController = TestUtils.asyncControlProxy(operation).run(() => {
    throw failure;
  });
  runController.rejectResult(new Error("Queued failure"));

  await Assert.rejects(
    operation.run("target"),
    error => error === failure,
    "The caller gets the predicate failure"
  );
  await Assert.rejects(
    runController.waitForResult(),
    error => error === failure,
    "Later waits get the predicate failure"
  );
  Assert.equal(operation.callCount, 0, "The original method never ran");
});

/**
 * This test case ensures that a predicate can change its argument array
 * without changing the arguments the original method receives.
 */
add_task(async function test_predicate_cannot_rewrite_call_arguments() {
  const operation = new TestOperation();
  using runController = TestUtils.asyncControlProxy(operation).run(
    (_, args) => {
      const [input] = args;
      args[0] = "changed by predicate";
      return input === "match";
    }
  );

  const methodResult = runController.waitForResult();
  const skippedResult = operation.run("skip", "skipped result");
  Assert.equal(
    operation.lastInput,
    "skip",
    "The skipped call receives its original input"
  );
  Assert.equal(
    await skippedResult,
    "skipped result",
    "The skipped call gets its result"
  );

  const matchedResult = operation.run("match", "matching result");
  Assert.equal(
    await methodResult,
    "matching result",
    "The test receives a result after the matching call runs"
  );
  Assert.equal(
    operation.lastInput,
    "match",
    "The original method receives the matching call's input"
  );

  runController.releaseResult();
  Assert.equal(
    await matchedResult,
    "matching result",
    "The matched call gets its result"
  );
});

/**
 * This test case ensures that a throwing predicate fails the caller and
 * every control operation with the same reason.
 */
add_task(async function test_predicate_failure_reaches_caller_and_control() {
  const reason = new Error("Predicate failed");
  const operation = new TestOperation();
  const original = operation.run;
  const isPredicateFailure = error => error === reason;

  {
    using runController = TestUtils.asyncControlProxy(operation).run(() => {
      throw reason;
    });
    const methodResult = runController.waitForResult();
    await Assert.rejects(
      operation.run("failed"),
      isPredicateFailure,
      "The caller gets the failure"
    );
    await Assert.rejects(
      runController.waitForInterception(),
      isPredicateFailure,
      "The interception signal gets the failure"
    );
    await Assert.rejects(
      methodResult,
      isPredicateFailure,
      "The result wait gets the predicate failure"
    );
    await Assert.rejects(
      runController.waitForResult(),
      isPredicateFailure,
      "A later result wait gets the same failure"
    );
    for (const method of ["start", "releaseResult", "rejectResult"]) {
      Assert.throws(
        () => runController[method](),
        isPredicateFailure,
        `${method} reports the predicate failure`
      );
    }
    runController.restore();
    runController.restore();
    await Assert.rejects(
      runController.waitForInterception(),
      isPredicateFailure,
      "Restoring preserves the predicate failure"
    );
  }

  Assert.equal(operation.callCount, 0, "The failed call never ran");
  Assert.strictEqual(
    operation.run,
    original,
    "Predicate failure restores the method"
  );
  using nextRunController = TestUtils.asyncControlProxy(operation).run();
  const nextResult = operation.run();
  nextRunController.releaseResult();
  Assert.equal(await nextResult, "value", "The method can be controlled again");
});

/**
 * This test case ensures that an invalid predicate result fails
 * the control before another call can match.
 */
add_task(async function test_invalid_predicate_result_removes_stub() {
  const thenable = {
    get then() {
      Assert.ok(false, "The controller should never read then on a thenable");
      return undefined;
    },
  };
  for (const invalidResult of ["yes", null, undefined, thenable]) {
    const operation = new TestOperation();
    using runController = TestUtils.asyncControlProxy(operation).run(
      (_, [input]) => (input === "invalid" ? invalidResult : true)
    );
    const invalidDecision = /The call predicate for run must return a boolean/;

    const invalidCall = operation.run("invalid");
    const followingCall = operation.run("following");

    await Assert.rejects(
      invalidCall,
      invalidDecision,
      "The invalid call should reject"
    );
    await Assert.rejects(
      runController.waitForInterception(),
      invalidDecision,
      "The following call should leave the interception failure intact"
    );
    Assert.equal(await followingCall, "value", "The following call should run");
    Assert.equal(
      operation.lastInput,
      "following",
      "The method should run normally"
    );
  }
});

/**
 * This test case ensures that a rejected promise returned by a predicate
 * fails the call without leaving an unhandled rejection.
 */
add_task(async function test_rejected_predicate_promise_is_invalid() {
  const operation = new TestOperation();
  using runController = TestUtils.asyncControlProxy(operation).run(() =>
    Promise.reject(new Error("Unexpected predicate rejection"))
  );
  const invalidDecision = /The call predicate for run must return a boolean/;

  await Assert.rejects(
    operation.run(),
    invalidDecision,
    "The caller gets the predicate contract error"
  );
  await Assert.rejects(
    runController.waitForInterception(),
    invalidDecision,
    "The controller gets the predicate contract error"
  );
  Assert.equal(operation.callCount, 0, "The failed call never ran");
});

/**
 * This test case ensures that a failure while observing an invalid predicate
 * promise still disarms the controller and reports the predicate error.
 */
add_task(async function test_predicate_promise_observation_failure() {
  class PredicatePromise extends Promise {
    static get [Symbol.species]() {
      throw new Error("The predicate promise cannot be observed");
    }
  }

  const operation = new TestOperation();
  const originalRun = operation.run;
  using runController = TestUtils.asyncControlProxy(operation).run(() =>
    PredicatePromise.resolve(true)
  );

  const callerPromise = operation.run();
  const [callerResult, interceptionResult] = await Promise.allSettled([
    callerPromise,
    runController.waitForInterception(),
  ]);

  Assert.equal(
    callerResult.reason?.name,
    "TypeError",
    "The caller gets a TypeError"
  );
  Assert.equal(
    callerResult.reason.message,
    "The call predicate for run must return a boolean",
    "The caller gets the predicate contract error"
  );
  Assert.strictEqual(
    interceptionResult.reason,
    callerResult.reason,
    "The controller reports the same failure"
  );
  Assert.strictEqual(operation.run, originalRun, "The method was restored");
  Assert.equal(operation.callCount, 0, "The failed call never ran");
});

/**
 * This test case ensures that an undefined predicate failure is preserved
 * after restoring the controller.
 */
add_task(async function test_undefined_predicate_failure_survives_restore() {
  const operation = new TestOperation();
  using runController = TestUtils.asyncControlProxy(operation).run(() => {
    // eslint-disable-next-line no-throw-literal -- Exercise an undefined rejection reason.
    throw undefined;
  });

  const callerPromise = operation.run();
  runController.restore();

  // Assert.rejects() cannot match an undefined reason.
  const expectedRejection = { status: "rejected", reason: undefined };
  Assert.deepEqual(
    await Promise.allSettled([
      callerPromise,
      runController.waitForResult(),
      Promise.resolve().then(() => runController.start()),
    ]),
    [expectedRejection, expectedRejection, expectedRejection],
    "The caller and the controller operations report the original reason"
  );
  Assert.equal(operation.callCount, 0, "The failed call never ran");
});

/**
 * This test case ensures that the test can trigger side effects while the
 * caller is still waiting for the result.
 */
add_task(async function test_start_runs_method_without_releasing_caller() {
  const operation = new TestOperation();
  using runController = TestUtils.asyncControlProxy(operation).run();
  const callerPromise = operation.run("target");
  let callerResumed = false;

  callerPromise.then(() => {
    callerResumed = true;
  });

  await runController.waitForInterception();
  Assert.equal(operation.lastInput, null, "The operation should be paused");
  Assert.strictEqual(
    runController.start(),
    undefined,
    "Start should return without a result promise"
  );

  await TestUtils.waitForTick();
  Assert.equal(operation.lastInput, "target", "Start should run the method");
  Assert.ok(!callerResumed, "The caller should still be waiting for release");

  const releasedPromise = runController.releaseResult();

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
});

/**
 * This test case ensures that waiting for the result before a call arrives
 * lets the original method run without delivering its result to the caller.
 */
add_task(async function test_wait_for_result_before_interception() {
  const operation = new TestOperation();
  using runController = TestUtils.asyncControlProxy(operation).run();
  Assert.throws(
    () => runController.start(),
    /No intercepted call to run/,
    "Starting before a call matches should throw"
  );
  Assert.throws(
    () => runController.releaseResult(),
    /No intercepted call to run/,
    "Releasing before a call matches should throw"
  );

  const methodResult = runController.waitForResult();
  const callerPromise = operation.run("target");
  let callerResumed = false;
  callerPromise.then(() => {
    callerResumed = true;
  });

  Assert.equal(
    await methodResult,
    "value",
    "The test should receive the original method's result"
  );
  Assert.equal(operation.lastInput, "target", "The original method should run");

  await TestUtils.waitForTick();
  Assert.ok(!callerResumed, "The caller should still be waiting for release");

  runController.releaseResult();
  Assert.equal(
    await callerPromise,
    "value",
    "The caller should receive the result after release"
  );
});

/**
 * This test case ensures that two early result waits and disposal after
 * interception all use the same execution of the original method.
 */
add_task(async function test_disposal_releases_call_with_early_result_waits() {
  const operation = new TestOperation();
  let firstResultPromise;
  let secondResultPromise;
  let callerPromise;

  {
    using runController = TestUtils.asyncControlProxy(operation).run();
    firstResultPromise = runController.waitForResult();
    secondResultPromise = runController.waitForResult();
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
  Assert.equal(operation.callCount, 1, "The original method ran once");
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
    await runController.waitForResult(),
    "value",
    "The first controller still intercepts the call"
  );
  runController.releaseResult();
  Assert.equal(
    await result,
    "value",
    "The first controller releases the result"
  );
});

/**
 * This test case ensures that instance controllers can wait independently and
 * that a prototype controller can be created once both calls are intercepted.
 */
add_task(
  async function test_instance_controls_block_prototype_until_intercepted() {
    const firstOperation = new TestOperation("first");
    const secondOperation = new TestOperation("second");
    const prototypeProxy = TestUtils.asyncControlProxy(TestOperation);
    using firstRunController =
      TestUtils.asyncControlProxy(firstOperation).run();
    using secondRunController =
      TestUtils.asyncControlProxy(secondOperation).run();

    Assert.throws(
      () => prototypeProxy.run().restore(),
      /A controller for run is already waiting on an overlapping target/,
      "Creating a prototype controller fails while both instance controllers are waiting"
    );

    const firstResult = firstOperation.run("first call");
    await firstRunController.waitForInterception();
    Assert.throws(
      () => prototypeProxy.run().restore(),
      /A controller for run is already waiting on an overlapping target/,
      "The remaining instance control still blocks the prototype"
    );

    const secondResult = secondOperation.run("second call");
    await secondRunController.waitForInterception();
    using prototypeRunController = prototypeProxy.run();
    Assert.equal(
      firstOperation.lastInput,
      null,
      "The first call is still paused"
    );
    Assert.equal(
      secondOperation.lastInput,
      null,
      "The second call is still paused"
    );

    const prototypeResult = firstOperation.run("prototype call");
    await prototypeRunController.waitForInterception();
    prototypeRunController.releaseResult();
    Assert.equal(
      await prototypeResult,
      "first",
      "The prototype captures a later call"
    );
    Assert.equal(
      firstOperation.lastInput,
      "prototype call",
      "The later call runs first"
    );

    firstRunController.releaseResult();
    secondRunController.releaseResult();
    Assert.equal(
      await firstResult,
      "first",
      "The first control releases its call"
    );
    Assert.equal(
      await secondResult,
      "second",
      "The second control releases its call"
    );
    Assert.equal(
      firstOperation.lastInput,
      "first call",
      "The first call runs on release"
    );
  }
);

/**
 * This test case ensures that a prototype controller waiting for a call
 * blocks instance controllers even when its predicate excludes those instances.
 */
add_task(async function test_prototype_control_blocks_instance_controls() {
  const firstOperation = new TestOperation("first");
  const secondOperation = new TestOperation("second");
  const selectedOperation = new TestOperation("selected");
  using prototypeRunController = TestUtils.asyncControlProxy(TestOperation).run(
    receiver => receiver === selectedOperation
  );

  for (const operation of [firstOperation, secondOperation]) {
    Assert.throws(
      () => TestUtils.asyncControlProxy(operation).run().restore(),
      /A controller for run is already waiting on an overlapping target/,
      "The prototype controller blocks creation of a controller on an excluded instance"
    );
    await operation.run("unmatched");
    Assert.equal(
      operation.lastInput,
      "unmatched",
      "An excluded call runs normally"
    );
  }

  const selectedResult = selectedOperation.run("selected");
  await prototypeRunController.waitForInterception();
  using firstRunController = TestUtils.asyncControlProxy(firstOperation).run();
  using secondRunController =
    TestUtils.asyncControlProxy(secondOperation).run();
  Assert.equal(
    selectedOperation.lastInput,
    null,
    "The prototype call is still paused"
  );

  const firstResult = firstOperation.run("first call");
  const secondResult = secondOperation.run("second call");
  firstRunController.releaseResult();
  secondRunController.releaseResult();
  prototypeRunController.releaseResult();
  Assert.equal(
    await firstResult,
    "first",
    "The first instance captures its own call"
  );
  Assert.equal(
    await secondResult,
    "second",
    "The second instance captures its own call"
  );
  Assert.equal(
    await selectedResult,
    "selected",
    "The prototype still releases its call"
  );
});

/**
 * This test case ensures that restoring or disposing an unused controller
 * allows another controller to be created on an overlapping target.
 */
add_task(async function test_restore_unused_control_clears_overlap() {
  const operation = new TestOperation();
  using instanceRunController = TestUtils.asyncControlProxy(operation).run();
  instanceRunController.restore();

  {
    using prototypeRunController =
      TestUtils.asyncControlProxy(TestOperation).run();
    Assert.ok(
      prototypeRunController,
      "Restoring the instance controller lets us create a prototype controller"
    );
    instanceRunController.restore();
    Assert.throws(
      () => TestUtils.asyncControlProxy(operation).run().restore(),
      /A controller for run is already waiting on an overlapping target/,
      "Restoring the old instance leaves the prototype controller waiting"
    );
  }

  using nextRunController = TestUtils.asyncControlProxy(operation).run();
  const result = operation.run();
  nextRunController.releaseResult();
  Assert.equal(
    await result,
    "value",
    "Disposal lets us create an instance controller again"
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
  nextRunController.releaseResult();
  Assert.equal(await result, "value", "The method can be controlled again");
});

/**
 * This test case ensures that an intercepted call and a saved wrapper both
 * run the original method even when the method shadows Function.prototype.apply.
 */
add_task(async function test_original_method_with_own_apply_property() {
  const operation = new TestOperation();
  operation.run = Object.assign(operation.run.bind(operation), {
    apply: undefined,
  });

  using runController = TestUtils.asyncControlProxy(operation).run();
  const savedRun = operation.run.bind(operation);
  const result = operation.run("intercepted call", "intercepted result");
  await runController.waitForInterception();

  Assert.equal(
    await savedRun("saved call", "saved result"),
    "saved result",
    "The saved wrapper runs the original method after interception"
  );

  runController.releaseResult();
  Assert.equal(
    await result,
    "intercepted result",
    "The controller runs the original method when released"
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
  nextRunController.releaseResult();
  Assert.equal(
    await nextResult,
    "value",
    "The new control can release its call"
  );
});

/**
 * This test case ensures that a reentrant predicate cannot replace a call
 * already intercepted by the same control.
 */
add_task(async function test_reentrant_predicate_keeps_first_capture() {
  const operation = new TestOperation();
  let innerResult;
  using runController = TestUtils.asyncControlProxy(operation).run(
    (receiver, [input]) => {
      if (input === "outer") {
        innerResult = receiver.run("inner");
      }
      return true;
    }
  );

  const outerResult = operation.run("outer");
  Assert.equal(operation.lastInput, "outer", "The outer call runs normally");
  Assert.equal(
    await runController.waitForResult(),
    "value",
    "The inner call can run"
  );
  Assert.equal(operation.lastInput, "inner", "The inner call was intercepted");
  runController.releaseResult();
  Assert.equal(await innerResult, "value", "The inner caller gets its result");
  Assert.equal(await outerResult, "value", "The outer caller gets its result");
});

/**
 * This test case ensures that releasing a paused call starts the original
 * method and leaves the caller waiting for its result.
 */
add_task(async function test_release_before_original_result_settles() {
  const originalResult = Promise.withResolvers();
  let started = false;
  const operation = {
    run() {
      started = true;

      return originalResult.promise;
    },
  };
  using runController = TestUtils.asyncControlProxy(operation).run();
  const result = operation.run();
  let delivered = false;
  result.then(() => {
    delivered = true;
  });

  try {
    await runController.waitForInterception();
    runController.releaseResult();

    await TestUtils.waitForTick();
    Assert.ok(started, "Release should start the original method");
    Assert.ok(!delivered, "The caller should still be waiting for the method");
  } finally {
    originalResult.resolve("value");
  }

  Assert.equal(await result, "value", "The caller should receive the result");
  Assert.equal(
    await runController.waitForResult(),
    "value",
    "Release should leave the original result available to the test"
  );
});

/**
 * This test case ensures that restoring a controller after start() leaves the
 * original method running and delivers its outcome to both the test and caller.
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
    await runController.waitForInterception();
    runController.start();
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
    await runController.waitForResult(),
    "value",
    "Restore should leave the original result available to the test"
  );
  Assert.strictEqual(
    runController.releaseResult(),
    callerPromise,
    "Release should return the same caller promise after restore"
  );
});

/**
 * This test case ensures that the caller stays pending after the original
 * method rejects until the control's `using` scope exits.
 */
add_task(async function test_disposal_releases_a_held_rejection() {
  const failure = new Error("run failed");
  const operation = {
    async run() {
      throw failure;
    },
  };
  let delivery;

  {
    using runController = TestUtils.asyncControlProxy(operation).run();
    const methodResult = runController.waitForResult();
    const callerPromise = operation.run();
    let delivered = false;
    delivery = callerPromise.finally(() => {
      delivered = true;
    });

    await Assert.rejects(
      methodResult,
      error => error === failure,
      "The test receives the original rejection before the caller"
    );
    await TestUtils.waitForTick();
    Assert.ok(!delivered, "The rejection should remain held");
  }

  await Assert.rejects(
    delivery,
    error => error === failure,
    "The caller should receive the original rejection"
  );
});

/**
 * This test case ensures that starting a failing method keeps its rejection
 * available to the test while the caller waits for release.
 */
add_task(async function test_started_rejection_remains_available() {
  const failure = new Error("run failed");
  const originalStarted = Promise.withResolvers();
  const operation = {
    async run() {
      originalStarted.resolve();
      throw failure;
    },
  };
  using runController = TestUtils.asyncControlProxy(operation).run();
  const callerPromise = operation.run();
  let callerError;

  callerPromise.catch(error => {
    callerError = error;
  });

  await runController.waitForInterception();
  runController.start();
  await originalStarted.promise;

  PromiseTestUtils.ensureDOMPromiseRejectionsProcessed();
  PromiseTestUtils.assertNoUncaughtRejections();
  Assert.strictEqual(
    callerError,
    undefined,
    "The caller should still be waiting for the rejection"
  );

  await Assert.rejects(
    runController.waitForResult(),
    error => error === failure,
    "The test should see the original rejection before release"
  );

  const releasedPromise = runController.releaseResult();

  Assert.strictEqual(
    releasedPromise,
    callerPromise,
    "Release should return the same promise for a rejected call"
  );
  await Assert.rejects(
    releasedPromise,
    error => error === failure,
    "Awaiting release should report the original error"
  );
  Assert.strictEqual(
    callerError,
    failure,
    "The caller should receive the original rejection"
  );
});

/**
 * This test case ensures that a method which returns a plain value reports
 * the invalid return to both the test and the intercepted caller.
 */
add_task(async function test_sync_return_reports_error() {
  const operation = {
    run() {
      return "value";
    },
  };
  using runController = TestUtils.asyncControlProxy(operation).run();
  const result = operation.run();

  await runController.waitForInterception();
  await Assert.rejects(
    runController.waitForResult(),
    /run must return a promise/,
    "Waiting for the result should detect a synchronous return"
  );
  runController.releaseResult();
  await Assert.rejects(
    result,
    /run must return a promise/,
    "The caller should receive the error for the invalid return value"
  );
});

/**
 * This test case ensures that a thenable result is adopted with one read
 * of its `then` getter and with the original receiver.
 */
add_task(async function test_thenable_result_reads_then_once() {
  let thenReads = 0;
  const thenable = {
    value: "thenable value",
    get then() {
      if (++thenReads === 1) {
        return function (resolve) {
          resolve(this.value);
        };
      }
      return undefined;
    },
  };
  const operation = {
    run() {
      return thenable;
    },
  };
  using runController = TestUtils.asyncControlProxy(operation).run();
  const result = operation.run();

  await runController.waitForInterception();
  Assert.strictEqual(
    await runController.waitForResult(),
    "thenable value",
    "The test gets the value resolved by the thenable"
  );
  runController.releaseResult();
  Assert.strictEqual(
    await result,
    "thenable value",
    "The caller gets the same value"
  );
  Assert.equal(thenReads, 1, "The thenable's getter was read once");
});

/**
 * This test case ensures that a synchronous throw from the original method
 * becomes a rejection that the caller receives only after release.
 */
add_task(async function test_synchronous_throw_becomes_rejection() {
  const failure = new Error("run failed before returning a promise");
  const operation = {
    run() {
      throw failure;
    },
  };
  using runController = TestUtils.asyncControlProxy(operation).run();
  let delivered = false;
  const delivery = operation.run().finally(() => {
    delivered = true;
  });

  await runController.waitForInterception();
  await Assert.rejects(
    runController.waitForResult(),
    error => error === failure,
    "The test should receive the synchronous exception"
  );
  await TestUtils.waitForTick();
  Assert.ok(!delivered, "The caller should still be waiting for release");

  runController.releaseResult();
  await Assert.rejects(
    delivery,
    error => error === failure,
    "The caller should receive the original exception as a rejection"
  );
});

/**
 * This test case ensures that leaving a scope after an early-release error
 * removes the unused stub and cancels the interception wait.
 */
add_task(async function test_disposal_removes_an_unused_stub() {
  const operation = new TestOperation();
  const original = operation.run;
  let interception;
  Assert.throws(
    () => {
      using runController = TestUtils.asyncControlProxy(operation).run();
      interception = runController.waitForInterception();
      Assert.throws(
        () => runController.start(),
        /No intercepted call to run/,
        "Starting before a call matches should throw"
      );
      runController.releaseResult();
    },
    /No intercepted call to run/,
    "Releasing before the method is called should throw"
  );

  await Assert.rejects(
    Promise.race([interception, TestUtils.waitForTick()]),
    error => error.name === "AbortError",
    "Disposal should cancel the interception wait"
  );
  Assert.strictEqual(
    operation.run,
    original,
    "Leaving the scope with an error should remove the unused stub"
  );
  Assert.equal(
    await operation.run(),
    "value",
    "The original method should work"
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
      await runController.waitForInterception();
      throw failure;
    })(),
    error => error === failure,
    "Disposal preserves the original exception"
  );

  PromiseTestUtils.ensureDOMPromiseRejectionsProcessed();
  PromiseTestUtils.assertNoUncaughtRejections();
  await Assert.rejects(
    callerPromise,
    error => error.name === "AbortError",
    "Disposal rejects the captured caller with AbortError"
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
  await runController.waitForInterception();

  runController.restore();
  runController.restore();

  await runController.waitForInterception();
  let abortReason;
  await Assert.rejects(
    callerPromise,
    error => {
      abortReason = error;
      return error.name === "AbortError";
    },
    "Restore rejects the captured caller with AbortError"
  );
  await Assert.rejects(
    runController.waitForResult(),
    error => error === abortReason,
    "Waiting for the result reports the caller's AbortError"
  );
  for (const method of ["start", "releaseResult", "rejectResult"]) {
    Assert.throws(
      () => runController[method](),
      /AbortError: Intercepted call to run was canceled by restore\(\)/,
      `${method} cannot change the canceled call's outcome`
    );
  }
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
      const methodResult = runController.waitForResult();
      runController.restore();
      await Assert.rejects(
        Promise.race([
          runController.waitForInterception(),
          TestUtils.waitForTick(),
        ]),
        error => error.name === "AbortError",
        "Manual restore cancels interception for later observers"
      );
      Assert.strictEqual(
        operation.run,
        original,
        "Manual restore removes the stub"
      );
      await Assert.rejects(
        methodResult,
        error => error.name === "AbortError",
        "Restore cancels an outstanding result wait"
      );
      await Assert.rejects(
        runController.waitForResult(),
        error => error.name === "AbortError",
        "Restore cancels result waits from later observers"
      );

      nextRunController = TestUtils.asyncControlProxy(operation).run();
      runController.restore();
    }

    const result = operation.run();

    Assert.equal(
      await nextRunController.waitForResult(),
      "value",
      "Repeated restore and disposal should leave the newer controller waiting"
    );
    nextRunController.releaseResult();
    Assert.equal(
      await result,
      "value",
      "The newer hold should release normally"
    );
  } finally {
    nextRunController?.restore();
  }
});

/**
 * This test case ensures that an injected failure prevents the original
 * method from running, including when the control is disposed.
 */
add_task(async function test_reject_result_skips_original_method() {
  const reason = { name: "injected failure" };
  const operation = new TestOperation();
  let callerPromise;

  {
    using runController = TestUtils.asyncControlProxy(operation).run();

    for (const method of ["start", "releaseResult"]) {
      Assert.throws(
        () => runController[method](),
        /No intercepted call to run/,
        `${method} requires an intercepted call`
      );
    }

    callerPromise = operation.run("target");

    await runController.waitForInterception();
    runController.rejectResult(reason);

    Assert.throws(
      () => runController.start(),
      /The controller already chose to reject the call to run/,
      "Start should not run an intentionally rejected call"
    );
    Assert.throws(
      () => runController.waitForResult(),
      /The controller already chose to reject the call to run/,
      "Waiting for the result should not start an intentionally rejected call"
    );
    Assert.throws(
      () => runController.releaseResult(),
      /The controller already chose to reject the call to run/,
      "Release should not start an intentionally rejected call"
    );
    Assert.throws(
      () => runController.rejectResult(new Error("second reason")),
      /The controller already chose to reject the call to run/,
      "A second rejection should leave the first outcome intact"
    );
  }

  await Assert.rejects(
    callerPromise,
    error => error === reason,
    "Disposal preserves the rejection reason supplied by the test"
  );
  Assert.equal(
    operation.lastInput,
    null,
    "Rejecting and disposing should leave the method uncalled"
  );
});

/**
 * This test case ensures that an early rejection reaches only the next call
 * and that later operations cannot change the chosen branch or reason.
 */
add_task(async function test_reject_result_before_interception() {
  const operation = new TestOperation();
  using runController = TestUtils.asyncControlProxy(operation).run();
  const reason = new Error("Queued failure");
  runController.rejectResult(reason);

  Assert.throws(
    () => runController.waitForResult(),
    /The controller already chose to reject the call to run/,
    "Waiting for the result cannot change the reject branch"
  );
  Assert.throws(
    () => runController.rejectResult(new Error("Second failure")),
    /The controller already chose to reject the call to run/,
    "A second rejection cannot change the reason"
  );

  const callerPromise = operation.run("target");
  await Assert.rejects(
    callerPromise,
    error => error === reason,
    "The caller gets the queued rejection"
  );
  await runController.waitForInterception();
  Assert.equal(operation.callCount, 0, "The intercepted method never ran");
  Assert.equal(
    await operation.run("next"),
    "value",
    "Later calls run normally"
  );
});

/**
 * This test case ensures that restoring an unused controller discards its
 * queued rejection and cancels the interception and result waits.
 */
add_task(async function test_restore_discards_queued_rejection() {
  const operation = new TestOperation();
  using runController = TestUtils.asyncControlProxy(operation).run();
  const interception = runController.waitForInterception();

  runController.rejectResult();
  runController.restore();

  for (const wait of [interception, runController.waitForResult()]) {
    await Assert.rejects(
      wait,
      error => error.name === "AbortError",
      "Restoring before capture cancels the wait"
    );
  }
  Assert.throws(
    () => runController.rejectResult(),
    /No intercepted call to run/,
    "A restored controller cannot queue another rejection"
  );
  Assert.equal(
    await operation.run("target"),
    "value",
    "The original method runs"
  );
});

/**
 * This test case ensures a test can inject a failure without providing a reason.
 */
add_task(async function test_reject_result_supplies_default_error() {
  const operation = new TestOperation();
  using runController = TestUtils.asyncControlProxy(operation).run();
  runController.rejectResult();
  const result = operation.run();

  await Assert.rejects(
    result,
    error =>
      error.name === "Error" && error.message === "Controlled call rejected",
    "The caller should receive the default error"
  );
});

/**
 * This test case ensures that waiting for a result before interception
 * commits the call to running, even before the original method executes.
 */
add_task(async function test_early_result_wait_prevents_rejection() {
  const operation = new TestOperation();
  using runController = TestUtils.asyncControlProxy(operation).run();
  const methodResult = runController.waitForResult();
  Assert.throws(
    () => runController.rejectResult(),
    /Cannot reject the call to run after choosing to run it/,
    "The run branch is already chosen before capture"
  );

  const callerPromise = operation.run("target");
  const outcomes = Promise.allSettled([methodResult, callerPromise]);

  Assert.throws(
    () => runController.rejectResult(),
    /Cannot reject the call to run after choosing to run it/,
    "The test cannot reject the call after requesting its result"
  );
  Assert.equal(operation.lastInput, null, "The method has yet to run");

  runController.releaseResult();
  Assert.deepEqual(
    await outcomes,
    [
      { status: "fulfilled", value: "value" },
      { status: "fulfilled", value: "value" },
    ],
    "The test and the caller both receive the original result"
  );
});

/**
 * This test case ensures that once the real method is allowed to run, an
 * injected rejection cannot replace its outcome or restart it.
 */
add_task(async function test_reject_result_after_start_preserves_outcome() {
  for (const runOperation of ["start", "waitForResult", "releaseResult"]) {
    const operation = new TestOperation();
    using runController = TestUtils.asyncControlProxy(operation).run();
    const callerResult = operation.run();

    await runController.waitForInterception();
    runController[runOperation]();

    Assert.throws(
      () => runController.rejectResult(),
      /Cannot reject the call to run after choosing to run it/,
      `Rejecting after ${runOperation} should throw`
    );

    const result = runController.waitForResult();

    Assert.strictEqual(
      runController.waitForResult(),
      result,
      "Repeated waits should use the same promise"
    );
    runController.releaseResult();
    Assert.equal(await result, "value", "The test should see the real outcome");
    Assert.equal(
      await callerResult,
      "value",
      "The caller should receive the real outcome"
    );
    Assert.equal(
      operation.callCount,
      1,
      "The original method should run only once"
    );
  }
});
