import assert from "node:assert/strict";
import { test } from "node:test";

import {
  Agent,
  AgentContext,
  BaseEndHook,
  BaseStartHook,
  CompletionCheckHook,
  LLMCompletionCheckHook,
  LoopContext,
  MaxRestartsTermination,
  PlanningHook,
  UserMessage,
  setSessionId,
  setTodoPath,
  TodoWriteTool
} from "../dist/index.js";
import { createMockClient, makeTempDir } from "./helpers.mjs";
import path from "node:path";

class ContinueOnceHook extends BaseEndHook {
  called = 0;

  async onEnd() {
    this.called += 1;
    return this.called === 1 ? "continue once" : null;
  }
}

test("PlanningHook injects a user message before the first model call", async () => {
  const client = createMockClient({ responses: ["planned"] });
  const agent = new Agent({
    name: "agent",
    instructions: "Reply.",
    modelClient: client,
    startHooks: [new PlanningHook("make a plan")]
  });

  await agent.run("task");
  const firstCall = client.receivedMessages[0];
  assert.ok(firstCall.some((msg) => msg instanceof UserMessage && msg.source === "hook" && msg.content === "make a plan"));
});

test("Start hooks run in order and skip null injections", async () => {
  class NullStartHook extends BaseStartHook {
    async onStart() {
      return null;
    }
  }

  class InjectStartHook extends BaseStartHook {
    constructor(content) {
      super();
      this.content = content;
    }

    async onStart(context) {
      context.metadata.seen = [...(context.metadata.seen ?? []), this.content];
      return this.content;
    }
  }

  const client = createMockClient({ responses: ["ok"] });
  const agent = new Agent({
    name: "agent",
    instructions: "Reply.",
    modelClient: client,
    startHooks: [new NullStartHook(), new InjectStartHook("HOOK_A"), new InjectStartHook("HOOK_B")]
  });

  await agent.run("task");
  const hookMessages = client.receivedMessages[0].filter(
    (msg) => msg instanceof UserMessage && msg.source === "hook"
  );
  assert.deepEqual(hookMessages.map((msg) => msg.content), ["HOOK_A", "HOOK_B"]);
});

test("End hooks can resume the agent loop once", async () => {
  const hook = new ContinueOnceHook();
  const client = createMockClient({ responses: ["first", "second"] });
  const agent = new Agent({
    name: "agent",
    instructions: "Reply.",
    modelClient: client,
    endHooks: [hook],
    maxIterations: 3
  });

  const response = await agent.run("task");
  assert.equal(response.messages.at(-1).content, "second");
  assert.equal(client.callCount, 2);
  assert.equal(hook.called, 2);
});

test("First end hook that injects a message wins", async () => {
  const calls = [];

  class HookA extends BaseEndHook {
    async onEnd() {
      calls.push("A");
      return "resume from A";
    }
  }

  class HookB extends BaseEndHook {
    async onEnd() {
      calls.push("B");
      return "resume from B";
    }
  }

  const client = createMockClient({ responses: ["first", "second"] });
  const agent = new Agent({
    name: "agent",
    instructions: "Reply.",
    modelClient: client,
    endHooks: [new HookA(), new HookB()],
    maxIterations: 2
  });

  await agent.run("task");
  assert.deepEqual(calls, ["A", "A"]);
  assert.equal(client.callCount, 2);
  assert.ok(
    client.receivedMessages[1].some(
      (msg) => msg instanceof UserMessage && msg.source === "hook" && msg.content === "resume from A"
    )
  );
});

test("CompletionCheckHook requests continuation for incomplete todos", async () => {
  const dir = await makeTempDir();
  setTodoPath(path.join(dir, "todos.json"));
  setSessionId("hooks");
  try {
    await new TodoWriteTool().execute({
      todos: [
        { content: "Finish", status: "pending", activeForm: "Finishing" }
      ]
    });
    const hook = new CompletionCheckHook({ maxRestarts: 2 });
    const message = await hook.onEnd({
      agentContext: {},
      llmMessages: [],
      agentName: "agent",
      iteration: 0,
      restartCount: 0,
      metadata: {}
    });
    assert.match(message, /incomplete tasks/);
  } finally {
    setTodoPath(null);
    setSessionId(null);
  }
});

test("LoopContext constructor supplies Python-style defaults", () => {
  const context = new LoopContext({
    agentContext: new AgentContext(),
    llmMessages: [],
    agentName: "agent"
  });

  assert.equal(context.iteration, 0);
  assert.equal(context.restartCount, 0);
  assert.deepEqual(context.metadata, {});
});

test("CompletionCheckHook with zero restarts never resumes", async () => {
  const dir = await makeTempDir();
  setTodoPath(path.join(dir, "todos.json"));
  setSessionId("hooks-zero");
  try {
    await new TodoWriteTool().execute({
      todos: [
        { content: "Still pending", status: "pending", activeForm: "Doing pending work" }
      ]
    });

    const client = createMockClient({ responses: ["done", "should not run"] });
    const agent = new Agent({
      name: "agent",
      instructions: "Reply.",
      modelClient: client,
      endHooks: [new CompletionCheckHook({ maxRestarts: 0 })],
      maxIterations: 3
    });

    const response = await agent.run("task");
    assert.equal(client.callCount, 1);
    assert.equal(response.messages.at(-1).content, "done");
  } finally {
    setTodoPath(null);
    setSessionId(null);
  }
});

test("LLMCompletionCheckHook returns continuation only for INCOMPLETE judgments", async () => {
  const judge = createMockClient({ responses: ["INCOMPLETE: missing verification"] });
  const hook = new LLMCompletionCheckHook({ modelClient: judge, maxRestarts: 2 });
  const message = await hook.onEnd({
    agentContext: {},
    llmMessages: [new UserMessage({ content: "Do work", source: "user" })],
    agentName: "agent",
    iteration: 0,
    restartCount: 0,
    metadata: {}
  });

  assert.match(message, /missing verification/);

  judge.setResponses(["COMPLETE: done"]);
  const complete = await hook.onEnd({
    agentContext: {},
    llmMessages: [new UserMessage({ content: "Do work", source: "user" })],
    agentName: "agent",
    iteration: 0,
    restartCount: 0,
    metadata: {}
  });
  assert.equal(complete, null);
});

test("Hook termination conditions compose with OR and AND", () => {
  const one = new MaxRestartsTermination(1);
  const two = new MaxRestartsTermination(2);
  const context = {
    agentContext: {},
    llmMessages: [],
    agentName: "agent",
    iteration: 0,
    restartCount: 1,
    metadata: {}
  };

  assert.equal(one.shouldTerminate(context), true);
  assert.equal(two.shouldTerminate(context), false);
  assert.equal(one.or(two).shouldTerminate(context), true);
  assert.equal(one.and(two).shouldTerminate(context), false);
});
