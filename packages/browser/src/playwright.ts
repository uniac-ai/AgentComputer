// playwright-core, loaded beside the program rather than bundled. The browser host, the agent's
// tools and the live view all use this one copy, so they speak the same protocol. Its version is
// the one a release of @playwright/mcp brings, pinned in package.json and checked by a test.
import { createRequire } from "node:module";

export type Playwright = typeof import("playwright-core");

let loaded: Playwright | undefined;
export const playwright = (): Playwright => {
  loaded ??= createRequire(import.meta.url)("playwright-core") as Playwright;
  return loaded;
};

/** Playwright's browser channel when none is named: the Google Chrome installed on the machine. */
export const DEFAULT_CHANNEL = "chrome";

interface Registry {
  findExecutable(
    name: string,
  ): { executablePath(language: string): string | undefined } | undefined;
}

/**
 * Where Playwright finds a browser channel's program on this machine, if it is installed there.
 * Its registry isn't part of its documented interface, so a test checks it at each pin.
 */
export const channelProgram = (channel: string): string | undefined =>
  (
    createRequire(import.meta.url)("playwright-core/lib/coreBundle") as {
      registry: { registry: Registry };
    }
  ).registry.registry
    .findExecutable(channel)
    ?.executablePath("javascript");
