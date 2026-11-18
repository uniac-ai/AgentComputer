// The operations openapi.yaml defines, one function each. A new operation doesn't compile until it
// has one here, and both the HTTP API and the MCP control tools call these.

import { ApiError } from "@agentorg/computer-base/error";
import { VERSION } from "@agentorg/computer-base/version";
import type { operations } from "@agentorg/computer-contract/schema";
import type { Computers } from "./computers.ts";
import type { Runtime } from "./seam.ts";

type Json<T> = T extends { content: { "application/json": infer B } } ? B : never;
type Fields<T> = [NonNullable<T>] extends [never] ? object : NonNullable<T>;
type Input<K extends keyof operations> = Fields<operations[K]["parameters"]["path"]> &
  Fields<operations[K]["parameters"]["query"]> &
  Fields<Json<NonNullable<operations[K]["requestBody"]>>>;
type Success<R> = R extends { 200: infer A }
  ? Json<A>
  : R extends { 201: infer A }
    ? Json<A>
    : undefined;
export type Handlers = {
  [K in keyof operations]: (input: Input<K>) => Promise<Success<operations[K]["responses"]>>;
};

export function createHandlers(computers: Computers, kinds: Runtime[]): Handlers {
  return {
    // What the kinds answer themselves: this computer's setup, who is connected and who is acting.
    ...(Object.assign({}, ...kinds.map((kind) => kind.operations ?? {})) as Partial<Handlers>),
    getInfo: async () => ({ version: VERSION, ...(await computers.offers()) }),
    listComputers: async ({ state }) => computers.list(state),
    createComputer: (input) => computers.create(input),
    attachComputer: (input) => computers.attach(input),
    getComputer: async ({ computerID }) => computers.get(computerID),
    killComputer: async ({ computerID }) => {
      await computers.kill(computerID);
      return undefined;
    },
    setComputerTimeout: async ({ computerID, timeout }) =>
      computers.setTimeout(computerID, timeout),
    stopComputer: ({ computerID }) => computers.stop(computerID),
    startComputer: ({ computerID, timeout }) => computers.start(computerID, timeout),
    getComputerLogs: async ({ computerID }) => ({ logs: computers.logs(computerID) }),
    createLiveSession: async ({ computerID, surface, mode }) =>
      computers.liveSession(computerID, surface, mode ?? "watch"),
    openLiveSession: async () => {
      throw new ApiError(426, "Open it as a WebSocket.");
    },
  } as Handlers;
}
