// The screen, live: PNG frames of the whole screen to whoever watches it, and at operate a
// person's input to it. It reaches Cua Driver through a connection of its own, open only while
// someone watches: the frames are smaller than the screen, and the driver reads points against
// the last picture each connection took, so the agent's points stay read against its own.
import type { WebSocket } from "ws";
import { z } from "zod";
import { reason } from "./files-live.ts";
import type { components } from "./generated/schema.js";
import { type Answer, DESKTOP, Driver, type DriverAt, driverCall } from "./screen.ts";

type Mode = components["schemas"]["LiveMode"];
type ScreenEvent = components["schemas"]["ScreenEvent"];

/** How often the screen is taken while anyone watches. */
const EVERY_MS = 500;
/** The longest side of a frame, in pixels. */
const MAX_SIDE = 1280;
/** A socket further behind than this is sent nothing until it catches up. */
const MAX_BUFFERED = 4 * 1024 * 1024;
/** The most input a socket may have waiting to be done; more is refused. */
const MAX_WAITING = 32;
const MALFORMED = "That isn't a screen@1 message.";
const SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");

const PersonInput = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("mouse"),
    action: z.enum(["click", "double_click", "right_click", "drag", "scroll"]),
    x: z.number(),
    y: z.number(),
    to_x: z.number().optional(),
    to_y: z.number().optional(),
    direction: z.enum(["up", "down", "left", "right"]).optional(),
    amount: z.number().int().positive().optional(),
  }),
  z.object({ type: z.literal("key"), keys: z.array(z.string().min(1)).min(1) }),
  z.object({ type: z.literal("text"), text: z.string().min(1) }),
]);

/**
 * A person's input, as the driver's tool that does it and its arguments. A point is in pixels of
 * the frames, as the agent's are in its picture of the whole screen; keys and text go to the
 * window in front.
 */
export function personCall(sent: unknown): [string, Record<string, unknown>] {
  const input = PersonInput.safeParse(sent);
  if (!input.success) throw new Error(MALFORMED);
  const message = input.data;
  // The person's pointer is the real one, which acts only in the foreground.
  if (message.type === "mouse") {
    const { type: _, ...act } = message;
    return driverCall({ ...act, delivery_mode: "foreground" });
  }
  if (message.type === "text") return ["type_text", { target: DESKTOP, text: message.text }];
  const [key, ...more] = message.keys;
  return more.length === 0
    ? ["press_key", { target: DESKTOP, key }]
    : ["hotkey", { target: DESKTOP, keys: message.keys }];
}

interface Frame {
  png: Buffer;
  width: number;
  height: number;
}

/** One socket on the surface, and what it was last sent. */
interface Viewer {
  mode: Mode;
  frame?: Frame | undefined;
  /** The size event it was last sent, as sent. */
  sizeEvent?: string | undefined;
  /** Its input, each step in order, and how many are waiting. */
  steps: Promise<unknown>;
  waiting: number;
}

