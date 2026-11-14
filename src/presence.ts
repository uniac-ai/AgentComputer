// Who has acted on what of a computer lately: the person, through a live view at operate, and its
// agent, through its endpoints. It is kept only to be shown, to each of them: nothing is refused
// by it, and nothing rests on who did a thing. This computer's files are the machine's, so every
// computer attached to it shares one board for them, and each sees the person and the others'
// agents acting there.
import type { components } from "./generated/schema.js";

type Acting = components["schemas"]["Acting"];

/** Acting now is acting within this long. */
export const ACTING_MS = 10_000;

/** What of the computer an action is on. */
export type Where =
  | { capability: "terminal"; terminal: string }
  | { capability: "files" | "browser" };

/** Who acted: the person, or an agent, by its computer's id and name. */
type Actor = { who: "person" } | { who: "agent"; id: string; name: string };

/** What every computer attached to the machine shares. The screen joins it once it is reached. */
const MACHINE: ReadonlySet<Where["capability"]> = new Set(["files"]);

/** How a person and an agent read where it was. */
const named = (where: Where) =>
  where.capability === "terminal" ? `terminal ${where.terminal}` : `the ${where.capability}`;
const actorKey = (actor: Actor) => (actor.who === "person" ? "person" : `agent ${actor.id}`);
const PERSON_DID: Record<Where["capability"], string> = {
  terminal: "used this terminal",
  files: "wrote a file here",
  browser: "used the browser",
};
const ofActor = (actor: Actor) => (actor.who === "person" ? "The person" : actor.name);

interface Entry {
  actor: Actor;
  where: Where;
  at: number;
  timer: NodeJS.Timeout;
}

/** Who last acted on what, until 10 s after, and the way to hear each start and stop. */
export class Board {
  readonly entries = new Map<string, Entry>();
  readonly #listeners = new Set<() => void>();

  acted(actor: Actor, where: Where) {
    const key = `${actorKey(actor)} ${named(where)}`;
    const before = this.entries.get(key);
    clearTimeout(before?.timer);
    const timer = setTimeout(() => {
      this.entries.delete(key);
      this.#changed();
    }, ACTING_MS);
    timer.unref();
    this.entries.set(key, { actor, where, at: Date.now(), timer });
    if (!before) this.#changed();
  }

  onChange(listener: () => void) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  close() {
    for (const { timer } of this.entries.values()) clearTimeout(timer);
    this.entries.clear();
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

/** One computer's presence: its own board, and the machine's where it is attached to it. */
export class Presence {
  readonly #agent: Actor;
  readonly #own = new Board();
  readonly #machine: Board | undefined;
  /** When the agent last called on each thing, while that can still matter. */
  readonly #called = new Map<string, number>();
  readonly #listeners = new Set<() => void>();
  readonly #unhear: () => void;

  /** `id` and `name` are its computer's; `machine` is the board of the machine it is attached to. */
  constructor(id: string, name: string, machine?: Board) {
    this.#agent = { who: "agent", id, name };
    this.#machine = machine;
    const changed = () => {
      for (const listener of this.#listeners)
        try {
          listener();
        } catch {
          // A listener that fails doesn't stop the others.
        }
    };
    const unhearOwn = this.#own.onChange(changed);
    const unhearMachine = machine?.onChange(changed);
    this.#unhear = () => {
      unhearOwn();
      unhearMachine?.();
    };
  }

  #board(where: Where) {
    return this.#machine && MACHINE.has(where.capability) ? this.#machine : this.#own;
  }

  /** Someone acted: the person, or this computer's agent. */
  acted(who: "person" | "agent", where: Where) {
    this.#board(where).acted(who === "person" ? { who } : this.#agent, where);
  }

  /**
   * The agent called on `where`, acting there unless `acts` is false, as when it only waits on a
   * command: the line to add to its answer, where anyone else acted there since its last call on
   * it, naming each of them.
   */
  agentCalled(where: Where, acts = true): string | undefined {
    const key = named(where);
    const at = Date.now();
    const since = this.#called.get(key);
    // A call longer ago than anyone is remembered acting tells nothing more than none.
    for (const [one, when] of this.#called) if (at - when > ACTING_MS) this.#called.delete(one);
    this.#called.set(key, at);
    if (acts) this.acted("agent", where);
    // Each of them, the most recent first: the board keeps one entry for each one and thing.
    const others = [...this.#board(where).entries.values()]
      .filter(
        (one) =>
          named(one.where) === key &&
          actorKey(one.actor) !== actorKey(this.#agent) &&
          (since === undefined || one.at > since),
      )
      .sort((a, b) => b.at - a.at)
      .map(({ actor, at: when }) => {
        const did = actor.who === "person" ? PERSON_DID[where.capability] : `used ${key} here`;
        return `${ofActor(actor)} ${did} ${Math.max(1, Math.round((at - when) / 1000))} s ago.`;
      });
    return others.length > 0 ? others.join(" ") : undefined;
  }

  /** Who is acting now, on what, the most recent first. */
  acting(): Acting[] {
    return this.#entries()
      .sort((a, b) => b.at - a.at)
      .map(({ actor, where, at }) => ({
        who: actor.who,
        ...(actor.who === "agent" ? { name: actor.name } : {}),
        ...where,
        at: new Date(at).toISOString(),
      }));
  }

  /** Who else is acting now, as `about` tells the agent: each one, and on what. */
  othersForAbout() {
    const others = new Map<string, { actor: Actor; on: string[] }>();
    for (const { actor, where } of this.#entries()) {
      if (actorKey(actor) === actorKey(this.#agent)) continue;
      const one = others.get(actorKey(actor)) ?? { actor, on: [] };
      one.on.push(named(where));
      others.set(actorKey(actor), one);
    }
    if (others.size === 0) return "Nobody else";
    return [...others.values()]
      .map(({ actor, on }) => `${ofActor(actor)}: ${on.join(", ")}`)
      .join("; ");
  }

  /** Hear each change in who is acting, on this computer or on what it shares. */
  onChange(listener: () => void) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** It stops: what it shares stays with the machine, to end in its own time. */
  close() {
    this.#unhear();
    this.#own.close();
    this.#listeners.clear();
  }

  #entries() {
    return [...this.#own.entries.values(), ...(this.#machine?.entries.values() ?? [])];
  }
}
