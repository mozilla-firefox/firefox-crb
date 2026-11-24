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
   * Records the input and returns this operation's result.
   *
   * @param {string | null} [input=null] - The input to record.
   * @returns {Promise<string>}
   */
  async run(input = null) {
    this.#lastInput = input;

    return this.#value;
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
  Assert.equal(
    await selectedOperation.run("other"),
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

  const skippedResult = operation.run("skip");
  Assert.equal(
    operation.lastInput,
    "skip",
    "The skipped call receives its original input"
  );
  Assert.equal(
    await skippedResult,
    "value",
    "The skipped call gets its result"
  );

  const matchedResult = operation.run("match");
  await runController.waitForInterception();
  runController.releaseResult();
  Assert.equal(
    await matchedResult,
    "value",
    "The matched call gets its result"
  );
  Assert.equal(
    operation.lastInput,
    "match",
    "The matched call receives its original input"
  );
});

/**
 * This test case ensures that an async predicate can skip a call and leave
 * the control available for a later match.
 */
add_task(async function test_async_predicate_can_skip_a_call() {
  const operation = new TestOperation();
  const skip = Promise.withResolvers();
  let thenReads = 0;
  using runController = TestUtils.asyncControlProxy(operation).run(
    (receiver, [input]) => {
      if (input === "skip") {
        return skip.promise;
      }
      return {
        get then() {
          ++thenReads;
          return resolve => resolve(receiver === operation);
        },
      };
    }
  );

  const skippedResult = operation.run("skip");
  Assert.equal(operation.lastInput, null, "The call waits for the decision");
  skip.resolve(false);
  Assert.equal(await skippedResult, "value", "The skipped call runs normally");

  const matchedResult = operation.run("match");
  await runController.waitForInterception();
  Assert.equal(thenReads, 1, "The predicate thenable is read once");
  Assert.equal(operation.lastInput, "skip", "The matched call is still paused");
  runController.releaseResult();
  Assert.equal(
    await matchedResult,
    "value",
    "The matched call gets its result"
  );
  Assert.equal(operation.lastInput, "match", "The matched call ran on release");
});

/**
 * This test case ensures that a synchronous throw from a call skipped by an
 * async predicate reaches the caller and leaves the controller waiting.
 */
add_task(async function test_async_predicate_skip_preserves_original_error() {
  const failure = new Error("Skipped call failed");
  const operation = {
    run(input) {
      if (input === "skip") {
        throw failure;
      }

      return Promise.resolve(input);
    },
  };
  using runController = TestUtils.asyncControlProxy(operation).run(
    async (_, [input]) => input === "match"
  );
  const stubbedRun = operation.run;

  await Assert.rejects(
    operation.run("skip"),
    error => error === failure,
    "The skipped caller receives the original error"
  );
  Assert.strictEqual(
    operation.run,
    stubbedRun,
    "The controller keeps waiting after the skipped call fails"
  );

  const callerPromise = operation.run("match");
  await runController.waitForInterception();
  runController.releaseResult();

  Assert.equal(await callerPromise, "match", "The next match is intercepted");
});

/**
 * This test case ensures that the first confirmed async match wins even
 * when another invocation arrived first.
 */
add_task(async function test_first_confirmed_async_match_wins() {
  const operation = new TestOperation();
  const earlierMatch = Promise.withResolvers();
  const laterMatch = Promise.withResolvers();
  using runController = TestUtils.asyncControlProxy(operation).run(
    (_, [input]) =>
      input === "earlier" ? earlierMatch.promise : laterMatch.promise
  );

  const earlierCallerPromise = operation.run("earlier");
  const laterCallerPromise = operation.run("later");
  let laterCallerResumed = false;

  laterCallerPromise.then(() => {
    laterCallerResumed = true;
  });

  laterMatch.resolve(true);
  await runController.waitForInterception();

  try {
    await TestUtils.waitForTick();
    Assert.equal(
      operation.lastInput,
      "earlier",
      "The earlier call proceeds without a decision while the later call is paused"
    );
    Assert.equal(
      await earlierCallerPromise,
      "value",
      "The earlier call gets its result"
    );

    const releasedPromise = runController.releaseResult();

    Assert.strictEqual(
      releasedPromise,
      laterCallerPromise,
      "Release returns the promise received by the winning caller"
    );
    Assert.equal(
      await releasedPromise,
      "value",
      "The winning call gets its result"
    );
    Assert.ok(
      laterCallerResumed,
      "The winning caller resumes before the test continues"
    );
    Assert.equal(operation.lastInput, "later", "The later call won the hook");
  } finally {
    earlierMatch.resolve(true);
  }
  await TestUtils.waitForTick();
  Assert.equal(
    operation.lastInput,
    "later",
    "The late match cannot rerun the earlier call"
  );
});

