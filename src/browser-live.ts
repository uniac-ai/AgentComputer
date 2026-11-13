// The browser, live: a page's frames to whoever watches it, and a person's input to it, through a
// second connection to the same browser the agent's tools use. Nobody waits for anybody: a person
// and the agent can both act at once, each in a tab of their own if they like. Which page a socket
// is shown is that socket's alone.
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
import { type Frame, startScreencast } from "./screencast.ts";

type Schemas = components["schemas"];
type ServerMessage = Schemas["ScreencastEvent"];
type ClientMessage = Schemas["ScreencastInput"];
type Mode = Schemas["LiveMode"];
type Tab = Extract<ServerMessage, { type: "tabs" }>["tabs"][number];

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

/** One socket on the surface, and the page it is shown. */
interface Viewer {
  mode: Mode;
  shown?: Page | undefined;
  /**
   * Whether it has chosen a tab itself. Until it does it is shown each new tab as it opens, so
   * watching follows the work; after, its page changes only when that page closes.
   */
  chose: boolean;
  /** The list it pressed on, waiting for its choice. */
  choice?: ElementHandle | undefined;
  swallowUp: boolean;
  /** Its input, each step in order. */
  steps: Promise<unknown>;
}

/** A page being cast, for every socket shown it. */
interface Cast {
  stop: Promise<(() => Promise<void>) | undefined>;
  size: { width: number; height: number };
  /** The last frame, for a socket that joins while the page is still. */
  last?: Buffer | undefined;
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const within = <T>(work: Promise<T>, ms: number) =>
  Promise.race([work, sleep(ms).then(() => undefined)]);

export class BrowserLive implements BrowserGate {
  readonly #endpoint: Promise<string>;
  readonly #viewers = new Map<WebSocket, Viewer>();
  #client: Promise<Browser> | undefined;
  #context: BrowserContext | undefined;
  readonly #ids = new Map<Page, number>();
  #nextId = 1;
  readonly #casts = new Map<Page, Cast>();
  /** A page's cast that is still stopping, which its next one waits for. */
  readonly #stopping = new Map<Page, Promise<void>>();
  readonly #dialogs = new Map<Page, Dialog>();
  readonly #choosers = new Map<Page, FileChooser>();
  /** The agent's MCP sessions seen so far. */
  readonly #sessions = new Set<string>();
  /** Those still to be told that a person answered a file chooser. */
  readonly #owed = new Set<string>();
  /** The tabs last sent, to send them again only when something about them changed. */
  #lastTabs = "";
  #titles: NodeJS.Timeout | undefined;
  #checking = false;
  /** Counts each time everyone has left, so a connection begun before that knows it is stale. */
  #ended = 0;

  constructor(endpoint: Promise<string>) {
    this.#endpoint = endpoint;
  }

  // ---- The agent's side

  takeAnsweredChooser(session: string) {
    this.#sessions.add(session);
    return this.#owed.delete(session);
  }

  sessionEnded(session: string) {
    this.#sessions.delete(session);
    this.#owed.delete(session);
  }

