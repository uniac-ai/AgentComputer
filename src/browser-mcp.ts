// Playwright MCP for a browser it doesn't own. Its own program takes the browser to be its to
// close: when a client's session ends, and when the agent calls browser_close, it closes the
// browser's context, which for a computer's browser is the browser. A computer's browser lives as
// long as its computer, whatever its clients do. So this serves the same tools from the same
// server, with a backend that only disconnects.
//
// It is built from the parts Playwright MCP's own program is built from, which are not a public
// interface. A test checks that they are there and that the server starts and lists its tools.
//
// When @playwright/mcp and playwright-core move, read this beside that program again: the action
// of `decorateMCPCommand`, in packages/playwright-core/src/tools/mcp/program.ts. What to compare:
// the factory's fields, what BrowserBackend is given, what `sharedBrowserContext` decides (the
// close tool refusing, and nothing else here), and the "Listening on" line that browser.ts reads.
import { createRequire } from "node:module";
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

export async function serveBrowserMcp(options: McpOptions) {
  const parts = mcpParts();
  parts.setupExitWatchdog();
  const config = await parts.resolveCLIConfigForMCP({
    endpoint: options.endpoint,
    outputDir: options.outputDir,
    host: "127.0.0.1",
    port: 0,
    // The tool that closes the browser refuses, as it does for any browser its clients share.
    sharedBrowserContext: true,
  });
  const tools = parts.filteredTools(config);
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
}