/**
 * This test case ensures that releasing a call matched by an async predicate
 * returns the same rejection to its caller and the test.
 */
add_task(async function test_async_predicate_release_preserves_rejection() {
  const failure = new Error("run failed");
  const operation = {
    async run() {
      throw failure;
    },
  };
  using runController = TestUtils.asyncControlProxy(operation).run(
    async () => true
  );
  const callerPromise = operation.run();
  let callerError;

  callerPromise.catch(error => {
    callerError = error;
  });

  await runController.waitForInterception();
  const releasedPromise = runController.releaseResult();

  Assert.strictEqual(
    releasedPromise,
    callerPromise,
    "Release should return the same promise the caller received"
  );
  await Assert.rejects(
    releasedPromise,
    error => error === failure,
    "Awaiting release should report the original rejection"
  );
  Assert.strictEqual(
    callerError,
    failure,
    "The caller should have handled the original rejection"
  );
});

/**
 * This test case ensures that a pending async predicate cannot delay
 * synchronous decisions or replace the capture after it is settled.
 */
add_task(async function test_sync_predicate_keeps_its_timing() {
  const operation = new TestOperation();
  const pendingDecision = Promise.withResolvers();
  using runController = TestUtils.asyncControlProxy(operation).run(
    (_, [input]) =>
      input === "pending" ? pendingDecision.promise : input === "match"
  );

  const pendingResult = operation.run("pending");
  const skippedResult = operation.run("skip");
  Assert.equal(
    operation.lastInput,
    "skip",
    "A synchronous false runs immediately"
  );

  const matchedResult = operation.run("match");
  runController.releaseResult();
  Assert.equal(
    await matchedResult,
    "value",
    "A synchronous true captures immediately"
  );
  pendingDecision.reject(new Error("Late predicate failure"));
  Assert.equal(
    await pendingResult,
    "value",
    "The older call proceeds after capture"
  );
  Assert.equal(
    await skippedResult,
    "value",
    "The skipped call gets its result"
  );
});

/**
 * This test case ensures that restoring a controller while it waits allows a
 * call with a pending predicate to proceed without disturbing a newer control.
 */
add_task(async function test_restore_while_async_match_is_pending() {
  for (const predicateOutcome of ["match", "reject"]) {
    info(
      `Restore while the predicate is pending, then make it ${predicateOutcome}`
    );

    const operation = new TestOperation();
    const pendingDecision = Promise.withResolvers();
    using runController = TestUtils.asyncControlProxy(operation).run(
      () => pendingDecision.promise
    );
    const pendingResult = operation.run("pending");
    runController.restore();
    using nextRunController = TestUtils.asyncControlProxy(operation).run();
    const nextWrapper = operation.run;

    try {
      await TestUtils.waitForTick();
      Assert.equal(
        operation.lastInput,
        "pending",
        "Restore lets the pending call run without a match decision"
      );
      Assert.equal(
        await pendingResult,
        "value",
        "The pending call gets its result"
      );
    } finally {
      if (predicateOutcome === "reject") {
        pendingDecision.reject(new Error("Predicate rejected after restore"));
      } else {
        pendingDecision.resolve(true);
      }
    }

    await TestUtils.waitForTick();
    Assert.strictEqual(
      operation.run,
      nextWrapper,
      "The newer controller's stub stays installed"
    );

    const nextResult = operation.run("next");
    nextRunController.releaseResult();
    Assert.equal(
      await nextResult,
      "value",
      "The newer control releases its call"
    );
    Assert.equal(
      operation.lastInput,
      "next",
      "The newer control captured the next call"
    );
  }
});

/**
 * This test case ensures that throwing and rejecting predicates fail the
 * caller and every control operation with the same reason.
 */
