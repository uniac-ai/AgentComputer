// The operations openapi.yaml defines, one function each. A new operation doesn't compile until it
// has one here, and both the HTTP API and the MCP control tools call these.
import type { Computers } from "./computers.ts";
import type { operations } from "./generated/schema.js";
import { ApiError } from "./runtime.ts";

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

export const VERSION = "0.0.17";

export function createHandlers(computers: Computers): Handlers {
  return {
    getInfo: async () => ({
      version: VERSION,
      isolation: computers.isolation,
      isolationsAvailable: await computers.available(),
    }),
    listComputers: async ({ state }) => computers.list(state),
    createComputer: (input) => computers.create(input),
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
