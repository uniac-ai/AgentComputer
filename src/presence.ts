// Who has acted on what of a computer lately: the person, through a live view at operate, and its
// agent, through its endpoints. A command the agent started is acting on its terminal until it
// ends, as the terminal shows it running. It is kept only to be shown, to each of them: nothing is
// refused by it, and nothing rests on who did a thing. Computers attached to the same machine share
// its files, so they share one board for them, and each is shown the person and the other
// computers' agents acting there.
import type { components } from "./generated/schema.js";

type Acting = components["schemas"]["Acting"];

/** Acting now is acting within this long. */
export const ACTING_MS = 10_000;

/** What of the computer an action is on. */
export type Where =
  | { capability: "terminal"; terminal: string }
  | { capability: "files" | "browser" | "screen" };

/** Who acted: the person, or an agent, by its computer's id and name. */
type Actor = { who: "person" } | { who: "agent"; id: string; name: string };

interface Entry {
  actor: Actor;
  where: Where;
  at: number;
  /** Its 10 s count, while nothing holds it: none while a command started there runs. */
  timer?: NodeJS.Timeout;
  held: boolean;
}

/** How a person and an agent read where it was. */
const named = (where: Where) =>
  where.capability === "terminal" ? `terminal ${where.terminal}` : `the ${where.capability}`;
const actorKey = (actor: Actor) => (actor.who === "person" ? "person" : `agent ${actor.id}`);
const label = (actor: Actor) => (actor.who === "person" ? "The person" : actor.name);
const DID: Record<Where["capability"], string> = {
  terminal: "used this terminal",
  files: "wrote a file here",
  browser: "used the browser",
  screen: "used the screen",
};
/** What one did there, as the agent is told it. */
const did = (actor: Actor, where: Where) =>
  `${label(actor)} ${actor.who === "person" ? DID[where.capability] : `used ${named(where)} here`}`;

/**
 * Who last acted on what, until 10 s after, or, for a command started there, until 10 s after it
 * ends, and the way to hear each start and stop.
 */
export class Board {
  readonly #entries = new Map<string, Entry>();
  readonly #listeners = new Set<() => void>();

  /** An act there: held still where a command runs, and otherwise its 10 s count starts again. */
  acted(actor: Actor, where: Where) {
    this.#set(actor, where, this.#entries.get(this.#key(actor, where))?.held ?? false);
  }

  /** A command started there: acting until it ends, whatever is done there meanwhile. */
  hold(actor: Actor, where: Where) {
    this.#set(actor, where, true);
  }

  /** The command ended: its end is the last act there, and its 10 s count starts now. */
  release(actor: Actor, where: Where) {
    if (this.#entries.get(this.#key(actor, where))?.held) this.#set(actor, where, false);
  }

  #key(actor: Actor, where: Where) {
    return `${actorKey(actor)} ${named(where)}`;
  }

  /** Acting now, held or counting down 10 s. */
  #set(actor: Actor, where: Where, held: boolean) {
    const key = this.#key(actor, where);
    const before = this.#entries.get(key);
    clearTimeout(before?.timer);
    const timer = held
      ? undefined
      : setTimeout(() => {
          this.#entries.delete(key);
          this.#changed();
        }, ACTING_MS);
    timer?.unref();
    this.#entries.set(key, { actor, where, at: Date.now(), timer, held });
    if (!before) this.#changed();
  }

  list() {
    return [...this.#entries.values()];
  }

  /** Hear each change. Returns the way to stop. */
  onChange(listener: () => void) {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  close() {
    for (const { timer } of this.#entries.values()) clearTimeout(timer);
    this.#entries.clear();
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

/** One computer's presence: its own board, and the machine's for the files where it shares them. */
export class Presence {
  readonly #agent: Actor;
  readonly #own = new Board();
  readonly #machine: Board | undefined;
  /** When the agent last called on each thing, while that can still matter. */
  readonly #called = new Map<string, number>();

  /** `id` and `name` are its computer's; `machine` is the board of the machine it is attached to. */
  constructor(id: string, name: string, machine?: Board) {
    this.#agent = { who: "agent", id, name };
    this.#machine = machine;
  }

  #board(where: Where) {
    return this.#machine && where.capability !== "terminal" && where.capability !== "browser"
      ? this.#machine
      : this.#own;
  }

  /** Someone acted: the person, or this computer's agent. */
  acted(who: "person" | "agent", where: Where) {
    this.#board(where).acted(who === "person" ? { who } : this.#agent, where);
  }

  /** The agent started a command on a terminal: it acts there until the command ends. */
  agentCommandStarted(terminal: string) {
    this.#own.hold(this.#agent, { capability: "terminal", terminal });
  }

  /** A command ended: where the agent started it, its 10 s count starts now. */
  commandEnded(terminal: string) {
    this.#own.release(this.#agent, { capability: "terminal", terminal });
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
    // A call longer ago than anyone else is remembered acting tells nothing more than none: only
    // this computer's own agent is ever held, and it isn't named to itself.
    for (const [one, when] of this.#called) if (at - when > ACTING_MS) this.#called.delete(one);
    this.#called.set(key, at);
    if (acts) this.acted("agent", where);
    const told = this.#others()
      .filter((one) => named(one.where) === key && (since === undefined || one.at > since))
      .map(
        (one) => `${did(one.actor, where)} ${Math.max(1, Math.round((at - one.at) / 1000))} s ago.`,
      );
    return told.length > 0 ? told.join(" ") : undefined;
  }

  /** Who is acting now, on what, the most recent first. */
  acting(): Acting[] {
    return this.#all().map(({ actor, where, at }) => ({
      who: actor.who,
      ...(actor.who === "agent" ? { name: actor.name } : {}),
      ...where,
      at: new Date(at).toISOString(),
    }));
  }

  /** Who else is acting now, as `about` tells the agent: each one, and on what, the most recent first. */
  othersForAbout() {
    const others = new Map<string, { actor: Actor; on: string[] }>();
    for (const { actor, where } of this.#others()) {
      const one = others.get(actorKey(actor)) ?? { actor, on: [] };
      one.on.push(named(where));
      others.set(actorKey(actor), one);
    }
    if (others.size === 0) return "Nobody else";
    return [...others.values()]
      .map(({ actor, on }) => `${label(actor)}: ${on.join(", ")}`)
      .join("; ");
  }

  /** Hear each change in who is acting, on this computer or on what it shares. Returns the way to stop. */
  onChange(listener: () => void) {
    const own = this.#own.onChange(listener);
    const machine = this.#machine?.onChange(listener);
    return () => {
      own();
      machine?.();
    };
  }

  /** It stops: what it did on what it shares stays, to end in its own time. */
  close() {
    this.#own.close();
  }

  /** Everyone, on both boards, the most recent first. */
  #all() {
    return [...this.#own.list(), ...(this.#machine?.list() ?? [])].sort((a, b) => b.at - a.at);
  }

  #others() {
    return this.#all().filter((one) => actorKey(one.actor) !== actorKey(this.#agent));
  }
}
