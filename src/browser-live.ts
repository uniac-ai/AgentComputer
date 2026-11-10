// The browser, live: its frames to whoever watches, and a person's input to it, through a second
// connection to the same browser the agent's tools use. Whoever operates it holds it, and the
// agent's browser calls wait while they do.
import type {
  Browser,
  BrowserContext,
  Dialog,
  ElementHandle,
  FileChooser,
  Page,
} from "playwright-core";
import type { WebSocket } from "ws";
import type { BrowserGate } from "./browser.ts";
import type { components } from "./generated/schema.js";
import { playwright } from "./playwright.ts";
import { startScreencast } from "./screencast.ts";

type Schemas = components["schemas"];
type ServerMessage = Schemas["ScreencastEvent"];
type ClientMessage = Schemas["ScreencastInput"];
type Mode = Schemas["LiveMode"];

/** How long an agent's call waits for a person to let go, then how long until they're let go. */
const WAIT_MS = 25_000;
const IDLE_MS = 60_000;
/** How often the tabs' titles are read while anyone watches. */
const TITLE_CHECK_MS = 1_000;
/** One input step can't hold up the rest for longer, as a dialog would. */
const STEP_MS = 2_000;
/** A socket further behind than this misses frames until it catches up. */
const MAX_BUFFERED = 4 * 1024 * 1024;

/** What the page-side code uses of a select, there being no DOM types on this side. */
interface PageSelect {
  tagName: string;
  disabled: boolean;
  multiple: boolean;
  options: ArrayLike<{ value: string; label: string; selected: boolean }>;
}
declare const document: { elementFromPoint(x: number, y: number): PageSelect | null };

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const within = <T>(work: Promise<T>, ms: number) =>
  Promise.race([work, sleep(ms).then(() => undefined)]);

export class BrowserLive implements BrowserGate {
  readonly #endpoint: Promise<string>;
  readonly #sockets = new Map<WebSocket, Mode>();
  #viewer: Promise<Browser> | undefined;
  #context: BrowserContext | undefined;
  readonly #ids = new Map<Page, number>();
  #nextId = 1;
  #shown: Page | undefined;
  #stopCast: (() => Promise<void>) | undefined;
  #size = { width: 0, height: 0 };
  #dialog: Dialog | undefined;
  #chooser: FileChooser | undefined;
  #choice: ElementHandle | undefined;
  #swallowUp = false;
  #driver: WebSocket | undefined;
  #lastInput = 0;
  #agentWaiting = 0;
  #answeredChooser = false;
  /** The tabs last sent, to send them again only when something about them changed. */
  #lastTabs = "";
  #titles: NodeJS.Timeout | undefined;
  #checking = false;
  #steps: Promise<unknown> = Promise.resolve();

  constructor(endpoint: Promise<string>) {
    this.#endpoint = endpoint;
  }

  // ---- The agent's side

  async wait() {
    if (!this.#held()) return undefined;
    this.#agentWaiting++;
    this.#announceDriver();
    try {
      const deadline = Date.now() + WAIT_MS;
      while (this.#held() && Date.now() < deadline) await sleep(200);
      return this.#held()
        ? "A person has the browser now, so this didn't run. Try again later."
        : "A person used the browser, so this didn't run and the page may have changed. Take a new snapshot before you act.";
    } finally {
      this.#agentWaiting--;
      this.#announceDriver();
    }
  }

  takeAnsweredChooser() {
    const answered = this.#answeredChooser;
    this.#answeredChooser = false;
    return answered;
  }

  agentAnswered() {
    this.#dialog = undefined;
    this.#chooser = undefined;
    this.#broadcast({ type: "dialog", open: false });
    this.#broadcast({ type: "file-chooser", open: false });
  }

  // ---- The person's side

  open(ws: WebSocket, mode: Mode) {
    this.#sockets.set(ws, mode);
    // Opening it to operate is taking the browser: the agent's calls wait from now.
    if (mode === "operate") {
      this.#driver = ws;
      this.#lastInput = Date.now();
    }
    ws.on("close", () => this.#left(ws));
    ws.on("message", (data: Buffer, binary: boolean) => {
      if (binary || this.#sockets.get(ws) !== "operate") return;
      let message: ClientMessage;
      try {
        message = JSON.parse(data.toString()) as ClientMessage;
      } catch {
        return;
      }
      this.#input(ws, message);
    });
    this.#begin().then(
      () => this.#greet(ws),
      () => ws.close(1011, "The browser can't be reached."),
    );
  }

  async close() {
    for (const ws of this.#sockets.keys()) ws.close(1001, "It stopped.");
    await this.#end();
  }

  #held() {
    return this.#driver !== undefined && Date.now() - this.#lastInput < IDLE_MS;
  }

  #send(ws: WebSocket, message: ServerMessage) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
  }

  #broadcast(message: ServerMessage) {
    for (const ws of this.#sockets.keys()) this.#send(ws, message);
  }

  #announceDriver() {
    for (const ws of this.#sockets.keys())
      this.#send(ws, {
        type: "driver",
        you: ws === this.#driver && this.#held(),
        held: this.#held(),
        agentWaiting: this.#agentWaiting > 0,
      });
  }

