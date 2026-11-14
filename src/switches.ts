// The person's own switch for each part of this machine an agent can use: its terminal, its files,
// its screen and their own browser. They are kept in the service's folder, so they last across a
// restart. A service that only lends its machine, as the app that lends a Mac runs it, starts with
// every one off, and the person turns each on; any other starts with every one on, as before,
// since nothing else shows them.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writePrivate } from "./store.ts";

export type Switch = "terminal" | "files" | "screen" | "browser";
export const SWITCHES: Switch[] = ["terminal", "files", "screen", "browser"];

/** How the refusal names each. */
const WHAT: Record<Switch, string> = {
  terminal: "the terminal",
  files: "the files",
  screen: "the screen",
  browser: "their own browser",
};

export class Switches {
  readonly #file: string;
  readonly #on: Record<Switch, boolean>;

  /** `folder` is the service's own; `lend`, whether it only lends its machine. */
  constructor(folder: string, lend: boolean) {
    this.#file = join(folder, "switches.json");
    const kept = existsSync(this.#file)
      ? (JSON.parse(readFileSync(this.#file, "utf8")) as Partial<Record<Switch, boolean>>)
      : {};
    this.#on = Object.fromEntries(
      SWITCHES.map((one) => [one, typeof kept[one] === "boolean" ? kept[one] : !lend]),
    ) as Record<Switch, boolean>;
  }

  on(which: Switch) {
    return this.#on[which];
  }

  set(which: Switch, on: boolean) {
    this.#on[which] = on;
    writePrivate(this.#file, JSON.stringify(this.#on));
  }

  /**
   * Why an agent can't use it now: that the person turned it off. This is the one place a switch
   * keeps agents out; everything that refuses asks it.
   */
  refused(which: Switch): string | undefined {
    if (this.#on[which]) return undefined;
    const where = process.platform === "darwin" ? "this Mac" : "this machine";
    return `The person turned off ${WHAT[which]} for agents on ${where}.`;
  }
}
