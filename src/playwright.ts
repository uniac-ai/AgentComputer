// playwright-core, loaded beside the program rather than bundled. Its version is the one
// @playwright/mcp brings, pinned in package.json and checked by a test, so the browser host and
// the agent's tools always speak the same protocol.
import { createRequire } from "node:module";

export type Playwright = typeof import("playwright-core");

let loaded: Playwright | undefined;
export const playwright = (): Playwright => {
  loaded ??= createRequire(import.meta.url)("playwright-core") as Playwright;
  return loaded;
};
