import { BaseTool, ToolResult } from "../../tools/index.js";
import type { JSONSchema } from "../../tools/index.js";
import {
  Action,
  ActionType,
  BaseInterfaceClient,
  InterfaceState
} from "./interfaceClients.js";

export class NavigateTool extends BaseTool {
  constructor(private readonly interfaceClient: BaseInterfaceClient) {
    super({ name: "navigate", description: "Navigate to a specific URL" });
  }

  get parameters(): JSONSchema {
    return {
      type: "object",
      properties: {
        url: { type: "string", description: "The URL to navigate to" }
      },
      required: ["url"]
    };
  }

  async execute(parameters: Record<string, unknown>): Promise<ToolResult> {
    const result = await this.interfaceClient.executeAction(new Action({
      actionType: ActionType.NAVIGATE,
      value: stringParameter(parameters, "url")
    }));
    return actionResultToToolResult(result);
  }
}

export class ClickTool extends BaseTool {
  constructor(private readonly interfaceClient: BaseInterfaceClient) {
    super({
      name: "click",
      description: "Click on an element using a CSS selector or text content"
    });
  }

  get parameters(): JSONSchema {
    return {
      type: "object",
      properties: {
        selector: {
          type: "string",
          description: "CSS selector or text content to click"
        }
      },
      required: ["selector"]
    };
  }

  async execute(parameters: Record<string, unknown>): Promise<ToolResult> {
    const result = await this.interfaceClient.executeAction(new Action({
      actionType: ActionType.CLICK,
      selector: stringParameter(parameters, "selector")
    }));
    return actionResultToToolResult(result);
  }
}

export class TypeTool extends BaseTool {
  constructor(private readonly interfaceClient: BaseInterfaceClient) {
    super({ name: "type", description: "Type text into an input element" });
  }

  get parameters(): JSONSchema {
    return {
      type: "object",
      properties: {
        selector: {
          type: "string",
          description: "CSS selector of the input element"
        },
        text: { type: "string", description: "Text to type" }
      },
      required: ["selector", "text"]
    };
  }

  async execute(parameters: Record<string, unknown>): Promise<ToolResult> {
    const result = await this.interfaceClient.executeAction(new Action({
      actionType: ActionType.TYPE,
      selector: stringParameter(parameters, "selector"),
      value: stringParameter(parameters, "text")
    }));
    return actionResultToToolResult(result);
  }
}

export class SelectTool extends BaseTool {
  constructor(private readonly interfaceClient: BaseInterfaceClient) {
    super({
      name: "select",
      description: "Select an option from a dropdown element"
    });
  }

  get parameters(): JSONSchema {
    return {
      type: "object",
      properties: {
        selector: {
          type: "string",
          description: "CSS selector of the dropdown element"
        },
        value: { type: "string", description: "Option value to select" }
      },
      required: ["selector", "value"]
    };
  }

  async execute(parameters: Record<string, unknown>): Promise<ToolResult> {
    const result = await this.interfaceClient.executeAction(new Action({
      actionType: ActionType.SELECT,
      selector: stringParameter(parameters, "selector"),
      value: stringParameter(parameters, "value")
    }));
    return actionResultToToolResult(result);
  }
}

export class PressTool extends BaseTool {
  constructor(private readonly interfaceClient: BaseInterfaceClient) {
    super({
      name: "press",
      description: "Press a key or key combination on an element"
    });
  }

  get parameters(): JSONSchema {
    return {
      type: "object",
      properties: {
        selector: {
          type: "string",
          description: "CSS selector of the element to focus"
        },
        key: {
          type: "string",
          description: "Key or key combination, for example 'Enter' or 'Control+a'"
        }
      },
      required: ["selector", "key"]
    };
  }

  async execute(parameters: Record<string, unknown>): Promise<ToolResult> {
    const result = await this.interfaceClient.executeAction(new Action({
      actionType: ActionType.PRESS,
      selector: stringParameter(parameters, "selector"),
      value: stringParameter(parameters, "key")
    }));
    return actionResultToToolResult(result);
  }
}

export class HoverTool extends BaseTool {
  constructor(private readonly interfaceClient: BaseInterfaceClient) {
    super({
      name: "hover",
      description: "Hover over an element to trigger hover effects"
    });
  }

  get parameters(): JSONSchema {
    return {
      type: "object",
      properties: {
        selector: {
          type: "string",
          description: "CSS selector of the element to hover over"
        }
      },
      required: ["selector"]
    };
  }

  async execute(parameters: Record<string, unknown>): Promise<ToolResult> {
    const result = await this.interfaceClient.executeAction(new Action({
      actionType: ActionType.HOVER,
      selector: stringParameter(parameters, "selector")
    }));
    return actionResultToToolResult(result);
  }
}

