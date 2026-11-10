// The browser host: a small process per computer that starts the browser with its profile and
// makes it available on a Unix socket, which the agent's tools and the live viewer both connect
// to. There is no debug port, so no page can reach the browser's protocol.
import { mkdtempSync, rmSync } from "node:fs";
import { join, sep } from "node:path";
import { playwright } from "./playwright.ts";

export interface HostOptions {
  profile: string;
  /** Playwright's browser channel, such as "chrome", when no program is named. */
  channel?: string | undefined;
  executable?: string | undefined;
  /** Chrome's own sandbox. Unset, it's decided as Playwright MCP decides it. */
  sandbox?: boolean | undefined;
}

/** On Linux only branded Chrome gets its sandbox by default, as Playwright MCP has it. */
const sandboxFor = (options: HostOptions) =>
  options.sandbox ??
  (process.platform !== "linux" ||
    (!options.executable &&
      !["chromium", "chrome-for-testing"].includes(options.channel ?? "chrome")));

export async function hostBrowser(options: HostOptions) {
  // Playwright puts the socket under XDG_RUNTIME_DIR, or under the temporary folder when that
  // path would be too long for a socket. A folder of our own, made fresh and readable by its owner
  // alone, keeps anyone else from reaching it or putting one there first. It's under /tmp, which
  // macOS and Linux both have, because a socket's path is limited to about 104 bytes and macOS's
  // temporary folder for a user takes half of that. Both settings point into it, so neither way
  // can leave it.
  const run = mkdtempSync(join("/tmp", "agentcomputer-"));
  process.env.XDG_RUNTIME_DIR = run;
  process.env.TMPDIR = run;
  const context = await playwright().chromium.launchPersistentContext(options.profile, {
    headless: true,
    chromiumSandbox: sandboxFor(options),
    ...(options.executable
      ? { executablePath: options.executable }
      : { channel: options.channel ?? "chrome" }),
  });
  const browser = context.browser();
  if (!browser) throw new Error("The browser can't be shared.");
  const { endpoint } = await browser.bind("agentcomputer");
  // Playwright falls back to a shared folder when a path is too long. Better not to run at all.
  if (!endpoint.startsWith(run + sep)) {
    await context.close();
    throw new Error(`The browser's socket isn't in its own folder: ${endpoint}`);
  }
  process.stdout.write(`${JSON.stringify({ endpoint })}\n`);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await browser.unbind().catch(() => {});
    await context.close().catch(() => {});
    rmSync(run, { recursive: true, force: true });
    process.exit(0);
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => void stop());
  context.on("close", () => void stop());
}