  async #begin() {
    this.#viewer ??= (async () => {
      const viewer = await playwright().chromium.connect(await this.#endpoint);
      const context = viewer.contexts()[0] ?? (await viewer.newContext());
      this.#context = context;
      for (const page of context.pages()) this.#track(page);
      context.on("page", (page) => {
        this.#track(page);
        void this.#show(page);
      });
      await this.#show(context.pages().at(-1) ?? (await context.newPage()));
      // A page can change its title without navigating, and nothing says so but asking.
      this.#titles = setInterval(() => void this.#checkTabs(), TITLE_CHECK_MS);
      return viewer;
    })();
    await this.#viewer;
  }

  async #end() {
    const viewer = this.#viewer;
    this.#viewer = undefined;
    clearInterval(this.#titles);
    this.#titles = undefined;
    this.#lastTabs = "";
    await this.#stopCast?.();
    this.#stopCast = undefined;
    this.#shown = undefined;
    this.#ids.clear();
    await (await viewer?.catch(() => undefined))?.close().catch(() => {});
  }

  #left(ws: WebSocket) {
    this.#sockets.delete(ws);
    if (this.#driver === ws) {
      this.#driver = undefined;
      this.#announceDriver();
    }
    if (this.#sockets.size === 0) void this.#end();
  }

  async #greet(ws: WebSocket) {
    await this.#tabs(ws);
    if (this.#size.width) this.#send(ws, { type: "viewport", ...this.#size });
    if (this.#dialog)
      this.#send(ws, {
        type: "dialog",
        open: true,
        kind: this.#dialog.type() as "alert",
        message: this.#dialog.message(),
      });
    if (this.#chooser)
      this.#send(ws, { type: "file-chooser", open: true, multiple: this.#chooser.isMultiple() });
    this.#announceDriver();
  }

  #track(page: Page) {
    if (this.#ids.has(page)) return;
    this.#ids.set(page, this.#nextId++);
    page.on("dialog", (dialog) => {
      this.#dialog = dialog;
      this.#broadcast({
        type: "dialog",
        open: true,
        kind: dialog.type() as "alert",
        message: dialog.message(),
        ...(dialog.defaultValue() ? { defaultValue: dialog.defaultValue() } : {}),
      });
    });
    page.on("filechooser", (chooser) => {
      this.#chooser = chooser;
      this.#broadcast({ type: "file-chooser", open: true, multiple: chooser.isMultiple() });
    });
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) void this.#tabs();
    });
    page.on("close", () => {
      this.#ids.delete(page);
      if (this.#shown === page) void this.#show(this.#context?.pages().at(-1));
      else void this.#tabs();
    });
  }

  /** Which page the frames are of: the newest by default, or the one the person picked. */
  async #show(page: Page | undefined) {
    if (page === this.#shown) return;
    await this.#stopCast?.();
    this.#stopCast = undefined;
    this.#shown = page;
    this.#choice = undefined;
    if (page) {
      this.#stopCast = await startScreencast(page, (frame) => {
        if (frame.width !== this.#size.width || frame.height !== this.#size.height) {
          this.#size = { width: frame.width, height: frame.height };
          this.#broadcast({ type: "viewport", ...this.#size });
        }
        for (const ws of this.#sockets.keys())
          if (ws.readyState === ws.OPEN && ws.bufferedAmount < MAX_BUFFERED) ws.send(frame.data);
      }).catch(() => undefined);
    }
    await this.#tabs();
  }

  async #tabList(): Promise<ServerMessage> {
    const tabs = await Promise.all(
      [...this.#ids].map(async ([page, id]) => ({
        id,
        url: page.url(),
        title: (await within(page.title(), STEP_MS).catch(() => undefined)) ?? "",
      })),
    );
    return { type: "tabs", tabs, shown: (this.#shown && this.#ids.get(this.#shown)) ?? null };
  }

  async #tabs(only?: WebSocket) {
    const message = await this.#tabList();
    this.#lastTabs = JSON.stringify(message);
    if (only) this.#send(only, message);
    else this.#broadcast(message);
  }

  /** Send the tabs again if anything about them changed, such as a title. */
  async #checkTabs() {
    if (this.#checking) return;
    this.#checking = true;
    try {
      const message = await this.#tabList();
      const text = JSON.stringify(message);
      if (text === this.#lastTabs) return;
      this.#lastTabs = text;
      this.#broadcast(message);
    } finally {
      this.#checking = false;
    }
  }

  /** Each step in order, none waiting on another for long: a dialog blocks the page's input. */
  #step(work: () => Promise<unknown>) {
    this.#steps = this.#steps.then(() => within(work(), STEP_MS)).catch(() => {});
  }

  #input(ws: WebSocket, message: ClientMessage) {
    if (message.type === "release") {
      if (this.#driver === ws) this.#driver = undefined;
      return this.#announceDriver();
    }
    const changed = this.#driver !== ws || !this.#held();
    this.#driver = ws;
    this.#lastInput = Date.now();
    if (changed) this.#announceDriver();
    const page = this.#shown;
    switch (message.type) {
      case "mouse":
        if (!page) return;
        return this.#step(() => this.#mouse(page, message));
      case "key":
        if (!page) return;
        return this.#step(() =>
          message.action === "down"
            ? page.keyboard.down(message.key)
            : page.keyboard.up(message.key),
        );
      case "text":
        if (!page) return;
        return this.#step(() => page.keyboard.insertText(message.text));
      case "dialog": {
        const dialog = this.#dialog;
        this.#dialog = undefined;
        this.#broadcast({ type: "dialog", open: false });
        if (!dialog) return;
        return this.#step(() =>
          message.accept ? dialog.accept(message.text ?? undefined) : dialog.dismiss(),
        );
      }
      case "files": {
        const chooser = this.#chooser;
        this.#chooser = undefined;
        this.#broadcast({ type: "file-chooser", open: false });
        if (!chooser) return;
        this.#answeredChooser = true;
        return this.#step(() =>
          chooser.setFiles(
            message.files.map((file) => ({
              name: file.name,
              mimeType: file.mimeType ?? "application/octet-stream",
              buffer: Buffer.from(file.data, "base64"),
            })),
          ),
        );
      }
      case "choice": {
        const choice = this.#choice;
        this.#choice = undefined;
        if (!choice) return;
        return this.#step(() => choice.selectOption(message.values));
      }
      case "tab":
        return this.#step(() => this.#tab(message));
      case "navigate":
        if (!page) return;
        return this.#step(async () => {
          if (message.to === "back") await page.goBack();
          else if (message.to === "forward") await page.goForward();
          else if (message.to === "reload") await page.reload();
          else await page.goto(message.to);
        });
    }
  }

  async #mouse(page: Page, message: Extract<ClientMessage, { type: "mouse" }>) {
    const { x, y } = message;
    if (message.action === "move") return page.mouse.move(x, y);
    if (message.action === "wheel")
      return page.mouse.wheel(message.deltaX ?? 0, message.deltaY ?? 0);
    const button = message.button ?? "left";
    if (message.action === "up") {
      if (this.#swallowUp) {
        this.#swallowUp = false;
        return;
      }
      return page.mouse.up({ button });
    }
    // A select's own list isn't in the frames, so a press on one asks the viewer to show a list.
    if (button === "left") {
      const choice = await page
        .evaluate(
          ([px, py]) => {
            const list = document.elementFromPoint(px as number, py as number);
            if (list?.tagName !== "SELECT" || list.disabled) return null;
            return {
              multiple: list.multiple,
              options: Array.from(list.options).map((option) => ({
                value: option.value,
                label: option.label,
                selected: option.selected,
              })),
            };
          },
          [x, y],
        )
        .catch(() => null);
      if (choice) {
        const handle = await page.evaluateHandle(
          ([px, py]) => document.elementFromPoint(px as number, py as number),
          [x, y],
        );
        this.#choice = (handle.asElement() as ElementHandle | null) ?? undefined;
        this.#swallowUp = true;
        return this.#broadcast({ type: "choice", ...choice });
      }
    }
    await page.mouse.move(x, y);
    return page.mouse.down({ button });
  }

  async #tab(message: Extract<ClientMessage, { type: "tab" }>) {
    const byId = (id: number | undefined) => [...this.#ids].find(([, known]) => known === id)?.[0];
    if (message.action === "show") return this.#show(byId(message.id));
    if (message.action === "close") return byId(message.id)?.close();
    const page = await this.#context?.newPage();
    if (page && message.url) await page.goto(message.url).catch(() => {});
  }
}