export class ScrollTool extends BaseTool {
  constructor(private readonly interfaceClient: BaseInterfaceClient) {
    super({ name: "scroll", description: "Scroll the page or an element" });
  }

  get parameters(): JSONSchema {
    return {
      type: "object",
      properties: {
        direction: {
          type: "string",
          enum: ["up", "down", "left", "right"],
          description: "Direction to scroll"
        },
        amount: {
          type: "integer",
          description: "Pixels to scroll (default: 500)"
        },
        selector: {
          type: "string",
          description: "Optional element selector to scroll (default: page)"
        }
      },
      required: ["direction"]
    };
  }

  async execute(parameters: Record<string, unknown>): Promise<ToolResult> {
    const direction = String(parameters.direction ?? "down");
    const result = await this.interfaceClient.executeAction(new Action({
      actionType: ActionType.SCROLL,
      value: direction,
      selector: parameters.selector === undefined ? undefined : String(parameters.selector)
    }));
    return new ToolResult({
      success: result.success,
      result: result.success
        ? `Scrolled ${direction} ${Number(parameters.amount ?? 500)} pixels`
        : result.description,
      error: result.error,
      metadata: result.metadata
    });
  }
}

export class ObservePageTool extends BaseTool {
  constructor(private readonly interfaceClient: BaseInterfaceClient) {
    super({
      name: "observe_page",
      description: "Get information about the current page state"
    });
  }

  get parameters(): JSONSchema {
    return { type: "object", properties: {}, required: [] };
  }

  async execute(_parameters: Record<string, unknown>): Promise<ToolResult> {
    const state = await this.interfaceClient.getState("hybrid");
    let description = `URL: ${state.url ?? ""}\n`;
    description += `Title: ${state.title ?? ""}\n`;
    description += await describePageContent(this.interfaceClient, state);
    description += `Interactive elements: ${state.interactiveElements.length} found\n`;

    if (state.interactiveElements.length) {
      description += "Key elements:\n";
      const meaningfulElements = state.interactiveElements
        .slice(0, 15)
        .filter((element) => String(element.text ?? "").trim().length > 2);
      for (const element of meaningfulElements.slice(0, 10)) {
        const text = String(element.text ?? "").trim().slice(0, 50);
        const tag = String(element.tag ?? "");
        if (text) description += `  - ${tag}: ${text}\n`;
      }
    }

    return new ToolResult({ success: true, result: description });
  }
}

export function createPlaywrightTools(interfaceClient: BaseInterfaceClient): BaseTool[] {
  return [
    new NavigateTool(interfaceClient),
    new ClickTool(interfaceClient),
    new TypeTool(interfaceClient),
    new SelectTool(interfaceClient),
    new PressTool(interfaceClient),
    new HoverTool(interfaceClient),
    new ScrollTool(interfaceClient),
    new ObservePageTool(interfaceClient)
  ];
}

function actionResultToToolResult(result: {
  success: boolean;
  description: string;
  error?: string;
  metadata?: Record<string, unknown>;
}): ToolResult {
  return new ToolResult({
    success: result.success,
    result: result.description,
    error: result.error,
    metadata: result.metadata
  });
}

async function describePageContent(
  interfaceClient: BaseInterfaceClient,
  state: InterfaceState
): Promise<string> {
  const page = (interfaceClient as { page?: any }).page;
  if (page) {
    try {
      const contentData = await page.evaluate(() => {
        const headings = Array.from(document.querySelectorAll("h1, h2, h3"))
          .slice(0, 10)
          .map((heading) => `${heading.tagName}: ${(heading as HTMLElement).innerText.trim()}`)
          .filter((heading) => heading.length > 5);

        const main = document.querySelector("article, main, [role='main']") as HTMLElement | null;
        const text = (main?.innerText ?? document.body.innerText).slice(0, 5000);
        return { headings, text };
      });

      let description = "";
      if (Array.isArray(contentData.headings) && contentData.headings.length) {
        description += "Key headings:\n";
        for (const heading of contentData.headings.slice(0, 8)) {
          description += `  ${heading}\n`;
        }
        description += "\n";
      }
      if (contentData.text) {
        description += `Page content:\n${contentData.text}\n`;
      }
      return description;
    } catch {
      try {
        const visibleText = await page.evaluate(() => document.body.innerText.slice(0, 5000));
        return `Page content: ${visibleText}\n`;
      } catch {
        // Fall through to state.content below.
      }
    }
  }

  return `Content preview: ${state.content.slice(0, 500)}...\n`;
}

function stringParameter(parameters: Record<string, unknown>, name: string): string {
  const value = parameters[name];
  if (value === undefined || value === null) {
    throw new Error(`${name} is required`);
  }
  return String(value);
}
