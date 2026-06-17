export enum ActionType {
  CLICK = "click",
  TYPE = "type",
  SELECT = "select",
  NAVIGATE = "navigate",
  SCREENSHOT = "screenshot",
  SCROLL = "scroll",
  PRESS = "press",
  HOVER = "hover"
}

export interface ActionInit {
  actionType: ActionType;
  selector?: string;
  value?: string;
  coordinates?: Record<string, number>;
  metadata?: Record<string, unknown>;
}

export class Action {
  actionType: ActionType;
  selector?: string;
  value?: string;
  coordinates?: Record<string, number>;
  metadata: Record<string, unknown>;

  constructor(init: ActionInit) {
    this.actionType = init.actionType;
    this.selector = init.selector;
    this.value = init.value;
    this.coordinates = init.coordinates;
    this.metadata = init.metadata ?? {};
  }
}

export interface ActionResultInit {
  success: boolean;
  description: string;
  error?: string;
  screenshot?: Uint8Array;
  taskComplete?: boolean;
  metadata?: Record<string, unknown>;
}

export class ActionResult {
  success: boolean;
  description: string;
  error?: string;
  screenshot?: Uint8Array;
  taskComplete: boolean;
  metadata: Record<string, unknown>;

  constructor(init: ActionResultInit) {
    this.success = init.success;
    this.description = init.description;
    this.error = init.error;
    this.screenshot = init.screenshot;
    this.taskComplete = init.taskComplete ?? false;
    this.metadata = init.metadata ?? {};
  }
}

export interface InterfaceStateInit {
  url?: string;
  title?: string;
  content?: string;
  interactiveElements?: Array<Record<string, unknown>>;
  screenshot?: Uint8Array;
  metadata?: Record<string, unknown>;
}

export class InterfaceState {
  url?: string;
  title?: string;
  content: string;
  interactiveElements: Array<Record<string, unknown>>;
  screenshot?: Uint8Array;
  metadata: Record<string, unknown>;

  constructor(init: InterfaceStateInit = {}) {
    this.url = init.url;
    this.title = init.title;
    this.content = init.content ?? "";
    this.interactiveElements = init.interactiveElements ?? [];
    this.screenshot = init.screenshot;
    this.metadata = init.metadata ?? {};
  }
}

export abstract class BaseInterfaceClient {
  abstract initialize(): Promise<void>;
  abstract getState(format?: "text" | "visual" | "hybrid" | string): Promise<InterfaceState>;
  abstract executeAction(action: Action): Promise<ActionResult>;
  abstract getScreenshot(): Promise<Uint8Array>;
  abstract close(): Promise<void>;
}

export interface PlaywrightWebClientOptions {
  startUrl?: string;
  headless?: boolean;
}

export class PlaywrightWebClient extends BaseInterfaceClient {
  startUrl: string;
  headless: boolean;
  playwright?: any;
  browser?: any;
  context?: any;
  page?: any;
  actionHistory: Action[] = [];

  constructor(options: PlaywrightWebClientOptions = {}) {
    super();
    this.startUrl = options.startUrl ?? "https://www.google.com";
    this.headless = options.headless ?? true;
  }

  async initialize(): Promise<void> {
    const playwright = await loadPlaywright();
    this.playwright = playwright;
    this.browser = await playwright.chromium.launch({ headless: this.headless });
    this.context = await this.browser.newContext();
    this.page = await this.context.newPage();
    await this.page.goto(this.startUrl);
  }

  async getState(format: "text" | "visual" | "hybrid" | string = "hybrid"): Promise<InterfaceState> {
    this.assertInitialized();
    const state = new InterfaceState({
      url: this.page.url(),
      title: await this.page.title()
    });

    if (format === "text" || format === "hybrid") {
      state.content = await this.page.content();
      state.interactiveElements = await this.getInteractiveElements();
    }

    if (format === "visual" || format === "hybrid") {
      state.screenshot = await this.getScreenshot();
    }

    return state;
  }

