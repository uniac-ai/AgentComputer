// A computer's load, as readings on its `load` surface in metrics@1: how busy its CPUs are, and
// how much of its memory and of its disk is used. Nothing is read while nobody watches or asks.
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { availableParallelism, cpus, freemem, totalmem } from "node:os";
import { promisify } from "node:util";
import type { WebSocket } from "ws";
import type { components } from "./generated/schema.js";

type Reading = components["schemas"]["LoadReading"];
/** CPU time used out of the CPU time there was, both counted up from some start. */
interface Cpu {
  used: number;
  total: number;
}
interface Sample {
  scope: Reading["scope"];
  cpu: Cpu;
  memUsed: number;
}

const EVERY_MS = 2_000;
/** How long a reading that is asked for once is taken over. */
const ONCE_MS = 500;
const run = promisify(execFile);

/** One number of a text of `name value` lines. It isn't a number where the name isn't there. */
const numberOf = (text: string, name: string) =>
  Number(new RegExp(`^${name}\\s+(\\d+)`, "m").exec(text)?.[1]);

/**
 * The volume a folder is on, as `df` counts it. Node 22's own call gives only one size of block,
 * which on a folder mounted from elsewhere is not the size its blocks are counted in.
 */
async function disk(folder: string) {
  const { stdout } = await run("df", ["-kP", folder], { timeout: EVERY_MS });
  const [, total, used] = /\s(\d+)\s+(\d+)\s+\d+\s+\d+%/.exec(stdout) ?? [];
  if (!total) throw new Error("No disk.");
  return { diskUsed: Number(used) * 1024, diskTotal: Number(total) * 1024 };
}

/** The whole machine's, which a computer with no isolation shares with whatever else runs there. */
async function machine(): Promise<Sample> {
  const cpu = { used: 0, total: 0 };
  for (const { times } of cpus()) {
    cpu.used += times.user + times.nice + times.sys + times.irq;
    cpu.total += times.user + times.nice + times.sys + times.irq + times.idle;
  }
  if (process.platform !== "darwin")
    return { scope: "machine", cpu, memUsed: totalmem() - freemem() };
  // macOS: what is active, wired or compressed, which is what Linux counts as in use. Its free
  // pages alone, which Node reports there, leave out nearly everything it could give back.
  const { stdout } = await run("/usr/bin/vm_stat", { timeout: EVERY_MS });
  const pages =
    numberOf(stdout, "Pages active:") +
    numberOf(stdout, "Pages wired down:") +
    numberOf(stdout, "Pages occupied by compressor:");
  return { scope: "machine", cpu, memUsed: pages * Number(/page size of (\d+)/.exec(stdout)?.[1]) };
}

/** A container's own, from its control group. It fails where there is none to read. */
async function cgroup(): Promise<Sample> {
  const read = (file: string) => readFile(`/sys/fs/cgroup/${file}`, "utf8");
  const [cpu, current, memory] = await Promise.all([
    read("cpu.stat"),
    read("memory.current"),
    read("memory.stat"),
  ]);
  return {
    scope: "computer",
    // No container has a limit, so the time there was is every CPU's.
    cpu: {
      used: numberOf(cpu, "usage_usec"),
      total: performance.now() * 1_000 * availableParallelism(),
    },
    // Less the files it has read and no longer uses, as `docker stats` counts it.
    memUsed: Number(current) - numberOf(memory, "inactive_file"),
  };
}

/** A reading from two samples, or none where a number of it is missing. */
function readingOf(before: Cpu, sample: Sample, volume: Pick<Reading, "diskUsed" | "diskTotal">) {
  // No time between two samples is no share of it.
  const share = (sample.cpu.used - before.used) / (sample.cpu.total - before.total) || 0;
  const reading: Reading = {
    type: "reading",
    scope: sample.scope,
    cpuUsedPct: Math.round(Math.min(Math.max(share, 0), 1) * 1_000) / 10,
    memUsed: sample.memUsed,
    memTotal: totalmem(),
    ...volume,
  };
  return Number.isFinite(reading.cpuUsedPct + reading.memUsed) ? reading : undefined;
}

export class LoadLive {
  readonly #folder: string;
  readonly #contained: boolean;
  readonly #sockets = new Set<WebSocket>();
  #timer: NodeJS.Timeout | undefined;
  #reading = false;
  #before: Cpu | undefined;
  #last: string | undefined;

  /**
   * `folder` is on the disk that is reported. `contained` is whether the processes here are one
   * computer's and nothing else's, as they are inside a container.
   */
  constructor(folder: string, contained: boolean) {
    this.#folder = folder;
    this.#contained = contained;
  }

  /** metrics@1: a reading every two seconds, the last one at once. What it sends is dropped. */
  open(ws: WebSocket) {
    this.#sockets.add(ws);
    if (this.#last) ws.send(this.#last);
    ws.on("close", () => {
      this.#sockets.delete(ws);
      if (this.#sockets.size === 0) this.close();
    });
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.#read(), EVERY_MS);
    // How busy the CPUs are is between two samples, so the first reading waits for the second.
    void this.#read();
  }

  close() {
    clearInterval(this.#timer);
    this.#timer = this.#before = this.#last = undefined;
    for (const ws of this.#sockets) ws.close(1001, "It stopped.");
  }

  /** Its own, inside a container that can read it; else the machine's. */
  #sample() {
    return this.#contained ? cgroup().catch(machine) : machine();
  }

  /** One reading for whoever asks once, taken over half a second. None where it can't be. */
  async now(): Promise<Reading | undefined> {
    try {
      const before = await this.#sample();
      await new Promise((done) => setTimeout(done, ONCE_MS));
      return readingOf(before.cpu, await this.#sample(), await disk(this.#folder));
    } catch {
      return undefined;
    }
  }

  /** One at a time, and for the watching it began under: a reading taken too late is left. */
  async #read() {
    const timer = this.#timer;
    if (this.#reading) return;
    this.#reading = true;
    try {
      const sample = await this.#sample();
      const volume = await disk(this.#folder);
      if (this.#timer !== timer) return;
      const before = this.#before;
      this.#before = sample.cpu;
      // A reading with a number missing is left out whole: nothing depends on one.
      const reading = before && readingOf(before, sample, volume);
      if (!reading) return;
      this.#last = JSON.stringify(reading);
      // A reading is replaced by the next, so a socket with one still unsent isn't sent another.
      for (const ws of this.#sockets) if (ws.bufferedAmount === 0) ws.send(this.#last);
    } catch {
      // So is one that couldn't be taken.
    } finally {
      this.#reading = false;
    }
  }
}
