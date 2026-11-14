// Fetching a computer's image through Docker's own API, on Docker's socket here, whose answer says
// how far it has come: each layer's bytes as they are downloaded, and each layer unpacked.
import { request } from "node:http";
import { createInterface } from "node:readline";
import type { components } from "./generated/schema.js";

type Progress = components["schemas"]["Progress"];

/** What Docker's API says of a pull, one line at a time. */
interface PullEvent {
  id?: string;
  status?: string;
  progressDetail?: { current?: number; total?: number };
  errorDetail?: { message?: string };
  error?: string;
  message?: string;
}

/** An image's name and its tag or digest, as Docker's API takes them. */
function refOf(image: string): [string, string] {
  const at = image.indexOf("@");
  if (at >= 0) return [image.slice(0, at), image.slice(at + 1)];
  const colon = image.lastIndexOf(":");
  return colon > image.lastIndexOf("/")
    ? [image.slice(0, colon), image.slice(colon + 1)]
    : [image, "latest"];
}

export class ImageFetch {
  readonly #progress: Progress = {
    title: "Fetching its image",
    done: 0,
    total: null,
    moved: new Date().toISOString(),
  };
  /** Settles when the image is here, or with Docker's words for why it isn't. */
  readonly done: Promise<void>;

  /** `socket` is Docker's. */
  constructor(image: string, socket: string) {
    this.done = this.#fetch(image, socket);
  }

  /** How far it has come. */
  progress(): Progress {
    return { ...this.#progress };
  }

  #fetch(image: string, socket: string) {
    const [name, tag] = refOf(image);
    const layers = new Map<string, { current: number; total: number }>();
    const progress = this.#progress;
    return new Promise<void>((done, failed) => {
      const asked = request(
        {
          socketPath: socket,
          method: "POST",
          path: `/images/create?fromImage=${encodeURIComponent(name)}&tag=${encodeURIComponent(tag)}`,
        },
        (answer) => {
          let error =
            answer.statusCode === 200 ? undefined : `Docker answered ${answer.statusCode}.`;
          createInterface({ input: answer, crlfDelay: Infinity })
            .on("error", failed)
            .on("line", (line) => {
              let event: PullEvent;
              try {
                event = JSON.parse(line) as PullEvent;
              } catch {
                return;
              }
              const said = event.errorDetail?.message ?? event.error ?? event.message;
              if (said) error = said;
              const { id, status, progressDetail: detail } = event;
              const layer = id === undefined ? undefined : layers.get(id);
              // A layer being unpacked is moving too, though it brings no bytes.
              if (status === "Extracting") progress.moved = new Date().toISOString();
              if (id !== undefined && status === "Downloading" && detail?.total)
                layers.set(id, { current: detail.current ?? 0, total: detail.total });
              else if (layer && status === "Download complete") layer.current = layer.total;
              else return;
              let [fetched, size] = [0, 0];
              for (const { current, total } of layers.values()) {
                fetched += current;
                size += total;
              }
              if (fetched > progress.done) progress.moved = new Date().toISOString();
              [progress.done, progress.total] = [fetched, size];
            })
            .on("close", () => {
              if (error) failed(new Error(error));
              else if (answer.complete) done();
              else failed(new Error("Docker stopped answering."));
            });
        },
      );
      asked.on("error", failed);
      asked.end();
    });
  }
}
