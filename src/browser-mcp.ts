// Playwright MCP for a browser it doesn't own. Its own program takes the browser to be its to
// close: when a client's session ends, and when the agent calls browser_close, it closes the
// browser's context, which for a computer's browser is the browser. A computer's browser lives as
// long as its computer, whatever its clients do. So this serves the same tools from the same
// server, with a backend that only disconnects.
//
// It is built from the parts Playwright MCP's own program is built from, which are not a public
// interface. A test checks that they are there and that the server starts and lists its tools.
//
// Its own program serves on a port on 127.0.0.1, which any process on the machine, of any user,
// can reach with no token. This serves on a Unix socket instead, in a folder of its own that only
// its user can enter, as the browser host shares the browser. Playwright MCP has no way to be
// told that, so the one HTTP server it makes here is given the socket to listen on. What that
// leans on: `start` makes its server with `createHttpServer`, which reads `http.createServer`
// from the module when it is called; `startHttpServer` calls `listen` once and waits for
// "listening"; and the server's address is asked only to build a URL and the hosts it allows,
// which is why the address can be a placeholder and the hosts are given here. The test of this
// server fails if any of that moves: the server must list its tools over the socket and listen
// on no TCP port.
//
// When @playwright/mcp and playwright-core move, read this beside that program again: the action
// of `decorateMCPCommand`, in packages/playwright-core/src/tools/mcp/program.ts, and `start`,
// `startHttpServer` and `createHttpServer`. What to compare: the factory's fields, what
// BrowserBackend is given, what `sharedBrowserContext` decides (the close tool refusing, and
// nothing else here), and the server's making as above.
import { mkdtempSync, rmSync } from "node:fs";
import type * as Http from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { playwright } from "./playwright.ts";

const require = createRequire(import.meta.url);

interface Tool {
  schema: unknown;
}
interface Config {
  ignoreRoots: unknown;
  server: unknown;
}
/** What is used of Playwright MCP's parts. */
export interface McpParts {
  setupExitWatchdog(): void;
  resolveCLIConfigForMCP(options: Record<string, unknown>): Promise<Config>;
  filteredTools(config: Config): Tool[];
  BrowserBackend: new (
    config: Config,
    context: BrowserContext,
    tools: Tool[],
    options: { dispose(): Promise<void> },
  ) => unknown;
  start(factory: Record<string, unknown>, server: unknown): Promise<void>;
}
const mcpParts = (): McpParts =>
  (require("playwright-core/lib/coreBundle") as { tools: McpParts }).tools;

export interface McpOptions {
  /** The browser's socket, from its host. */
  endpoint: string;
  outputDir: string;
  /** Whether it is the person's own browser, where the agent works only in pages it opened. */
  own?: boolean;
}

type Listener = (page: Page) => void;
type Any = (...args: never[]) => unknown;

/** What the agent's tools may not do to the person's browser as a whole. */
const NOT_THEIRS = new Set([
  "addCookies",
  "addInitScript",
  "clearCookies",
  "clearPermissions",
  "close",
  "exposeBinding",
  "exposeFunction",
  "grantPermissions",
  "route",
  "routeFromHAR",
  "routeWebSocket",
  "setExtraHTTPHeaders",
  "setGeolocation",
  "setHTTPCredentials",
  "setOffline",
  "storageState",
  "unroute",
  "unrouteAll",
]);

/**
 * The person's own browser as the agent's tools see it: only the pages they opened, and the pages
 * those open. The person's own tabs are left alone: the tools neither list nor act on them, nor
 * watch them, which would answer their dialogs and take their file choosers; nor change the
 * browser as a whole. One connection serves every session, so a later session finds the pages an
 * earlier one opened. A page opened with a modifier or middle click has no opener, and so isn't
 * the agent's.
 */
class AgentsPages {
  readonly #context: BrowserContext;
  readonly #mine = new WeakSet<Page>();
  /** Pages that came while the tools were opening one, until it is known which is theirs. */
  readonly #held = new Set<Page>();
  #opening = 0;
  /** Each session's listeners for its pages. */
  readonly #listeners = new Set<Listener>();