add_task(async function test_predicate_failure_reaches_caller_and_control() {
  const reason = new Error("Predicate failed");
  const malformedDecision = Promise.resolve(true);
  Object.defineProperty(malformedDecision, "constructor", {
    get() {
      throw reason;
    },
  });
  for (const predicate of [
    () => {
      throw reason;
    },
    () => Promise.reject(reason),
    () => malformedDecision,
  ]) {
    const operation = new TestOperation();
    const original = operation.run;
    const isPredicateFailure = error => error === reason;

    {
      using runController =
        TestUtils.asyncControlProxy(operation).run(predicate);
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
      for (const method of [
        "start",
        "waitForResult",
        "releaseResult",
        "rejectResult",
      ]) {
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

    Assert.equal(operation.lastInput, null, "The failed call never ran");
    Assert.strictEqual(
      operation.run,
      original,
      "Predicate failure restores the method"
    );
    using nextRunController = TestUtils.asyncControlProxy(operation).run();
    const nextResult = operation.run();
    nextRunController.releaseResult();
    Assert.equal(
      await nextResult,
      "value",
      "The method can be controlled again"
    );
  }
});

/**
 * This test case ensures that a predicate must return or resolve to a boolean.
 */
add_task(async function test_predicate_must_return_a_boolean() {
  for (const predicate of [() => "yes", () => Promise.resolve("yes")]) {
    const operation = new TestOperation();
    using runController = TestUtils.asyncControlProxy(operation).run(predicate);
    const invalidDecision = /The call predicate for run must return a boolean/;
    await Assert.rejects(
      operation.run("invalid"),
      invalidDecision,
      "The caller rejects"
    );
    await Assert.rejects(
      runController.waitForInterception(),
      invalidDecision,
      "The control rejects"
    );
    Assert.equal(
      operation.lastInput,
      null,
      "An invalid decision cannot run the call"
    );
  }
});

/**
 * This test case ensures that an invalid primitive predicate result fails
 * the control before another call can match.
 */
add_task(async function test_invalid_primitive_predicate_removes_stub() {
  for (const invalidResult of ["yes", null, undefined]) {
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
 * This test case ensures that restoring a matched hold lets the caller receive
 * a pending result and leaves the original promise available to the test.
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
    const result = operation.run();
    let delivered = false;
    delivery = result.finally(() => {
      delivered = true;
    });

    await runController.waitForInterception();
    await Assert.rejects(
      runController.waitForResult(),
      error => error === failure
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
      Assert.throws(
        () => runController.waitForResult(),
        /No intercepted call to run/,
        "Waiting for a result before a call matches should throw"
      );
      Assert.throws(
        () => runController.rejectResult(),
        /No intercepted call to run/,
        "Rejecting before a call matches should throw"
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
 * This test case ensures that leaving a scope with an error releases a
 * captured call and preserves the original exception.
 */
add_task(async function test_disposal_releases_a_captured_call_on_error() {
  const operation = new TestOperation();
  const failure = new Error("Failure while the call is paused");
  let result;

  await Assert.rejects(
    (async () => {
      using runController = TestUtils.asyncControlProxy(operation).run();
      result = operation.run("target");
      await runController.waitForInterception();
      Assert.equal(operation.lastInput, null, "The captured call is paused");
      throw failure;
    })(),
    error => error === failure,
    "Disposal preserves the original exception"
  );

  Assert.equal(await result, "value", "Disposal releases the captured call");
  Assert.equal(operation.lastInput, "target", "The original method ran");
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
      Assert.throws(
        () => runController.waitForResult(),
        /No intercepted call to run/,
        "Restoring an unused hold should leave no result promise"
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

  {
    using runController = TestUtils.asyncControlProxy(operation).run();
    const result = operation.run("target");

    await runController.waitForInterception();
    runController.rejectResult(reason);

    await Assert.rejects(
      result,
      error => error === reason,
      "The caller should receive the supplied rejection reason"
    );

    Assert.throws(
      () => runController.start(),
      /The intercepted call to run was rejected/,
      "Start should not run an intentionally rejected call"
    );
    Assert.throws(
      () => runController.waitForResult(),
      /The intercepted call to run was rejected/,
      "Waiting for the result should not start an intentionally rejected call"
    );
    Assert.throws(
      () => runController.releaseResult(),
      /The intercepted call to run was rejected/,
      "Release should not start an intentionally rejected call"
    );
    Assert.throws(
      () => runController.rejectResult(new Error("second reason")),
      /The intercepted call to run was rejected/,
      "A second rejection should leave the first outcome intact"
    );
  }

  await TestUtils.waitForTick();
  Assert.equal(
    operation.lastInput,
    null,
    "Rejecting and disposing should leave the method uncalled"
  );
});

/**
 * This test case ensures a test can inject a failure without providing a reason.
 */
add_task(async function test_reject_result_supplies_default_error() {
  const operation = new TestOperation();
  using runController = TestUtils.asyncControlProxy(operation).run();
  const result = operation.run();

  await runController.waitForInterception();
  runController.rejectResult();

  await Assert.rejects(
    result,
    error =>
      error.name === "Error" && error.message === "Controlled call rejected",
    "The caller should receive the default error"
  );
});

/**
 * This test case ensures that once the real method is allowed to run, an
 * injected rejection cannot replace its outcome or restart it.
 */
add_task(async function test_reject_result_after_start_preserves_outcome() {
  for (const start of ["start", "waitForResult", "releaseResult"]) {
    let calls = 0;
    const operation = {
      async run() {
        calls++;

        return "value";
      },
    };
    using runController = TestUtils.asyncControlProxy(operation).run();
    const callerResult = operation.run();

    await runController.waitForInterception();
    runController[start]();

    Assert.throws(
      () => runController.rejectResult(),
      /The original call to run has already started/,
      `Rejecting after ${start} should throw`
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
    Assert.equal(calls, 1, "The original method should run only once");
  }
});
