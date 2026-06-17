import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ActionResult,
  ActionType,
  Agent,
  BaseInterfaceClient,
  ComputerUseAgent,
  InterfaceState,
  MultiModalMessage,
  ToolMessage,
  UserMessage,
  createPlaywrightTools
} from "../dist/index.js";
import { collectAsync, createMockClient } from "./helpers.mjs";

class MockInterfaceClient extends BaseInterfaceClient {
  initialized = false;
  closed = false;
  actions = [];

  async initialize() {
    this.initialized = true;
  }

  async getState() {
    return new InterfaceState({
      url: "https://example.com",
      title: "Test Page",
      content: "Test page content",
      interactiveElements: [
        { tag: "button", text: "Click me", selector: "#test-button" }
      ],
      screenshot: new Uint8Array([1, 2, 3])
    });
  }

  async executeAction(action) {
    this.actions.push(action);
    return new ActionResult({
      success: true,
      description: `Executed ${action.actionType}`
    });
  }

  async getScreenshot() {
    return new Uint8Array([1, 2, 3]);
  }

  async close() {
    this.closed = true;
  }
}

test("ComputerUseAgent exposes the expected defaults and tools", () => {
  const interfaceClient = new MockInterfaceClient();
  const agent = new ComputerUseAgent({
    interfaceClient,
    modelClient: createMockClient(),
    maxActions: 2
  });

  assert.equal(agent.name, "computer_navigator");
  assert.equal(agent.description, "Agent that uses tools to interact with web interfaces");
  assert.equal(agent.interfaceClient, interfaceClient);
  assert.equal(agent.maxIterations, 2);
  assert.deepEqual(agent.tools.map((tool) => tool.name), [
    "navigate",
    "click",
    "type",
    "select",
    "press",
    "hover",
    "scroll",
    "observe_page"
  ]);
});

test("ComputerUseAgent can be used as an agent tool", () => {
  const computerAgent = new ComputerUseAgent({
    interfaceClient: new MockInterfaceClient(),
    modelClient: createMockClient(),
    maxActions: 1
  });

  const computerTool = computerAgent.asTool();
  assert.equal(computerTool.name, "computer_navigator");
  assert.match(computerTool.description, /interface/i);

  const coordinator = new Agent({
    name: "coordinator",
    description: "Coordinates other agents",
    instructions: "You coordinate tasks",
    modelClient: createMockClient(),
    tools: [computerTool]
  });

  assert.equal(coordinator.tools.length, 1);
  assert.equal(coordinator.tools[0].name, "computer_navigator");
});

test("ComputerUseAgent honors configuration options", () => {
  const agent = new ComputerUseAgent({
    interfaceClient: new MockInterfaceClient(),
    name: "custom_navigator",
    description: "Custom computer use agent",
    modelClient: createMockClient(),
    useScreenshots: false,
    maxActions: 5
  });

  assert.equal(agent.name, "custom_navigator");
  assert.equal(agent.description, "Custom computer use agent");
  assert.equal(agent.useScreenshots, false);
  assert.equal(agent.maxIterations, 5);
});

test("ComputerUseAgent initializes interface and streams screenshots", async () => {
  const interfaceClient = new MockInterfaceClient();
  const agent = new ComputerUseAgent({
    interfaceClient,
    modelClient: createMockClient({ responses: ["Mock response"] }),
    maxActions: 1
  });

  const items = await collectAsync(agent.runStream("inspect the page", { streamTokens: false }));

  assert.equal(interfaceClient.initialized, true);
  assert.ok(items[0] instanceof MultiModalMessage);
  assert.ok(items.some((item) => item instanceof UserMessage));
  assert.equal(items.at(-1).finishReason, "stop");

  await agent.close();
  assert.equal(interfaceClient.closed, true);
});

test("Playwright tools delegate actions to the interface client", async () => {
  const interfaceClient = new MockInterfaceClient();
  const tools = createPlaywrightTools(interfaceClient);
  const navigate = tools.find((tool) => tool.name === "navigate");
  const observe = tools.find((tool) => tool.name === "observe_page");

  const navigateResult = await navigate.execute({ url: "https://example.com/docs" });
  assert.equal(navigateResult.success, true);
  assert.equal(interfaceClient.actions[0].actionType, ActionType.NAVIGATE);
  assert.equal(interfaceClient.actions[0].value, "https://example.com/docs");

  const observeResult = await observe.execute({});
  assert.equal(observeResult.success, true);
  assert.match(String(observeResult.result), /Test Page/);
  assert.match(String(observeResult.result), /button: Click me/);
});

test("ComputerUseAgent captures screenshots after tool calls", async () => {
  const interfaceClient = new MockInterfaceClient();
  const toolCall = {
    toolName: "observe_page",
    parameters: {},
    callId: "call-1"
  };
  const agent = new ComputerUseAgent({
    interfaceClient,
    modelClient: createMockClient({
      responses: [
        {
          message: {
            content: "",
            source: "llm",
            role: "assistant",
            toolCalls: [toolCall]
          },
          finishReason: "tool_calls"
        },
        "done"
      ]
    }),
    maxActions: 2
  });

  const items = await collectAsync(agent.runStream("observe", { streamTokens: false }));
  const toolMessages = items.filter((item) => item instanceof ToolMessage);
  const screenshots = items.filter((item) => item instanceof MultiModalMessage);

  assert.equal(toolMessages.length, 1);
  assert.ok(screenshots.length >= 2);
  assert.equal(items.at(-1).finishReason, "stop");
});
