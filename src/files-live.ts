// The workspace's files, live: a person's file window lists a folder, reads a file a range at a
// time, asks what changed, and at operate writes a file, all on one socket in files@1. The files
// themselves are AgentExec's to reach, kept inside the workspace as its tools are.
import type { AgentExec, FileUpload } from "@agentorg/exec";
import type { WebSocket } from "ws";
import type { components } from "./generated/schema.js";

type Schemas = components["schemas"];
type Request = Schemas["FilesRequest"];
type Write = Extract<Request, { type: "write" }>;
type Answer = Schemas["FilesAnswer"];
type Mode = Schemas["LiveMode"];
type Files = AgentExec["files"];

/** The most bytes one read gives or one write takes, so no message is ever a large one. */
export const MAX_PART = 1024 * 1024;
/** A socket with more than this still to be sent to it is answered no further until it has read. */
const MAX_BUFFERED = 4 * 1024 * 1024;
/** Files part written at once on one computer: each holds a file open. */
const MAX_UPLOADS = 64;

export const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));
const text = (value: unknown): value is string => typeof value === "string";
const whole = (value: unknown): value is number => Number.isSafeInteger(value);
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

export class FilesLive {
  readonly #files: Files;
  readonly #sockets = new Set<WebSocket>();
  /** One walk of the workspace at a time, however many ask. */
  #walking: Promise<unknown> = Promise.resolve();
  /** How many files are part written, over every socket. */
  #uploads = 0;

  constructor(files: Files) {
    this.#files = files;
  }

  close() {
    for (const ws of this.#sockets) ws.close(1001, "It stopped.");
  }

  open(ws: WebSocket, mode: Mode) {
    this.#sockets.add(ws);
    /** The files this socket is part way through writing, by path. */
    const uploads = new Map<string, { upload: FileUpload; size: number }>();
    /** The write whose bytes are the next binary message, or that one was refused before them. */
    let awaited: Write | "refused" | undefined;
    /** The parts being written, each after the one before, in the order they came. */
    let writing: Promise<unknown> = Promise.resolve();
    /** How many of them haven't been written yet. */
    let waiting = 0;
    /** The folders and files being read, one at a time, so what is sent stays bounded. */
    let reading: Promise<unknown> = Promise.resolve();
    let closed = false;

    const send = (answer: Answer) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(answer));
    };
    const refuse = (id: string, message: string) => send({ type: "refused", id, message });
    const giveUp = async (path: string) => {
      const had = uploads.get(path);
      if (!had) return;
      uploads.delete(path);
      this.#uploads--;
      await had.upload.abort().catch(() => {});
    };
    /** Wait until the socket has read most of what it was sent. A socket that never reads waits. */
    const drained = async () => {
      while (!closed && ws.bufferedAmount > MAX_BUFFERED) await sleep(50);
    };

