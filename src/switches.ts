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
/** Each part as the app's setup names it, where the service is told where that is. */
const PART: Record<Switch, string> = {
  terminal: "Terminal",
  files: "Files",
  screen: "Screen",
  browser: "Your browser",
};

export class Switches {
  /** The service's own folder, where they are kept. */
  readonly folder: string;
  readonly #file: string;
  readonly #lend: boolean;
  /** Only those the person set: the rest take the default of the way the service was started. */
  readonly #set: Partial<Record<Switch, boolean>>;
  readonly #setupIn: string | undefined;

  /**
   * `folder` is the service's own; `lend`, whether it only lends its machine; `setupIn`, where the
   * person switches each part, as the app hosting the service names it (`serve --setup-in`).
   */
  constructor(folder: string, lend: boolean, setupIn?: string) {
    this.folder = folder;
    this.#file = join(folder, "switches.json");
    this.#lend = lend;
    this.#setupIn = setupIn;
    this.#set = existsSync(this.#file) ? kept(this.#file) : {};
  }

  /** Whether the service only lends this machine, as the app that lends a Mac runs it. */
  get lends() {
    return this.#lend;
  }

  on(which: Switch) {
    return this.#set[which] ?? !this.#lend;
  }

  set(which: Switch, on: boolean) {
    this.#set[which] = on;
    writePrivate(this.#file, JSON.stringify(this.#set));
  }

  /**
   * Why an agent can't use it now: that the person turned it off, and, where the app hosting the
   * service said where its setup is, where it is switched on. This is the one place a switch keeps
   * agents out; everything that refuses asks it.
   */
  refused(which: Switch): string | undefined {
    if (this.on(which)) return undefined;
    const where = process.platform === "darwin" ? "this Mac" : "this machine";
    const turnedOff = `The person turned off ${WHAT[which]} for agents on ${where}.`;
    return this.#setupIn
      ? `${turnedOff} It is switched on in ${this.#setupIn}, ${PART[which]}.`
      : turnedOff;
  }
}