  constructor(context: BrowserContext) {
    this.#context = context;
    // One listener for good, so that a page a page of theirs opens is theirs, session or none.
    context.on("page", (page) => {
      if (this.#opening > 0) this.#held.add(page);
      else void this.#byOpener(page);
    });
  }

  async #byOpener(page: Page) {
    const opener = await page.opener().catch(() => null);
    if (opener && this.#mine.has(opener)) this.#take(page);
  }

  #take(page: Page) {
    if (this.#mine.has(page)) return;
    this.#mine.add(page);
    for (const listener of this.#listeners) listener(page);
  }

  /** Its page is theirs, and told to every session before it is given. */
  async #newPage() {
    this.#opening++;
    try {
      const page = await this.#context.newPage();
      this.#held.delete(page);
      this.#take(page);
      return page;
    } finally {
      if (--this.#opening === 0) {
        const held = [...this.#held];
        this.#held.clear();
        for (const page of held) void this.#byOpener(page);
      }
    }
  }

  /** The context as one session sees it; its listeners go when it ends. */
  session() {
    const added: [{ off(event: string, listener: Any): unknown }, string, Any][] = [];
    const listen =
      <T extends object>(target: T, proxy: () => T) =>
      (key: "on" | "once" | "addListener") =>
      (event: string, listener: Any) => {
        const on = (target as Record<string, Any>)[key]?.bind(target) as (
          event: string,
          listener: Any,
        ) => void;
        on(event, listener);
        added.push([target as never, event, listener]);
        return proxy();
      };
    const browser = this.#context.browser() as NonNullable<ReturnType<BrowserContext["browser"]>>;
    const browserView: typeof browser = new Proxy(browser, {
      get: (target, key) =>
        key === "on" || key === "once" || key === "addListener"
          ? listen(target, () => browserView)(key)
          : bound(target, key),
    });
    const context: BrowserContext = new Proxy(this.#context, {
      get: (target, key) => {
        if (key === "pages") return () => target.pages().filter((page) => this.#mine.has(page));
        if (key === "newPage") return () => this.#newPage();
        if (key === "browser") return () => browserView;
        if (key === "on" || key === "addListener" || key === "once")
          return (event: string, listener: Listener) => {
            if (event !== "page") return listen(target, () => context)(key)(event, listener as Any);
            this.#listeners.add(listener);
            return context;
          };
        if (key === "off" || key === "removeListener")
          return (event: string, listener: Listener) => {
            if (event === "page") this.#listeners.delete(listener);
            else target.off(event as "close", listener as never);
            return context;
          };
        if (typeof key === "string" && NOT_THEIRS.has(key))
          return () => {
            throw new Error("The person's browser as a whole isn't the agent's to change.");
          };
        return bound(target, key);
      },
    });
    return {
      context,
      dispose: async () => {
        for (const [target, event, listener] of added) target.off(event, listener);
      },
    };
  }
}

/** A property of a target, its methods bound to it. */
const bound = (target: object, key: string | symbol) => {
  const value = Reflect.get(target, key, target) as unknown;
  return typeof value === "function" ? value.bind(target) : value;
};

/**
 * Have the next HTTP server made in this process listen on `socket`, whatever port it is asked
 * to. Asked its address, it gives one on no port, which nothing reaches.
 */
function listenOnSocket(socket: string) {
  const http = require("node:http") as typeof Http;
  const make = http.createServer;
  http.createServer = ((...args: Parameters<typeof make>) => {
    http.createServer = make;
    const server = make(...args);
    const listen = server.listen.bind(server);
    server.listen = (() => listen(socket)) as typeof server.listen;
    server.address = (): AddressInfo => ({ address: "127.0.0.1", family: "IPv4", port: 0 });
    return server;
  }) as typeof make;
}

export async function serveBrowserMcp(options: McpOptions) {
  const parts = mcpParts();
  parts.setupExitWatchdog();
  // Under /tmp, as the browser host's is: a socket's path is limited to about 104 bytes.
  const folder = mkdtempSync(join("/tmp", "agentcomputer-"));
  process.once("exit", () => rmSync(folder, { recursive: true, force: true }));
  const socket = join(folder, "mcp.sock");
  const config = await parts.resolveCLIConfigForMCP({
    endpoint: options.endpoint,
    outputDir: options.outputDir,
    host: "127.0.0.1",
    port: 0,
    // What the proxy sends, which is all that can reach the socket.
    allowedHosts: ["localhost"],
    // The tool that closes the browser refuses, as it does for any browser its clients share.
    sharedBrowserContext: true,
  });
  const tools = parts.filteredTools(config);
  const own = options.own
    ? playwright()
        .chromium.connect(options.endpoint)
        .then((browser) => {
          const context = browser.contexts()[0];
          if (!context) throw new Error("The browser has no context to work in.");
          return new AgentsPages(context);
        })
    : undefined;
  own?.catch(() => {});
  listenOnSocket(socket);
  // Its banner names the placeholder address as where it listens. Errors are thrown, not printed.
  const say = console.error;
  console.error = () => {};
  try {
    await parts.start(
      {
        name: "Playwright",
        nameInConfig: "playwright",
        // playwright-core's, as Playwright MCP's program gives it.
        version: (require("playwright-core/package.json") as { version: string }).version,
        toolSchemas: tools.map((tool) => tool.schema),
        ignoreRoots: config.ignoreRoots,
        /** One for each client's session: a connection of its own to the one browser. */
        create: async () => {
          // The person's browser: its one connection stays when a session ends.
          if (own) {
            const { context, dispose } = (await own).session();
            return new parts.BrowserBackend(config, context, tools, { dispose });
          }
          const browser: Browser = await playwright().chromium.connect(options.endpoint);
          const context = browser.contexts()[0];
          if (!context) {
            await browser.close();
            throw new Error("The browser has no context to work in.");
          }
          // When the session ends it leaves the browser as it is.
          return new parts.BrowserBackend(config, context, tools, {
            dispose: () => browser.close(),
          });
        },
      },
      config.server,
    );
  } finally {
    console.error = say;
  }
  // The line the service reads to find it.
  process.stdout.write(`${JSON.stringify({ socket })}\n`);
}
