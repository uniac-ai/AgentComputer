// Who has acted on what of a computer lately: the person, through a live view at operate, and its
// agent, through its endpoints. It is kept only to be shown, to each of them: nothing is refused
// by it, and nothing rests on who did a thing.
import type { components } from "./generated/schema.js";

type Acting = components["schemas"]["Acting"];

/** Acting now is acting within this long. */
export const ACTING_MS = 10_000;

/** What of the computer an action is on. */
export type Where =
  | { capability: "terminal"; terminal: string }
  | { capability: "files" | "browser" };

/** How a person and an agent read where it was. */
const named = (where: Where) =>
  where.capability === "terminal" ? `terminal ${where.terminal}` : `the ${where.capability}`;
const DID: Record<Where["capability"], string> = {
  terminal: "used this terminal",
  files: "wrote a file here",
  browser: "used the browser",
};

export class Presence {
  /** The agent's name, as the person is shown it. */
  readonly #name: string;
  /** When each acted last on each thing, by who and where. */
  readonly #last = new Map<
    string,
    { who: Acting["who"]; where: Where; at: number; timer: NodeJS.Timeout }
  >();
  /** When the agent last called on each thing, while that can still matter. */
  readonly #called = new Map<string, number>();
  readonly #listeners = new Set<() => void>();

  constructor(name: string) {
    this.#name = name;
  }

  /** Someone acted. A change is heard when one starts acting on something, and when one stops. */
  acted(who: Acting["who"], where: Where) {
    const key = `${who} ${named(where)}`;
    const before = this.#last.get(key);
    clearTimeout(before?.timer);
    const timer = setTimeout(() => {
      this.#last.delete(key);
      this.#changed();
    }, ACTING_MS);
    timer.unref();
    this.#last.set(key, { who, where, at: Date.now(), timer });
    if (!before) this.#changed();
  }

  /**
   * The agent called on `where`, acting there unless `acts` is false, as when it only waits on a
   * command: the line to add to its answer, where the person acted there since its last call on it.
   */
  agentCalled(where: Where, acts = true): string | undefined {
    const key = named(where);
    const at = Date.now();
    const since = this.#called.get(key);
    // A call longer ago than anyone is remembered acting tells nothing more than none.
    for (const [one, when] of this.#called) if (at - when > ACTING_MS) this.#called.delete(one);
    this.#called.set(key, at);
    if (acts) this.acted("agent", where);
    const person = this.#last.get(`person ${key}`);
    if (!person || (since !== undefined && person.at <= since)) return undefined;
    return `The person ${DID[where.capability]} ${Math.max(1, Math.round((at - person.at) / 1000))} s ago.`;
  }

  /** Who is acting now, on what, the most recent first. */
  acting(): Acting[] {
    return [...this.#last.values()]
      .sort((a, b) => b.at - a.at)
      .map(({ who, where, at }) => ({
        who,
        ...(who === "agent" ? { name: this.#name } : {}),
        ...where,
        at: new Date(at).toISOString(),
      }));
  }

  /** Who else is acting now, as `about` tells the agent. */
  othersForAbout() {
    const person = [...this.#last.values()].filter((one) => one.who === "person");
    if (person.length === 0) return "Nobody else";
    return `The person: ${person.map((one) => named(one.where)).join(", ")}`;
  }

  /** Hear each change in who is acting. Returns the way to stop. */
  onChange(listener: () => void) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  close() {
    for (const { timer } of this.#last.values()) clearTimeout(timer);
    this.#last.clear();
    this.#listeners.clear();
  }

  #changed() {
    for (const listener of this.#listeners)
      try {
        listener();
      } catch {
        // A listener that fails doesn't stop the others.
      }
  }
}
