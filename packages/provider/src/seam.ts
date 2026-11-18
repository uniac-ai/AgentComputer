// The seam between the provider and the kinds of computer it keeps: what each kind declares of
// itself, which is all the provider knows of it. A kind may answer operations of its own and take
// sockets of its own; how it runs its computers, the provider never knows.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type { components } from "@agentorg/computer-contract/schema";
import type { Handlers } from "./handlers.ts";

type Schemas = components["schemas"];
type Surface = Schemas["Surface"];
type LiveMode = Schemas["LiveMode"];
type SurfaceInfo = Schemas["SurfaceInfo"];
/** What a computer that is starting waits on, and how far that has come where it counts. */
export interface Starting {
  reason: string;
  progress: Schemas["Progress"] | null;
}
export type Access = Schemas["Access"];
export type Isolation = Schemas["Isolation"];
/** What a computer run one way offers, and whether one can be run that way now. */
export type Offer = Schemas["Offer"];
export type Endpoint = "computer" | "browser" | "screen";

export interface ComputerSpec {
  id: string;
  /** What its agent is called, as a person is shown it. */
  name: string;
  access: Access;
  /** A headless browser of its own, or the person's own. */
  browser: boolean | "own";
  /** Whether its agent has the machine's screen, which only this computer can. */
  screen?: boolean | undefined;
  /**
   * Whether it is started again, as when the service starts or it is started after a stop, rather
   * than made or attached: one started again keeps its terminal, files and browser where its screen
   * can't be used now.
   */
  again?: boolean | undefined;
  workspace?: string | undefined;
  /** Its workspace and its machine as they are outside, where this is inside a container. */
  outside?: { workspace?: string | undefined; machine?: string | undefined } | undefined;
}

export interface RuntimeEvents {
  log(line: string): void;
  /** It stopped working without being asked to. */
  failed(reason: string): void;
}

export interface Running {
  /** The tools its browser offers, read once it is up. */
  readonly browserTools: string[];
  /** The version of the program it runs, where the runtime says. */
  readonly version?: string | undefined;
  /** What it can open live. */
  readonly surfaces: SurfaceInfo[];
  handle(endpoint: Endpoint, request: IncomingMessage, response: ServerResponse): Promise<void>;
  /** Take an upgraded request as a live socket on one surface. */
  openLive(
    surface: Surface,
    mode: LiveMode,
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void>;
  stop(): Promise<void>;
}

/** Operations of the contract a kind answers itself, by operationId. */
export type Brought = Partial<Handlers>;
/** A socket a kind takes, once the control token is checked. */
export type Taken = (request: IncomingMessage, socket: Duplex, head: Buffer, url: URL) => void;

/** A kind of computer: all the provider knows of one, which it declares. */
export interface Runtime {
  /** The name its computers have in the contract, `isolation`, and are recorded by. */
  readonly isolation: Isolation;
  /** Whether its computer is this machine, attached, rather than made by create. */
  readonly attaches: boolean;
  /** Why one isn't made, said to whoever asks to make one: a kind that attaches says it. */
  readonly notMade?: string | undefined;
  /** The tools a computer's endpoints offer: its files and terminal's, by access, and its screen's. */
  tools(spec: { access: Access }): { computer: string[]; screen: string[] };
  /** How the service is reached, told once before anything starts. */
  reached?(how: { onlyThisMachine: boolean; proxied: boolean }): void;
  /** Why a computer of this kind can't be started now, where it can't. */
  refused?(): string | undefined;
  /** Operations of the contract it answers itself. */
  readonly operations?: Brought | undefined;
  /** Sockets it takes, by their path. */
  readonly sockets?: Record<string, Taken> | undefined;
  /** Let go of what it holds, as the service stops. */
  close?(): void;
  /** What a computer run this way offers, and whether one can be now. */
  offer(): Promise<Offer>;
  /** Check what it needs, before a computer is started this way, and fetch what it lacks. */
  prepare(): Promise<void>;
  /** What a computer starting this way is waiting on, and how far it has come where that counts. */
  starting(): Starting;
  /** Start one, or start it again, its private folder being `folder`. */
  start(spec: ComputerSpec, folder: string, events: RuntimeEvents): Promise<Running>;
  /** Stop one left going by a service that ended without stopping it, or say why not. */
  stopLeftover(id: string): Promise<void>;
  /** Remove what running it left behind, apart from its folder, or say why that can't be done. */
  remove(id: string): Promise<void>;
}
