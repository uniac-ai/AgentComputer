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

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));
const text = (value: unknown): value is string => typeof value === "string";
const whole = (value: unknown): value is number => Number.isSafeInteger(value);

export class FilesLive {
  readonly #files: Files;
  /** One walk of the workspace at a time, however many ask. */
  #walking: Promise<unknown> = Promise.resolve();

  constructor(files: Files) {
    this.#files = files;
  }

  open(ws: WebSocket, mode: Mode) {
    /** The files this socket is part way through writing, by path. */
    const uploads = new Map<string, { upload: FileUpload; size: number }>();
    /** The write whose bytes are the next binary message, or that one was refused before them. */
    let awaited: Write | "refused" | undefined;
    /** The parts being written, one after another in the order they came. */
    let parts: Promise<unknown> = Promise.resolve();
    let unwritten = 0;

    const send = (answer: Answer) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(answer));
    };
    const refuse = (id: string, message: string) => send({ type: "refused", id, message });
    const giveUp = async (path: string) => {
      const had = uploads.get(path);
      uploads.delete(path);
      await had?.upload.abort().catch(() => {});
    };

    const part = async (write: Write, bytes: Buffer): Promise<Answer | undefined> => {
      const { id, path, offset, last } = write;
      if (bytes.length !== write.length)
        throw new Error(`It said ${write.length} bytes, and ${bytes.length} came.`);
      if (offset === 0) {
        await giveUp(path);
        uploads.set(path, { upload: await this.#files.upload(path), size: 0 });
      }
      const writing = uploads.get(path);
      if (!writing || writing.size !== offset)
        throw new Error(`The next part of ${path} starts at ${writing?.size ?? 0}.`);
      await writing.upload.write(bytes);
      writing.size += bytes.length;
      if (!last) return undefined;
      uploads.delete(path);
      return { type: "written", id, path, size: (await writing.upload.finish()).size };
    };

    const answer = async (request: Request): Promise<void> => {
      const { id } = request;
      switch (request.type) {
        case "list": {
          const path = request.path ?? ".";
          if (!text(path)) throw new Error("A path is text.");
          return send({ type: "entries", id, path, ...(await this.#files.list(path)) });
        }
        case "read": {
          const { path, offset, length } = request;
          if (!text(path)) throw new Error("A path is text.");
          const { bytes, size, modifiedAt } = await this.#files.read(path, offset, length);
          if (ws.readyState !== ws.OPEN) return;
          // The two go out together, so the bytes always follow their own header.
          send({ type: "data", id, path, offset, length: bytes.length, size, modifiedAt });
          return ws.send(bytes);
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
          if (found) send({ type: "changes", id, since, ...found });
          return;
        }
        case "write": {
          // Its bytes are on their way all the same, and are let pass.
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
      for (const path of [...uploads.keys()]) void giveUp(path);
    });
    ws.on("message", (data: Buffer, binary: boolean) => {
      const write = awaited;
      awaited = undefined;
      if (binary) {
        if (write === "refused") return;
        if (!write) return ws.close(1008, "Those bytes belong to no write.");
        // One part at a time, and no more is read from the socket while any waits to be written.
        unwritten++;
        ws.pause();
        parts = parts
          .then(() => part(write, data))
          .then(
            (done) => done && send(done),
            async (error: unknown) => {
              await giveUp(write.path);
              refuse(write.id, reason(error));
            },
          )
          .finally(() => {
            if (--unwritten === 0) ws.resume();
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
      if (typeof request !== "object" || request === null || !text(request.id) || !request.id)
        return refuse("", "Every request has an id.");
      answer(request).catch((error: unknown) => refuse(request.id, reason(error)));
    });
  }
}