  async executeAction(action: Action): Promise<ActionResult> {
    this.assertInitialized();

    try {
      let result: ActionResult;
      switch (action.actionType) {
        case ActionType.NAVIGATE:
          result = await this.navigate(action);
          break;
        case ActionType.CLICK:
          result = await this.click(action);
          break;
        case ActionType.TYPE:
          result = await this.typeText(action);
          break;
        case ActionType.SELECT:
          result = await this.selectOption(action);
          break;
        case ActionType.PRESS:
          result = await this.press(action);
          break;
        case ActionType.SCROLL:
          result = await this.scroll(action);
          break;
        case ActionType.HOVER:
          result = await this.hover(action);
          break;
        case ActionType.SCREENSHOT:
          result = new ActionResult({
            success: true,
            description: "Captured screenshot",
            screenshot: await this.getScreenshot()
          });
          break;
        default:
          result = new ActionResult({
            success: false,
            description: "",
            error: `Unsupported action type: ${String(action.actionType)}`
          });
      }

      this.actionHistory.push(action);
      if (action.metadata.captureScreenshot === true) {
        result.screenshot = await this.getScreenshot();
      }
      return result;
    } catch (error) {
      return new ActionResult({
        success: false,
        description: "",
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  async getScreenshot(): Promise<Uint8Array> {
    this.assertInitialized();
    return await this.page.screenshot({ type: "png" });
  }

  async close(): Promise<void> {
    await this.page?.close();
    await this.context?.close();
    await this.browser?.close();
    this.page = undefined;
    this.context = undefined;
    this.browser = undefined;
    this.playwright = undefined;
  }

  private async navigate(action: Action): Promise<ActionResult> {
    if (!action.value) throw new Error("Navigate action requires a URL value");
    try {
      await this.page.goto(action.value, { waitUntil: "networkidle", timeout: 5000 });
      return new ActionResult({ success: true, description: `Navigated to ${action.value}` });
    } catch (error) {
      const currentUrl = this.page.url();
      if (currentUrl && (currentUrl.includes(action.value) || currentUrl !== "about:blank")) {
        try {
          await this.page.waitForLoadState("domcontentloaded", { timeout: 5000 });
        } catch {
          // A partially-loaded document is still useful for observation.
        }
        return new ActionResult({
          success: true,
          description: `Navigated to ${action.value} (page loaded but not fully idle)`
        });
      }
      throw error;
    }
  }

  private async click(action: Action): Promise<ActionResult> {
    if (!action.selector) throw new Error("Click action requires a selector");

    let selector = action.selector;
    try {
      await this.page.click(selector, { timeout: 2000 });
      return new ActionResult({ success: true, description: `Clicked on ${selector}` });
    } catch (initialError) {
      const containsText = extractContainsText(selector);
      if (containsText) {
        try {
          await this.page.click(`text=${containsText}`, { timeout: 2000 });
          selector = `text=${containsText}`;
          return new ActionResult({ success: true, description: `Clicked on ${selector}` });
        } catch {
          try {
            const linkSelector = `a[href*="${cssAttributeValue(containsText.toLowerCase())}"]`;
            await this.page.click(linkSelector, { timeout: 2000 });
            selector = linkSelector;
            return new ActionResult({ success: true, description: `Clicked on ${selector}` });
          } catch {
            // Fall through to the generic text selector fallback.
          }
        }
      }

      if (!selector.startsWith("#") && !selector.startsWith(".")) {
        try {
          await this.page.click(`text=${selector}`, { timeout: 2000 });
          selector = `text=${selector}`;
          return new ActionResult({ success: true, description: `Clicked on ${selector}` });
        } catch {
          // Preserve the original Playwright failure for the caller.
        }
      }

      throw initialError;
    }
  }

  private async typeText(action: Action): Promise<ActionResult> {
    if (!action.selector || action.value === undefined) {
      throw new Error("Type action requires both selector and value");
    }
    await this.page.fill(action.selector, action.value);
    return new ActionResult({
      success: true,
      description: `Typed '${action.value}' into ${action.selector}`
    });
  }

  private async selectOption(action: Action): Promise<ActionResult> {
    if (!action.selector || action.value === undefined) {
      throw new Error("Select action requires both selector and value");
    }
    await this.page.selectOption(action.selector, action.value);
    return new ActionResult({
      success: true,
      description: `Selected '${action.value}' in ${action.selector}`
    });
  }

  private async press(action: Action): Promise<ActionResult> {
    if (!action.selector || action.value === undefined) {
      throw new Error("Press action requires both selector and value");
    }
    await this.page.press(action.selector, action.value);
    return new ActionResult({
      success: true,
      description: `Pressed '${action.value}' on ${action.selector}`
    });
  }

  private async scroll(action: Action): Promise<ActionResult> {
    const direction = action.value ?? "down";
    let scrollX = 0;
    let scrollY = 0;

    if (direction === "down") scrollY = 500;
    else if (direction === "up") scrollY = -500;
    else if (direction === "right") scrollX = 500;
    else if (direction === "left") scrollX = -500;
    else {
      const numeric = Number.parseInt(direction, 10);
      scrollY = Number.isFinite(numeric) ? numeric : 500;
    }

    await this.page.evaluate(
      ([x, y]: [number, number]) => window.scrollBy(x, y),
      [scrollX, scrollY]
    );
    return new ActionResult({
      success: true,
      description: `Scrolled ${direction} by ${Math.abs(scrollY || scrollX)} pixels`
    });
  }

  private async hover(action: Action): Promise<ActionResult> {
    if (!action.selector) throw new Error("Hover action requires a selector");
    await this.page.hover(action.selector);
    return new ActionResult({ success: true, description: `Hovered over ${action.selector}` });
  }

  private async getInteractiveElements(): Promise<Array<Record<string, unknown>>> {
    if (!this.page) return [];
    return await this.page.evaluate(() => {
      const interactiveSelectors = [
        "button",
        "a",
        "input",
        "select",
        "textarea",
        "[role='button']",
        "[role='link']",
        "[onclick]"
      ];

      const elements: Array<Record<string, unknown>> = [];
      for (const selector of interactiveSelectors) {
        document.querySelectorAll(selector).forEach((element) => {
          const htmlElement = element as HTMLElement & {
            value?: string;
            type?: string;
            placeholder?: string;
            href?: string;
          };
          if (htmlElement.offsetParent === null) return;
          elements.push({
            tag: htmlElement.tagName.toLowerCase(),
            text: htmlElement.innerText || htmlElement.value || "",
            type: htmlElement.type || "",
            placeholder: htmlElement.placeholder || "",
            href: htmlElement.href || "",
            selector: htmlElement.id
              ? `#${htmlElement.id}`
              : htmlElement.className
                ? `.${String(htmlElement.className).split(" ")[0]}`
                : htmlElement.tagName.toLowerCase()
          });
        });
      }
      return elements;
    });
  }

  private assertInitialized(): asserts this is this & { page: any } {
    if (!this.page) {
      throw new Error("Browser not initialized. Call initialize() first.");
    }
  }
}

async function loadPlaywright(): Promise<any> {
  try {
    const dynamicImport = new Function("specifier", "return import(specifier)") as (
      specifier: string
    ) => Promise<any>;
    return await dynamicImport("playwright");
  } catch (error) {
    throw new Error(
      "Playwright is not installed. Install it with: npm install playwright"
    );
  }
}

function extractContainsText(selector: string): string | undefined {
  const match = selector.match(/:contains\(['"]?(.*?)['"]?\)/);
  return match?.[1];
}

function cssAttributeValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