  agentAnsweredChooser() {
    // Which page it was on isn't known here, and nothing says when a chooser closes, so every one
    // is taken as closed. A person whose own was open presses again.
    this.#choosers.clear();
    for (const ws of this.#viewers.keys()) this.#send(ws, { type: "file-chooser", open: false });
  }

  // ---- The person's side

  open(ws: WebSocket, mode: Mode) {
    const viewer: Viewer = { mode, chose: false, swallowUp: false, steps: Promise.resolve() };
    this.#viewers.set(ws, viewer);
    ws.on("close", () => this.#left(ws));
    ws.on("message", (data: Buffer, binary: boolean) => {
      if (binary || viewer.mode !== "operate") return;
      let message: unknown;
      try {
        message = JSON.parse(data.toString());
      } catch {
        return;
      }
      // JSON that isn't an object, `null` among it, is ignored as text that isn't JSON is.
      if (typeof message !== "object" || message === null) return;
      this.#input(ws, viewer, message as ClientMessage);
    });
    this.#begin().then(
      // Unless it chose a tab while this was starting, it is shown the newest.
      () => (viewer.chose ? undefined : this.#show(ws, this.#newest())),
      () => ws.close(1011, "The browser can't be reached."),
    );
  }

  async close() {
    for (const ws of this.#viewers.keys()) ws.close(1001, "It stopped.");
    await this.#end();
  }

  #send(ws: WebSocket, message: ServerMessage) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
  }

  /** The sockets shown a page. */
  #shownTo(page: Page) {
    return [...this.#viewers].filter(([, viewer]) => viewer.shown === page).map(([ws]) => ws);
  }

  #newest() {
    return this.#context?.pages().at(-1);
  }

  async #begin() {
    this.#client ??= (async () => {
      const ended = this.#ended;
      const client = await playwright().chromium.connect(await this.#endpoint);
      const context = client.contexts()[0] ?? (await client.newContext());
      // Everyone left while it connected, and it is being closed.
      if (ended !== this.#ended) return client;
      this.#context = context;
      for (const page of context.pages()) this.#track(page);
      context.on("page", (page) => {
        this.#track(page);
        // A new tab is shown to every socket that hasn't chosen one of its own, or has none left.
        for (const [ws, viewer] of this.#viewers)
          if (!viewer.chose || !viewer.shown) void this.#show(ws, page);
        void this.#tabs();
      });
      if (context.pages().length === 0) await context.newPage();
      // A page can change its title without navigating, and nothing says so but asking.
      if (ended === this.#ended)
        this.#titles = setInterval(() => void this.#checkTabs(), TITLE_CHECK_MS);
      return client;
    })();
    await this.#client;
  }

  /** Everyone has left. All of it is forgotten at once, so a socket that opens next starts anew. */
  async #end() {
    const client = this.#client;
    const casts = [...this.#casts.values()];
    this.#ended++;
    this.#client = undefined;
    this.#context = undefined;
    clearInterval(this.#titles);
    this.#titles = undefined;
    this.#lastTabs = "";
    this.#casts.clear();
    this.#stopping.clear();
    this.#ids.clear();
    this.#dialogs.clear();
    this.#choosers.clear();
    await Promise.all(casts.map((cast) => cast.stop.then((stop) => stop?.()).catch(() => {})));
    await (await client?.catch(() => undefined))?.close().catch(() => {});
  }

  #left(ws: WebSocket) {
    const shown = this.#viewers.get(ws)?.shown;
    this.#viewers.delete(ws);
    if (this.#viewers.size === 0) return void this.#end();
    if (shown) void this.#uncast(shown);
  }

  #track(page: Page) {
    if (this.#ids.has(page)) return;
    this.#ids.set(page, this.#nextId++);
    page.on("dialog", (dialog) => {
      this.#dialogs.set(page, dialog);
      for (const ws of this.#shownTo(page)) this.#tellDialog(ws, page);
    });
    // Whoever answered it, a person here or the agent.
    page.on("dialogclosed", () => {
      this.#dialogs.delete(page);
      for (const ws of this.#shownTo(page)) this.#tellDialog(ws, page);
    });
    page.on("filechooser", (chooser) => {
      this.#choosers.set(page, chooser);
      for (const ws of this.#shownTo(page)) this.#tellChooser(ws, page);
    });
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) void this.#tabs();
    });
    page.on("close", () => {
      this.#ids.delete(page);
      this.#dialogs.delete(page);
      this.#choosers.delete(page);
      this.#casts.delete(page);
      this.#stopping.delete(page);
      // Whoever was shown it is shown the newest that is left, whether or not they chose it.
      for (const ws of this.#shownTo(page)) void this.#show(ws, this.#newest());
      void this.#tabs();
    });
  }

  #tellDialog(ws: WebSocket, page: Page) {
    const dialog = this.#dialogs.get(page);
    this.#send(
      ws,
      dialog
        ? {
            type: "dialog",
            open: true,
            kind: dialog.type() as "alert",
            message: dialog.message(),
            ...(dialog.defaultValue() ? { defaultValue: dialog.defaultValue() } : {}),
          }
        : { type: "dialog", open: false },
    );
  }

  #tellChooser(ws: WebSocket, page: Page) {
    const chooser = this.#choosers.get(page);
    this.#send(
      ws,
      chooser
        ? { type: "file-chooser", open: true, multiple: chooser.isMultiple() }
        : { type: "file-chooser", open: false },
    );
  }

