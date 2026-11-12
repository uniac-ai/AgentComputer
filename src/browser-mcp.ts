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
import type { Browser, BrowserContext } from "playwright-core";
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
}

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
