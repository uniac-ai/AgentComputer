// Who has acted on what of a computer lately: the person, through a live view at operate, and its
// agent, through its endpoints. The agent's call is acting while it runs, and a command the agent
// started is acting on its terminal until it ends, as the terminal shows it running. Each is
// acting for 10 s after it ends. It is kept only to be shown, to each of them: nothing is
// refused by it, and nothing rests on who did a thing. Computers attached to the same machine share
// its files, so they share one board for them, and each is shown the person and the other
// computers' agents acting there.
import type { components } from "@agentorg/computer-contract/schema";

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
  /** Its 10 s count, while nothing holds it: none while a call or a command there runs. */
  timer?: NodeJS.Timeout;
  /** How many calls and commands there run now. */
  holds: number;
}

/** A call of the agent's: the line for its answer, and the way to say it ended. */
export interface AgentCall {
  line: string | undefined;
  /** It ended: acting there for 10 s more. Once is enough; again does nothing. */
  ended(): void;
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
 * Who last acted on what, until 10 s after, or, while a call or a command there runs, until 10 s
 * after the last of them ends, and the way to hear each start and stop.
 */
export class Board {
  readonly #entries = new Map<string, Entry>();
  readonly #listeners = new Set<() => void>();
  #closed = false;

  /** An act there: held still where something runs, and otherwise its 10 s count starts again. */
  acted(actor: Actor, where: Where) {
    this.#set(actor, where, 0);
  }

  /**
   * A call or a command started there: acting until it ends, whatever is done there meanwhile.
   * Returns the way to say it ended, which makes the end the last act there; once the last that
   * runs there has ended, its 10 s count starts.
   */
  hold(actor: Actor, where: Where) {
    this.#set(actor, where, 1);
    let held = true;
    return () => {
      if (held) this.#set(actor, where, -1);
      held = false;
    };
  }

  #key(actor: Actor, where: Where) {
    return `${actorKey(actor)} ${named(where)}`;
  }

  /** Acting now, `change` more holding it: held, or counting down 10 s. */
  #set(actor: Actor, where: Where, change: number) {
    if (this.#closed) return;
    const key = this.#key(actor, where);
    const before = this.#entries.get(key);
    clearTimeout(before?.timer);
    const holds = Math.max(0, (before?.holds ?? 0) + change);
    const timer =
      holds > 0
        ? undefined
        : setTimeout(() => {
            this.#entries.delete(key);
            this.#changed();
          }, ACTING_MS);
    timer?.unref();
    this.#entries.set(key, { actor, where, at: Date.now(), timer, holds });
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
    this.#closed = true;
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
  /** The way to end each of its calls and commands that runs now. */
  readonly #running = new Set<() => void>();
  /** Of those, each command's, by its terminal. */
  readonly #commands = new Map<string, () => void>();

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

  /** The agent holds `where` on `board` until the way returned is used, or it stops. */
  #hold(board: Board, where: Where) {
    const release = board.hold(this.#agent, where);
    const ended = () => {
      this.#running.delete(ended);
      release();
    };
    this.#running.add(ended);
    return ended;
  }

  /** The agent started a command on a terminal: it acts there until the command ends. */
  agentCommandStarted(terminal: string) {
    this.#commands.get(terminal)?.();
    this.#commands.set(terminal, this.#hold(this.#own, { capability: "terminal", terminal }));
  }

  /** A command ended: where the agent started it, its 10 s count starts now. */
  commandEnded(terminal: string) {
    this.#commands.get(terminal)?.();
    this.#commands.delete(terminal);
  }

  /**
   * The agent calls on `where`: acting there while the call runs, and 10 s after it ends, unless
   * `acts` is false, as when it only waits on a command. Gives the line to add to its answer, where
   * anyone else acted there since its last call on it, naming each of them, and the way to say the
   * call ended.
   */
  agentCalling(where: Where, acts = true): AgentCall {
    const key = named(where);
    const at = Date.now();
    const since = this.#called.get(key);
    // A call longer ago than anyone else is remembered acting tells nothing more than none: only
    // this computer's own agent is ever held, and it isn't named to itself.
    for (const [one, when] of this.#called) if (at - when > ACTING_MS) this.#called.delete(one);
    this.#called.set(key, at);
    const ended = acts ? this.#hold(this.#board(where), where) : () => {};
    const told = this.#others()
      .filter((one) => named(one.where) === key && (since === undefined || one.at > since))
      .map(
        (one) => `${did(one.actor, where)} ${Math.max(1, Math.round((at - one.at) / 1000))} s ago.`,
      );
    return { line: told.length > 0 ? told.join(" ") : undefined, ended };
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

  /**
   * It stops: what it did on what it shares stays, to end in its own time. A call or command of
   * its that still runs there ends now, and is acting there for 10 s more.
   */
  close() {
    for (const ended of [...this.#running]) ended();
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