  /** The cast of a page, started if no socket was shown it yet. */
  #cast(page: Page) {
    const running = this.#casts.get(page);
    if (running) return running;
    const onFrame = (frame: Frame) => {
      const watching = this.#shownTo(page);
      if (frame.width !== cast.size.width || frame.height !== cast.size.height) {
        cast.size = { width: frame.width, height: frame.height };
        for (const ws of watching) this.#send(ws, { type: "viewport", ...cast.size });
      }
      cast.last = frame.data;
      for (const ws of watching)
        if (ws.readyState === ws.OPEN && ws.bufferedAmount < MAX_BUFFERED) ws.send(frame.data);
    };
    const cast: Cast = {
      size: { width: 0, height: 0 },
      // A page has one screencast at a time, so this one starts once the last has stopped.
      stop: (this.#stopping.get(page) ?? Promise.resolve())
        .then(() => startScreencast(page, onFrame))
        .catch(() => undefined),
    };
    this.#casts.set(page, cast);
    return cast;
  }

  /** Stop casting a page no socket is shown any more. */
  async #uncast(page: Page) {
    const cast = this.#casts.get(page);
    if (!cast || this.#shownTo(page).length > 0) return;
    this.#casts.delete(page);
    const stopped = cast.stop.then((stop) => stop?.()).catch(() => {});
    this.#stopping.set(page, stopped);
    await stopped;
    if (this.#stopping.get(page) === stopped) this.#stopping.delete(page);
  }

  /** Change the page a socket is shown, and tell it what that page is waiting on. */
  async #show(ws: WebSocket, page: Page | undefined) {
    const viewer = this.#viewers.get(ws);
    if (!viewer || (page && viewer.shown === page)) return;
    const before = viewer.shown;
    viewer.shown = page;
    viewer.choice = undefined;
    viewer.swallowUp = false;
    if (before) await this.#uncast(before);
    // It left, or was shown another, while that stopped.
    if (this.#viewers.get(ws) !== viewer || viewer.shown !== page) return;
    if (page) {
      const cast = this.#cast(page);
      if (cast.size.width) this.#send(ws, { type: "viewport", ...cast.size });
      if (cast.last && ws.readyState === ws.OPEN) ws.send(cast.last);
      this.#tellDialog(ws, page);
      this.#tellChooser(ws, page);
    }
    await this.#tabs(ws);
  }

  async #tabList(): Promise<Tab[]> {
    return Promise.all(
      [...this.#ids].map(async ([page, id]) => ({
        id,
        url: page.url(),
        title: (await within(page.title(), STEP_MS).catch(() => undefined)) ?? "",
      })),
    );
  }

  /** The tabs, to one socket or to all, each told which one it is shown. */
  async #tabs(only?: WebSocket, listed?: Tab[]) {
    const tabs = listed ?? (await this.#tabList());
    if (!only) this.#lastTabs = JSON.stringify(tabs);
    for (const [ws, viewer] of this.#viewers)
      if (!only || ws === only)
        this.#send(ws, {
          type: "tabs",
          tabs,
          shown: (viewer.shown && this.#ids.get(viewer.shown)) ?? null,
        });
  }

  /** Send the tabs again if anything about them changed, such as a title. */
  async #checkTabs() {
    if (this.#checking) return;
    this.#checking = true;
    try {
      const tabs = await this.#tabList();
      if (JSON.stringify(tabs) !== this.#lastTabs) await this.#tabs(undefined, tabs);
    } finally {
      this.#checking = false;
    }
  }

  /** Each step in order, none waiting on another for long: a dialog blocks the page's input. */
  #step(viewer: Viewer, work: () => Promise<unknown>) {
    viewer.steps = viewer.steps.then(() => within(work(), STEP_MS)).catch(() => {});
  }

  #input(ws: WebSocket, viewer: Viewer, message: ClientMessage) {
    const page = viewer.shown;
    switch (message.type) {
      case "mouse":
        if (!page) return;
        return this.#step(viewer, () => this.#mouse(ws, viewer, page, message));
      case "key":
        if (!page) return;
        return this.#step(viewer, () =>
          message.action === "down"
            ? page.keyboard.down(message.key)
            : page.keyboard.up(message.key),
        );
      case "text":
        if (!page) return;
        return this.#step(viewer, () => page.keyboard.insertText(message.text));
      case "dialog": {
        // It is told closed when the page says so, whoever answers it first.
        const dialog = page && this.#dialogs.get(page);
        if (!dialog) return;
        return this.#step(viewer, () =>
          message.accept ? dialog.accept(message.text ?? undefined) : dialog.dismiss(),
        );
      }
      case "files": {
        const chooser = page && this.#choosers.get(page);
        if (!page || !chooser) return;
        this.#choosers.delete(page);
        for (const socket of this.#shownTo(page)) this.#tellChooser(socket, page);
        // Each of the agent's sessions may still be waiting on it, and is told at its next call.
        // That frees a session on this page; one on another finds the chooser if it comes here.
        for (const session of this.#sessions) this.#owed.add(session);
        return this.#step(viewer, () =>
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
        const choice = viewer.choice;
        viewer.choice = undefined;
        if (!choice) return;
        return this.#step(viewer, () => choice.selectOption(message.values));
      }
      case "tab":
        return this.#step(viewer, () => this.#tab(ws, viewer, message));
      case "navigate":
        if (!page) return;
        return this.#step(viewer, async () => {
          if (message.to === "back") await page.goBack();
          else if (message.to === "forward") await page.goForward();
          else if (message.to === "reload") await page.reload();
          else await page.goto(message.to);
        });
    }
  }

  async #mouse(
    ws: WebSocket,
    viewer: Viewer,
    page: Page,
    message: Extract<ClientMessage, { type: "mouse" }>,
  ) {
    const { x, y } = message;
    if (message.action === "move") return page.mouse.move(x, y);
    if (message.action === "wheel")
      return page.mouse.wheel(message.deltaX ?? 0, message.deltaY ?? 0);
    const button = message.button ?? "left";
    if (message.action === "up") {
      if (viewer.swallowUp) {
        viewer.swallowUp = false;
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
        viewer.choice = (handle.asElement() as ElementHandle | null) ?? undefined;
        viewer.swallowUp = true;
        return this.#send(ws, { type: "choice", ...choice });
      }
    }
    await page.mouse.move(x, y);
    return page.mouse.down({ button });
  }

  /** Showing or opening a tab makes the socket's page its own from then on. */
  async #tab(ws: WebSocket, viewer: Viewer, message: Extract<ClientMessage, { type: "tab" }>) {
    const byId = (id: number | undefined) => [...this.#ids].find(([, known]) => known === id)?.[0];
    if (message.action === "close") return byId(message.id)?.close();
    if (message.action === "show") {
      const page = byId(message.id);
      if (!page) return;
      viewer.chose = true;
      return this.#show(ws, page);
    }
    const page = await this.#context?.newPage();
    if (!page) return;
    viewer.chose = true;
    await this.#show(ws, page);
    if (message.url) await page.goto(message.url).catch(() => {});
  }
}
