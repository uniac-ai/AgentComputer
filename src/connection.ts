// Who is connected to the service: a client that holds a WebSocket open to it, which carries
// nothing but that it is there, as AgentOrg holds one to the service that lends its Mac. With none
// open, the service is waiting to be connected to. A socket that stops answering pings is dropped.
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { type WebSocket, WebSocketServer } from "ws";
import type { components } from "./generated/schema.js";

type Connection = components["schemas"]["Connection"];

/** How often a client is asked whether it is still there. */
const PING_MS = 30_000;
/** The most of a client's name that is kept. */
const MAX_NAME = 100;

/** Loopback, as a socket's address reads: IPv4, IPv6, or IPv4 within IPv6. */
const LOOPBACK = /^(::ffff:)?127\.|^::1$/;

interface Client {
  name: string;
  since: string;
  local: boolean;
  alive: boolean;
}

/** Whether a request came from this machine, by the address it connects from. */
const fromHere = ({ socket }: IncomingMessage) => {
  const address = socket.remoteAddress ?? "";
  return LOOPBACK.test(address) || address === socket.localAddress;
};

export class Connections {
  readonly #server = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  readonly #clients = new Map<WebSocket, Client>();
  readonly #pings: NodeJS.Timeout;
  /** Whether it is behind a proxy, from which every client connects. */
  readonly #proxied: boolean;

  constructor(proxied: boolean) {
    this.#proxied = proxied;
    this.#pings = setInterval(() => {
      for (const [ws, client] of this.#clients) {
        if (!client.alive) ws.terminate();
        else {
          client.alive = false;
          ws.ping();
        }
      }
    }, PING_MS);
    this.#pings.unref();
  }

  /** Hold one open, under the name it gives. What it sends is dropped. */
  open(request: IncomingMessage, socket: Duplex, head: Buffer, name: string) {
    this.#server.handleUpgrade(request, socket, head, (ws) => {
      const client: Client = {
        name: name.slice(0, MAX_NAME),
        since: new Date().toISOString(),
        local: !this.#proxied && fromHere(request),
        alive: true,
      };
      this.#clients.set(ws, client);
      ws.on("pong", () => {
        client.alive = true;
      });
      ws.on("error", () => ws.terminate());
      ws.on("close", () => this.#clients.delete(ws));
    });
  }

  /** Whether anyone is connected, and who, the earliest first, as they came. */
  state(): Connection {
    const clients = [...this.#clients.values()].map(({ name, since, local }) => ({
      name,
      since,
      local,
    }));
    return { connected: clients.length > 0, clients };
  }

  close() {
    clearInterval(this.#pings);
    for (const ws of this.#clients.keys()) ws.close(1001, "It stopped.");
  }
}
