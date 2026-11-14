// The operations openapi.yaml defines, one function each. A new operation doesn't compile until it
// has one here, and both the HTTP API and the MCP control tools call these.
import type { Computers } from "./computers.ts";
import type { Connections } from "./connection.ts";
import type { operations } from "./generated/schema.js";
import { ApiError } from "./runtime.ts";
import type { Setup } from "./setup.ts";

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
type Handlers = {
  [K in keyof operations]: (input: Input<K>) => Promise<Success<operations[K]["responses"]>>;
};

export const VERSION = "0.0.19";

export function createHandlers(
  computers: Computers,
  connections: Connections,
  setup: Setup,
): Handlers {
  return {
    getInfo: async () => ({ version: VERSION, ...(await computers.offers()) }),
    getConnection: async () => connections.state(),
    getSetup: () => setup.capabilities(),
    setSetup: ({ capability, on }) => setup.set(capability, on),
    askSetup: ({ capability, need }) => setup.ask(capability, need),
    getActing: async () => computers.acting(),
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
  };
}
