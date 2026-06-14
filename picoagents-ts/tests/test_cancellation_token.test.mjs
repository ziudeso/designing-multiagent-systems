import assert from "node:assert/strict";
import { test } from "node:test";

import { Agent, CancellationToken } from "../dist/index.js";
import { createMockClient } from "./helpers.mjs";

test("CancellationToken tracks state, invokes callbacks once, and supports removal", () => {
  const token = new CancellationToken();
  let calls = 0;
  const remove = token.addCallback(() => {
    calls += 1;
  });
  const removed = token.addCallback(() => {
    calls += 100;
  });
  removed();

  assert.equal(token.isCancelled(), false);
  token.cancel();
  token.cancel();

  assert.equal(token.isCancelled(), true);
  assert.equal(calls, 1);
  remove();
  assert.throws(() => token.throwIfCancelled(), /Operation cancelled/);
});

test("CancellationToken links to AbortController and calls late callbacks immediately", () => {
  const token = new CancellationToken();
  const controller = new AbortController();
  token.linkAbortController(controller);

  token.cancel();
  assert.equal(controller.signal.aborted, true);

  let late = false;
  token.addCallback(() => {
    late = true;
  });
  assert.equal(late, true);
});

test("Agent.run aborts before the model call when token is already cancelled", async () => {
  const token = new CancellationToken();
  token.cancel();
  const client = createMockClient({ responses: ["unreachable"] });
  const agent = new Agent({
    name: "assistant",
    instructions: "Reply.",
    modelClient: client
  });

  await assert.rejects(() => agent.run("work", { cancellationToken: token }), /Operation cancelled/);
  assert.equal(client.callCount, 0);
});