/** The PNG in a driver's answer, with its size from its own header. None where it has none. */
function frameOf(answer: Answer): Frame | undefined {
  const image = answer.content?.find(
    (part): part is { type: "image"; data: string } => (part as { type?: string }).type === "image",
  );
  if (answer.isError || !image) return undefined;
  const png = Buffer.from(image.data, "base64");
  if (png.length < 24 || !png.subarray(0, 8).equals(SIGNATURE)) return undefined;
  return { png, width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

const said = (answer: Answer) =>
  (answer.content ?? [])
    .flatMap((part) =>
      (part as { type?: string }).type === "text" ? [(part as { text: string }).text] : [],
    )
    .join("\n") || "Cua Driver refused it.";

export class ScreenLive {
  /** Where Cua Driver is. */
  readonly #at: DriverAt;
  readonly #log: (line: string) => void;
  /** Heard each time a person acts on the screen. */
  readonly #acted: () => void;
  readonly #viewers = new Map<WebSocket, Viewer>();
  #driver: Driver | undefined;
  #started: Promise<Driver> | undefined;
  #timer: NodeJS.Timeout | undefined;
  /** The connection a picture is being taken on. */
  #taking: Driver | undefined;
  /** The last frame, kept until the picture changes. */
  #frame: Frame | undefined;

  constructor(driver: DriverAt, log: (line: string) => void, acted: () => void) {
    this.#at = driver;
    this.#log = log;
    this.#acted = acted;
  }

  /** screen@1: a frame now and at each change, and at operate a person's input. */
  open(ws: WebSocket, mode: Mode) {
    const viewer: Viewer = { mode, steps: Promise.resolve(), waiting: 0 };
    this.#viewers.set(ws, viewer);
    ws.on("close", () => {
      if (this.#viewers.delete(ws) && this.#viewers.size === 0) void this.#end();
    });
    ws.on("message", (data: Buffer, binary: boolean) => {
      if (binary || mode !== "operate") return;
      if (viewer.waiting >= MAX_WAITING) {
        this.#refuse(ws, "Too much is waiting to be done on the screen. Send it again.");
        return;
      }
      viewer.waiting++;
      viewer.steps = viewer.steps
        .then(() => this.#input(ws, data.toString()))
        .finally(() => viewer.waiting--);
    });
    this.#begin().then(
      () => this.#send(ws, viewer),
      () => ws.close(1011, "Cua Driver can't be reached."),
    );
  }

  close() {
    this.#leave(1001, "It stopped.");
  }

  /** Every socket closed, and so the driver's connection. */
  #leave(code: number, why: string) {
    const sockets = [...this.#viewers.keys()];
    this.#viewers.clear();
    for (const ws of sockets) ws.close(code, why);
    void this.#end();
  }

  /** The driver, connected once for everyone watching, and the frames it is taken for. */
  #begin() {
    if (this.#started) return this.#started;
    const driver = new Driver(this.#at, this.#log, () => {
      if (this.#driver === driver) this.#leave(1011, "Cua Driver stopped.");
    });
    this.#driver = driver;
    const started = driver.ready().then(async () => {
      if (this.#driver === driver) {
        this.#timer = setInterval(() => void this.#take(driver), EVERY_MS);
        await this.#take(driver);
      }
      return driver;
    });
    this.#started = started;
    // One that didn't start is tried afresh by the next socket.
    started.catch(() => {
      if (this.#started === started) void this.#end();
    });
    return started;
  }

  /** With nobody left watching, the driver's connection goes. */
  async #end() {
    const driver = this.#driver;
    clearInterval(this.#timer);
    this.#driver = this.#started = this.#timer = this.#frame = undefined;
    await driver?.stop();
  }

  /** One picture at a time on a connection, and kept only while that connection is the one. */
  async #take(driver: Driver) {
    if (this.#taking === driver) return;
    this.#taking = driver;
    try {
      const frame = frameOf(
        await driver.call("get_desktop_state", { max_image_dimension: MAX_SIDE }),
      );
      if (this.#driver !== driver || !frame) return;
      // A picture that hasn't changed is the same frame, so nobody is sent it again.
      if (!this.#frame?.png.equals(frame.png)) this.#frame = frame;
      for (const [ws, viewer] of this.#viewers) this.#send(ws, viewer);
    } catch {
      // One that couldn't be taken is left; the next is taken in its turn.
    } finally {
      if (this.#taking === driver) this.#taking = undefined;
    }
  }

  /** The last frame, to a socket that hasn't had it, with its size first where that changed. */
  #send(ws: WebSocket, viewer: Viewer) {
    const frame = this.#frame;
    if (!frame || viewer.frame === frame || ws.bufferedAmount > MAX_BUFFERED) return;
    const sizeEvent = JSON.stringify({
      type: "size",
      width: frame.width,
      height: frame.height,
    } satisfies ScreenEvent);
    if (viewer.sizeEvent !== sizeEvent) ws.send(sizeEvent);
    ws.send(frame.png, { binary: true });
    viewer.sizeEvent = sizeEvent;
    viewer.frame = frame;
  }

  #refuse(ws: WebSocket, message: string) {
    ws.send(JSON.stringify({ type: "refused", message } satisfies ScreenEvent));
  }

  /**
   * A person's step, done by the driver; what isn't done is answered to the socket that sent it.
   * Input from a socket that has gone, or once the driver has, is left undone: it never starts one.
   */
  async #input(ws: WebSocket, data: string) {
    const started = this.#started;
    if (!started || !this.#viewers.has(ws)) return;
    try {
      const [tool, args] = personCall(JSON.parse(data));
      const answer = await (await started).call(tool, args);
      if (answer.isError) this.#refuse(ws, said(answer));
      else this.#acted();
    } catch (error) {
      this.#refuse(ws, error instanceof SyntaxError ? MALFORMED : reason(error));
    }
  }
}
