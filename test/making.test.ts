// A computer being made, as its image is fetched: that it is starting, its step, how far that has
// come, and why it failed. Docker here is a stand-in: its API on a socket of the test's own, which
// sends what the test says, and a docker command that answers only what is asked here. Nothing is
// fetched and no container is made.
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ImageFetch } from "../src/image-fetch.ts";

type Sdk = typeof import("../src/sdk.ts");
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const IMAGE = "ghcr.io/example/computer:1.2.3";
const MB = 1_000_000;
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** Docker's API, as far as a pull: each pull is held open for the test to send it what it likes. */
async function fakeApi(t: test.TestContext, folder: string) {
  const pulls: { path: string; answer: ServerResponse }[] = [];
  const waiting: (() => void)[] = [];
  const server = createServer((request, answer) => {
    answer.writeHead(200, { "Content-Type": "application/json" });
    pulls.push({ path: request.url ?? "", answer });
    for (const wake of waiting.splice(0)) wake();
  });
  const socket = join(folder, "docker.sock");
  await new Promise<void>((done) => server.listen(socket, done));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return {
    socket,
    /** The next pull asked for, once it is. */
    async pull() {
      while (pulls.length === 0) await new Promise<void>((wake) => waiting.push(wake));
      const { path, answer } = pulls.shift() as (typeof pulls)[number];
      return {
        path,
        send: (...events: object[]) => {
          for (const event of events) answer.write(`${JSON.stringify(event)}\n`);
        },
        end: () => answer.end(),
        cut: () => answer.destroy(),
      };
    },
  };
}

/**
 * A docker command that answers what the service asks before it would make a container. The image
 * is there once the test puts `image-here` in the folder; every call is written to `calls`.
 */
function fakeDocker(folder: string) {
  const bin = join(folder, "bin");
  mkdirSync(bin, { recursive: true });
  const program = join(bin, "docker");
  writeFileSync(
    program,
    `#!/bin/sh
echo "$*" >> "${folder}/calls"
case "$1" in
  version) echo 28.0.0 ;;
  image) [ -f "${folder}/image-here" ] && echo sha256:fake && exit 0; echo "No such image: $4" >&2; exit 1 ;;
  pull) echo "Trying to pull $2"; echo "pull refused here" >&2; exit 1 ;;
  *) echo "This docker can't $1." >&2; exit 1 ;;
esac
`,
  );
  chmodSync(program, 0o755);
  return bin;
}