    const writePart = async (write: Write, bytes: Buffer): Promise<Answer | undefined> => {
      const { id, path, offset, last } = write;
      if (bytes.length !== write.length)
        throw new Error(`It said ${write.length} bytes, and ${bytes.length} came.`);
      if (offset === 0) {
        await giveUp(path);
        if (this.#uploads >= MAX_UPLOADS)
          throw new Error(`${MAX_UPLOADS} files are part written here. Finish one first.`);
        this.#uploads++;
        try {
          uploads.set(path, { upload: await this.#files.upload(path), size: 0 });
        } catch (error) {
          this.#uploads--;
          throw error;
        }
      }
      const file = uploads.get(path);
      if (!file || file.size !== offset)
        throw new Error(`The next part of ${path} starts at ${file?.size ?? 0}.`);
      await file.upload.write(bytes);
      file.size += bytes.length;
      if (!last) return undefined;
      uploads.delete(path);
      this.#uploads--;
      return { type: "written", id, path, size: (await file.upload.finish()).size };
    };

    /**
     * Read a folder or a file once the ones asked before it have been answered and the socket
     * has read most of them. Asked for all at once and never read, they would otherwise all be
     * held here.
     */
    const inTurn = (work: () => Promise<void>) => {
      const done = reading.then(async () => {
        await drained();
        if (!closed) await work();
      });
      reading = done.catch(() => {});
      return done;
    };

    const handle = async (request: Request): Promise<void> => {
      const { id } = request;
      switch (request.type) {
        case "list": {
          const path = request.path ?? ".";
          if (!text(path)) throw new Error("A path is text.");
          return inTurn(async () =>
            send({ type: "entries", id, path, ...(await this.#files.list(path)) }),
          );
        }
        case "read": {
          const { path, offset, length } = request;
          if (!text(path)) throw new Error("A path is text.");
          return inTurn(async () => {
            const { bytes, size, modifiedAt } = await this.#files.read(path, offset, length);
            if (ws.readyState !== ws.OPEN) return;
            // The two go out together, so the bytes always follow their own header.
            send({ type: "data", id, path, offset, length: bytes.length, size, modifiedAt });
            ws.send(bytes);
          });
        }
        case "changed": {
          const { since } = request;
          if (!text(since)) throw new Error("That isn't a time.");
          // In turn, and not at all for a socket that has gone.
          const walked = this.#walking.then(() =>
            ws.readyState === ws.OPEN ? this.#files.changed(new Date(since)) : undefined,
          );
          this.#walking = walked.catch(() => {});
          const found = await walked;
          await drained();
          if (found) send({ type: "changes", id, since, ...found });
          return;
        }
        case "write": {
          // Nothing is awaited before `awaited` is set, so it is set before the next message is
          // looked at. Until the write is found good its bytes, which are on their way all the
          // same, are let pass.
          awaited = "refused";
          if (mode !== "operate") throw new Error("This socket watches: it can't write.");
          const { path, offset, length, last } = request;
          if (
            !text(path) ||
            !whole(offset) ||
            offset < 0 ||
            !whole(length) ||
            length < 0 ||
            length > MAX_PART ||
            typeof last !== "boolean"
          )
            throw new Error(
              "A write names a path, where it starts, 0 to 1,048,576 bytes, and last.",
            );
          awaited = request;
          return;
        }
        default:
          throw new Error("That isn't something files@1 does.");
      }
    };

    ws.on("close", () => {
      closed = true;
      this.#sockets.delete(ws);
      // Once the part being written has been, so that the file it began is given up too.
      void writing.finally(() => Promise.all([...uploads.keys()].map(giveUp)));
    });
    ws.on("message", (data: Buffer, binary: boolean) => {
      const write = awaited;
      awaited = undefined;
      if (binary) {
        if (write === "refused") return;
        if (!write) return ws.close(1008, "Those bytes belong to no write.");
        // No more is read from the socket while a part waits to be written. What had already
        // arrived still comes, so the parts are also written one after another.
        waiting++;
        ws.pause();
        writing = writing
          .then(() => (closed ? undefined : writePart(write, data)))
          .then(
            (done) => done && send(done),
            async (error: unknown) => {
              await giveUp(write.path);
              refuse(write.id, reason(error));
            },
          )
          .finally(() => {
            if (--waiting === 0) ws.resume();
          });
        return;
      }
      if (write && write !== "refused") refuse(write.id, "Its bytes didn't follow it.");
      let request: Request;
      try {
        request = JSON.parse(data.toString()) as Request;
      } catch {
        return refuse("", "That isn't JSON.");
      }
      const { id, type } = (request ?? {}) as { id?: unknown; type?: unknown };
      // A write that is refused here still has its bytes on their way, and they are let pass.
      if (type === "write") awaited = "refused";
      if (!text(id) || id.length < 1 || id.length > 64)
        return refuse("", "Every request has an id of 1 to 64 characters.");
      handle(request).catch((error: unknown) => refuse(id, reason(error)));
    });
  }
}
