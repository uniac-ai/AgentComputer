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