/** A service of its own on the stand-in Docker; `before` is done to its data folder first. */
async function service(t: test.TestContext, before: (data: string) => void = () => {}) {
  const folder = mkdtempSync(join(tmpdir(), "ac-"));
  const data = join(folder, "data");
  const api = await fakeApi(t, folder);
  mkdirSync(data);
  before(data);
  const child: ChildProcess = spawn(
    process.execPath,
    [
      join(root, "dist", "agentcomputer.js"),
      "serve",
      "--listen",
      "127.0.0.1:0",
      "--data",
      data,
      "--image",
      IMAGE,
      "--screen-driver",
      "/nonexistent/cua-driver",
    ],
    {
      env: {
        PATH: `${fakeDocker(folder)}:${process.env.PATH ?? ""}`,
        HOME: folder,
        DOCKER_HOST: `unix://${api.socket}`,
      },
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  t.after(async () => {
    const gone = once(child, "exit");
    child.kill("SIGTERM");
    await gone;
    rmSync(folder, { recursive: true, force: true });
  });
  const apiUrl = await new Promise<string>((done) =>
    createInterface({ input: child.stdout as NodeJS.ReadableStream }).on("line", (line) => {
      const found = /^AgentComputer on (\S+),/.exec(line);
      if (found) done(found[1] as string);
    }),
  );
  const { Computer } = (await import(pathToFileURL(join(root, "dist", "sdk.js")).href)) as Sdk;
  const to = { apiUrl, apiKey: readFileSync(join(data, "control-token"), "utf8").trim() };
  type Listed = Awaited<ReturnType<typeof Computer.list>>;
  /** The computers listed, once `check` holds of them, or as they are after five seconds. */
  const listed = async (check: (computers: Listed) => boolean) => {
    let computers = await Computer.list(to);
    for (let i = 0; !check(computers) && i < 100; i++) {
      await pause(50);
      computers = await Computer.list(to);
    }
    return computers;
  };
  return { Computer, to, api, folder, listed };
}

test("Docker's API counts the image's bytes as each layer downloads, and when it last moved", async (t) => {
  const folder = mkdtempSync(join(tmpdir(), "ac-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const api = await fakeApi(t, folder);
  const began = Date.now();
  const fetch = new ImageFetch(IMAGE, api.socket);
  const pull = await api.pull();
  assert.equal(
    pull.path,
    `/images/create?fromImage=${encodeURIComponent("ghcr.io/example/computer")}&tag=1.2.3`,
  );
  // Before any byte: nothing done, nothing known, moved when it began.
  const first = fetch.progress();
  assert.deepEqual([first.title, first.done, first.total], ["Fetching its image", 0, null]);
  assert.ok(Date.parse(first.moved) >= began - 1_000);
  await pause(50);
  pull.send(
    { status: "Pulling fs layer", progressDetail: {}, id: "a" },
    { status: "Pulling fs layer", progressDetail: {}, id: "b" },
    { status: "Downloading", progressDetail: { current: 1 * MB, total: 4 * MB }, id: "a" },
    { status: "Downloading", progressDetail: { current: 2 * MB, total: 8 * MB }, id: "b" },
    { status: "Download complete", progressDetail: { hidecounts: true }, id: "a" },
  );
  await pause(50);
  const second = fetch.progress();
  assert.deepEqual([second.done, second.total], [6 * MB, 12 * MB]);
  assert.ok(Date.parse(second.moved) > Date.parse(first.moved));
  // Docker saying something that moves nothing isn't moving; a layer being unpacked is.
  await pause(50);
  pull.send({ status: "Waiting", progressDetail: {}, id: "b" });
  await pause(50);
  assert.equal(fetch.progress().moved, second.moved);
  pull.send({ status: "Extracting", progressDetail: { current: 1, units: "s" }, id: "a" });
  await pause(50);
  assert.ok(Date.parse(fetch.progress().moved) > Date.parse(second.moved));
  pull.send(
    { status: "Download complete", progressDetail: { hidecounts: true }, id: "b" },
    { status: "Pull complete", progressDetail: { hidecounts: true }, id: "b" },
    { status: "Status: Downloaded newer image for ghcr.io/example/computer:1.2.3" },
  );
  pull.end();
  await fetch.done;
  assert.deepEqual([fetch.progress().done, fetch.progress().total], [12 * MB, 12 * MB]);
});

test("a pull Docker refuses, or stops answering, ends with why", async (t) => {
  const folder = mkdtempSync(join(tmpdir(), "ac-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const api = await fakeApi(t, folder);
  const refused = new ImageFetch(IMAGE, api.socket);
  const first = await api.pull();
  first.send({ errorDetail: { message: "unauthorized: sign in" }, error: "unauthorized" });
  first.end();
  await assert.rejects(refused.done, { message: "unauthorized: sign in" });
  // Its connection cut halfway, as when Docker restarts: refused, and nothing else ends.
  const cut = new ImageFetch(IMAGE, api.socket);
  const second = await api.pull();
  second.send({ status: "Downloading", progressDetail: { current: 1, total: 2 }, id: "a" });
  await pause(50);
  second.cut();
  await assert.rejects(cut.done);
});

test("a computer being made is starting, with its step and how far it has come, until it is made or refused", async (t) => {
  const { Computer, to, api, listed } = await service(t);
  const making = Computer.create({ ...to, access: "read", name: "Scout" });
  const pull = await api.pull();
  pull.send({ status: "Downloading", progressDetail: { current: 3 * MB, total: 9 * MB }, id: "a" });
  const [starting] = await listed((all) => all[0]?.progress?.done === 3 * MB);
  assert.deepEqual(
    [starting?.name, starting?.state, starting?.reason, starting?.progress?.title],
    ["Scout", "starting", "Its image is being fetched.", "Fetching its image"],
  );
  assert.deepEqual([starting?.progress?.done, starting?.progress?.total], [3 * MB, 9 * MB]);
  const id = starting?.computerID as string;
  const detail = await Computer.getInfo(id, to);
  assert.deepEqual(
    [detail.state, detail.reason, detail.progress],
    ["starting", starting?.reason, starting?.progress],
  );
  // What needs it running is refused with the same, rather than that it has stopped.
  await assert.rejects(Computer.createLiveSession(id, { surface: "load" }, to), {
    code: 409,
    message: "Its image is being fetched.",
  });
  // Docker's API can't fetch it, so the docker command is tried, and its words are why.
  pull.send({ error: "denied: no such image" });
  pull.end();
  await assert.rejects(making, {
    code: 409,
    message: "Its image couldn't be fetched: pull refused here",
  });
  assert.deepEqual(await Computer.list(to), []);
});

test("a computer killed while it is being made is refused, and nothing is made for it", async (t) => {
  const { Computer, to, api, folder, listed } = await service(t);
  const making = Computer.create({ ...to, access: "read", name: "Gone" });
  const pull = await api.pull();
  const [starting] = await listed((all) => all.length > 0);
  await Computer.kill(starting?.computerID as string, to);
  // The image comes: nothing is made from it.
  writeFileSync(join(folder, "image-here"), "");
  pull.end();
  await assert.rejects(making, { code: 409, message: "It was stopped while it was starting." });
  assert.deepEqual(await Computer.list(to), []);
  const calls = readFileSync(join(folder, "calls"), "utf8");
  assert.ok(!/^(create|start) /m.test(calls), calls);
});

test("a computer brought back is starting as soon as the service is up, and failed with why", async (t) => {
  const { Computer, api, to, listed } = await service(t, (data) =>
    writeFileSync(
      join(data, "computers.json"),
      JSON.stringify([
        {
          id: "c_back",
          name: "Back",
          access: "read",
          isolation: "container",
          browser: false,
          metadata: {},
          tokenDigest: "0".repeat(64),
          state: "running",
          createdAt: new Date().toISOString(),
          startedAt: new Date().toISOString(),
        },
      ]),
    ),
  );
  const pull = await api.pull();
  const [waiting] = await Computer.list(to);
  assert.deepEqual(
    [waiting?.state, waiting?.reason, waiting?.progress?.done],
    ["starting", "Its image is being fetched.", 0],
  );
  pull.send({ error: "denied" });
  pull.end();
  const [failed] = await listed((all) => all[0]?.state === "failed");
  assert.deepEqual(
    [failed?.state, failed?.progress, failed?.reason],
    ["failed", null, "It didn't start again: Its image couldn't be fetched: pull refused here"],
  );
  // What needs it running says why too.
  await assert.rejects(Computer.createLiveSession("c_back", { surface: "load" }, to), {
    code: 409,
    message: failed?.reason as string,
  });
});
