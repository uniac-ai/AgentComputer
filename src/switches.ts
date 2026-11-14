// The person's own switch for each part of this machine an agent can use: its terminal, its files,
// its screen and their own browser. They are kept in the service's folder, so they last across a
// restart. A service that only lends its machine, as the app that lends a Mac runs it, starts with
// every one off, and the person turns each on; any other starts with every one on, since nothing
// else shows them.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { components } from "./generated/schema.js";
import { writePrivate } from "./store.ts";

export type Switch = components["schemas"]["Switch"];
export const SWITCHES: Switch[] = ["terminal", "files", "screen", "browser"];

/**
 * The switches kept, or, where the file isn't an object of switches each on or off, every one off,
 * and why said once.
 */
function kept(file: string): Partial<Record<Switch, boolean>> {
  try {
    const read: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (
      read &&
      typeof read === "object" &&
      !Array.isArray(read) &&
      Object.entries(read).every(
        ([which, on]) => SWITCHES.includes(which as Switch) && typeof on === "boolean",
      )
    )
      return read;
  } catch {
    // Said below.
  }
  process.stderr.write(`The switches in ${file} can't be read: every one is off until set.\n`);
  return Object.fromEntries(SWITCHES.map((which) => [which, false]));
}

/** How the refusal names each. */
const WHAT: Record<Switch, string> = {
  terminal: "the terminal",
  files: "the files",
  screen: "the screen",
  browser: "their own browser",
};

export class Switches {
  readonly #file: string;
  readonly #lend: boolean;
  /** Only those the person set: the rest take the default of the way the service was started. */
  readonly #set: Partial<Record<Switch, boolean>>;

  /** `folder` is the service's own; `lend`, whether it only lends its machine. */
  constructor(folder: string, lend: boolean) {
    this.#file = join(folder, "switches.json");
    this.#lend = lend;
    this.#set = existsSync(this.#file) ? kept(this.#file) : {};
  }

  on(which: Switch) {
    return this.#set[which] ?? !this.#lend;
  }

  set(which: Switch, on: boolean) {
    this.#set[which] = on;
    writePrivate(this.#file, JSON.stringify(this.#set));
  }

  /**
   * Why an agent can't use it now: that the person turned it off. This is the one place a switch
   * keeps agents out; everything that refuses asks it.
   */
  refused(which: Switch): string | undefined {
    if (this.on(which)) return undefined;
    const where = process.platform === "darwin" ? "this Mac" : "this machine";
    return `The person turned off ${WHAT[which]} for agents on ${where}.`;
  }
}
