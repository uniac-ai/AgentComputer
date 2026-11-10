// The browser host: a small process per computer that starts the browser with its profile and
// makes it available on a Unix socket, which the agent's tools and the live viewer both connect
// to. There is no debug port, so no page can reach the browser's protocol.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { playwright } from "./playwright.ts";

export interface HostOptions {
  profile: string;
  /** Playwright's browser channel, such as "chrome", when no program is named. */
  channel?: string | undefined;
  executable?: string | undefined;
  sandbox: boolean;
}

export async function hostBrowser(options: HostOptions) {
  // Playwright puts the socket under XDG_RUNTIME_DIR. A directory of our own, made fresh and
  // readable by its owner alone, keeps anyone else from reaching it or putting one there first.
  const run = mkdtempSync(join(tmpdir(), "agentcomputer-"));
  process.env.XDG_RUNTIME_DIR = run;
  const context = await playwright().chromium.launchPersistentContext(options.profile, {
    headless: true,
    chromiumSandbox: options.sandbox,
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
