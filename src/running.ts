// The service as something that is running or isn't, for one data folder: finding it, starting it
// in the background for this user, and stopping it.
import { spawn } from "node:child_process";
import { closeSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { privateFolder } from "./store.ts";

/** A service that answers: where and which process its record says, and what it says of itself. */
export interface Running {
  url: string;
  pid: number;
  version: string;
  isolation: string;
}

const MAX_LOG = 1024 * 1024;
const STOP_MS = 30_000;
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

export const recordOf = (data: string) => join(data, "server.json");

/** Where a service last said it is for this data folder, and the token to ask it with. */
export function recorded(data: string) {
  try {
    const { url, pid } = JSON.parse(readFileSync(recordOf(data), "utf8")) as Running;
    return { url, pid, token: readFileSync(join(data, "control-token"), "utf8").trim() };
  } catch {
    return undefined;
  }
}

/**
 * The service for this data folder, if one answers. Its record is not believed until it answers
 * there with this folder's own token: a record outlives a crash.
 */
export async function running(data: string, said = recorded(data)): Promise<Running | undefined> {
  if (!said) return undefined;
  try {
    const answer = await fetch(`${said.url}/v1/info`, {
      headers: { Authorization: `Bearer ${said.token}` },
      signal: AbortSignal.timeout(3_000),
    });
    if (!answer.ok) return undefined;
    const { version, isolation } = (await answer.json()) as Running;
    return { url: said.url, pid: said.pid, version, isolation };
  } catch {
    return undefined;
  }
}

/**
 * Start the service in the background, as `serve` with these arguments, and give it once it
 * answers. One that is already running for this data folder is given as it is.
 */
export async function up(data: string, program: string, args: string[]): Promise<Running> {
  const already = await running(data);
  if (already) return already;
  const log = join(privateFolder(data), "service.log");
  // What it wrote before is kept, the end of it.
  try {
    const before = readFileSync(log);
    if (before.length > MAX_LOG) writeFileSync(log, before.subarray(before.length - MAX_LOG));
  } catch {
    // It hasn't written one yet.
  }
  const from = statSync(log, { throwIfNoEntry: false })?.size ?? 0;
  const out = openSync(log, "a", 0o600);
  // In a session of its own, so it stays when whoever started it goes.
  const child = spawn(process.execPath, [program, "serve", ...args], {
    detached: true,
    stdio: ["ignore", out, out],
  });
  closeSync(out);
  child.unref();
  let ended = false;
  child.once("exit", () => {
    ended = true;
  });
  for (; ; await sleep(100)) {
    const said = recorded(data);
    const up = await running(data, said);
    // While it lives only its own record is believed: at the address of one that crashed, it
    // would answer for the record that one left.
    const own = said?.pid === child.pid;
    if (up && (own || ended)) return up;
    // It takes as long as it needs to get ready, which can be an image to pull. Once it has said
    // where it is, it answers there or can't be reached there.
    if (!ended && !own) continue;
    if (!ended) {
      child.kill();
      throw new Error(`The service doesn't answer at ${said?.url} from here, so it was stopped.`);
    }
    const wrote = readFileSync(log).subarray(from).toString().trim();
    throw new Error(`The service didn't start.${wrote ? ` It said:\n${wrote}` : ""}`);
  }
}

/** Stop the service for this data folder, if one is running. */
export async function down(data: string) {
  const found = await running(data);
  if (!found) return;
  process.kill(found.pid, "SIGTERM");
  for (const deadline = Date.now() + STOP_MS; Date.now() < deadline; await sleep(100))
    if (!(await running(data))) return;
  throw new Error(`The service at ${found.url} didn't stop.`);
}
