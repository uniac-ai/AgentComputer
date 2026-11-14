// The two kinds of computer the tests run each case on: this computer, attached, and a container,
// made, which needs a test image.
type Sdk = typeof import("../src/sdk.ts");
type AttachOpts = import("../src/sdk.ts").AttachOpts;

export type Kind = "this" | "container";

const IMAGE = process.env.AGENTCOMPUTER_TEST_IMAGE;

/** What the service is started with for a container, or undefined where there is no image. */
export const CONTAINER = IMAGE ? ["--image", IMAGE] : undefined;

/** Why a case on this kind is skipped, where what it needs isn't given. */
export const needs = (kind: Kind) =>
  kind === "this" ? "needs AGENTCOMPUTER_BROWSER_PATH" : "needs AGENTCOMPUTER_TEST_IMAGE";

/** How a case names the kind it runs on. */
export const named = (kind: Kind) => (kind === "this" ? "this computer" : "a container");

/** Attach this computer, or make a container, with the same options. */
export const make = (
  Computer: Sdk["Computer"],
  kind: Kind,
  opts: AttachOpts & { browser?: boolean },
) => (kind === "this" ? Computer.attach(opts) : Computer.create(opts));
