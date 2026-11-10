// The files surface: a person's file window lists a folder, reads a file a range at a time, finds
// what changed and, at operate, writes a file a part at a time, the same with and without
// isolation.
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import WebSocket from "ws";

type Sdk = typeof import("../src/sdk.ts");
// biome-ignore lint/suspicious/noExplicitAny: each answer is JSON the test reads.
type Answer = any;
const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "..", "dist");
const CLI = join(dist, "agentcomputer.js");
const IMAGE = process.env.AGENTCOMPUTER_TEST_IMAGE;
const ISOLATIONS: [string, string[]][] = [
  ["none", []],
  ...(IMAGE
    ? ([["container", ["--isolation", "container", "--image", IMAGE]]] as [string, string[]][])
    : []),
];
const MIB = 1024 * 1024;

async function until(check: () => boolean, what: string) {
  const deadline = Date.now() + 15_000;
  while (!check()) {
    assert.ok(Date.now() < deadline, `Waited too long for ${what}.`);
    await new Promise((done) => setTimeout(done, 25));
  }
}

async function setup(t: test.TestContext, extra: string[]) {
  const root = realpathSync(
    mkdtempSync(join(process.env.AGENTCOMPUTER_TEST_ROOT ?? tmpdir(), "ac-")),
  );
  const data = join(root, "data");
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const child: ChildProcess = spawn(
    process.execPath,
    [CLI, "serve", "--listen", "127.0.0.1:0", "--data", data, ...extra],
    {
      env: {
        PATH: process.env.PATH ?? "",
        HOME: root,
        SHELL: "/bin/bash",
        ...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}),
      },
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  const url = await new Promise<string>((done, failed) => {
    child.once("exit", (code) => failed(new Error(`The service exited ${code}.`)));
    createInterface({ input: child.stdout as NodeJS.ReadableStream }).on("line", (line) => {
      const found = /^AgentComputer on (\S+),/.exec(line);
      if (found) done(found[1] as string);
    });
  });
  child.removeAllListeners("exit");
  const { Computer } = (await import(pathToFileURL(join(dist, "sdk.js")).href)) as Sdk;
  const to = { apiUrl: url, apiKey: readFileSync(join(data, "control-token"), "utf8").trim() };
  t.after(async () => {
    for (const computer of await Computer.list(to).catch(() => []))
      await Computer.kill(computer.computerID, to).catch(() => {});
    const gone = once(child, "exit");
    child.kill("SIGTERM");
    await gone;
    rmSync(root, { recursive: true, force: true });
  });
  return { Computer, to, workspace };
}

/** A file window's side of files@1: each request waits for its answer, and its bytes if any. */
async function window(url: string) {
  const ws = new WebSocket(url);
  await once(ws, "open");
  const waiting = new Map<string, (answer: Answer) => void>();
  const closed = new Promise<number>((done) => ws.once("close", (code) => done(code)));
  /** A data answer, until the binary message that follows it arrives. */
  let held: Answer | undefined;
  let next = 0;
  ws.on("message", (data: Buffer, binary: boolean) => {
    if (binary) {
      assert.ok(held, "bytes follow a data message");
      const answer = { ...held, bytes: data };
      held = undefined;
      return waiting.get(answer.id)?.(answer);
    }
    assert.equal(held, undefined, "a data message is followed by its bytes");
    const answer = JSON.parse(data.toString()) as Answer;
    if (answer.type === "data") held = answer;
    else waiting.get(answer.id)?.(answer);
  });
  const sent = (id: string) =>
    new Promise<Answer>((done) => {
      waiting.set(id, done);
    });
  return {
    ws,
    closed,
    /** Send a request, with bytes after it if given, and wait for what answers it. */
    ask(request: Record<string, unknown>, bytes?: Uint8Array): Promise<Answer> {
      const id = String(++next);
      const answer = sent(id);
      ws.send(JSON.stringify({ id, ...request }));
      if (bytes) ws.send(bytes);
      return answer;
    },
    /** Send a part that isn't the last, which is answered only if it is refused. */
    part(path: string, offset: number, bytes: Uint8Array) {
      const id = String(++next);
      ws.send(
        JSON.stringify({ type: "write", id, path, offset, length: bytes.length, last: false }),
      );
      ws.send(bytes);
      return sent(id);
    },
  };
}

const temporaries = (folder: string) =>
  readdirSync(folder).filter((name) => name.startsWith(".agentexec-"));

for (const [isolation, extra] of ISOLATIONS) {
  const options = { timeout: 120_000 };

  test(
    `isolation ${isolation}: a folder is listed, a file is read a range at a time, and what changed is found`,
    options,
    async (t) => {
      const { Computer, to, workspace } = await setup(t, extra);
      const big = randomBytes(2 * MIB + 4321);
      const old = new Date("2020-01-01T00:00:00.000Z");
      writeFileSync(join(workspace, "big.bin"), big);
      mkdirSync(join(workspace, "docs"));
      writeFileSync(join(workspace, "docs", "old.md"), "old");
      utimesSync(join(workspace, "docs", "old.md"), old, old);
      writeFileSync(join(workspace, "notes.txt"), "hello");
      const computer = await Computer.create({ ...to, access: "terminal", workspace });
      t.after(() => computer.close());

      const files = (await computer.getInfo()).surfaces.find((one) => one.surface === "files");
      assert.deepEqual(files, { surface: "files", protocol: "files@1", operate: true });
      const session = await computer.liveSession("files");
      assert.equal(session.protocol, "files@1");
      const { ask, ws } = await window(session.url);
      t.after(() => ws.close());

      const listed = await ask({ type: "list" });
      assert.equal(listed.type, "entries");
      assert.equal(listed.more, false);
      assert.deepEqual(
        listed.entries.map((entry: Answer) => [entry.name, entry.kind, entry.size]),
        [
          ["docs", "folder", listed.entries[0].size],
          ["big.bin", "file", big.length],
          ["notes.txt", "file", 5],
        ],
      );
      const inner = await ask({ type: "list", path: "docs" });
      assert.equal(inner.path, "docs");
      assert.equal(inner.entries[0].modifiedAt, old.toISOString());

      // A file larger than one message is read by asking for it a range at a time.
      const parts: Buffer[] = [];
      for (let offset = 0; offset < big.length; ) {
        const part = await ask({ type: "read", path: "big.bin", offset, length: MIB });
        assert.equal(part.type, "data");
        assert.equal(part.size, big.length);
        assert.equal(part.offset, offset);
        assert.equal(part.length, part.bytes.length);
        assert.ok(part.bytes.length <= MIB);
        parts.push(part.bytes);
        offset += part.bytes.length;
      }
      assert.equal(parts.length, 3);
      assert.ok(Buffer.concat(parts).equals(big));
      assert.equal(
        (await ask({ type: "read", path: "big.bin", offset: big.length, length: 1 })).length,
        0,
      );

      const since = new Date("2025-01-01T00:00:00.000Z").toISOString();
      const [changed, again] = await Promise.all([
        ask({ type: "changed", since }),
        ask({ type: "changed", since }),
      ]);
      assert.equal(changed.type, "changes");
      assert.equal(changed.since, since);
      assert.deepEqual(changed.changes.map((change: Answer) => change.path).sort(), [
        "big.bin",
        "notes.txt",
      ]);
      assert.deepEqual(again.changes, changed.changes);
      const newest = changed.changes[0].modifiedAt;
      assert.deepEqual((await ask({ type: "changed", since: newest })).changes, []);

      for (const [request, why] of [
        [{ type: "read", path: "big.bin", offset: 0, length: MIB + 1 }, /1 to 1,048,576 bytes/],
        [{ type: "read", path: "../outside", offset: 0, length: 1 }, /outside the workspace/],
        [{ type: "read", path: "docs", offset: 0, length: 1 }, /is a folder/],
        [{ type: "list", path: "/etc" }, /outside the workspace/],
        [{ type: "changed", since: "yesterday" }, /isn't a time/],
        [{ type: "remove", path: "notes.txt" }, /isn't something files@1 does/],
      ] as const) {
        const refused = await ask(request);
        assert.equal(refused.type, "refused", JSON.stringify(request));
        assert.match(refused.message, why);
      }
    },
  );

  test(
    `isolation ${isolation}: a file is written a part at a time and is there only once it is whole`,
    options,
    async (t) => {
      const { Computer, to, workspace } = await setup(t, extra);
      writeFileSync(join(workspace, "report.bin"), "before");
      const computer = await Computer.create({ ...to, access: "files", workspace });
      t.after(() => computer.close());
      const { ask, part, ws } = await window((await computer.liveSession("files", "operate")).url);
      t.after(() => ws.close());

      const content = randomBytes(MIB + 99);
      void part("report.bin", 0, content.subarray(0, MIB));
      const written = await ask(
        { type: "write", path: "report.bin", offset: MIB, length: 99, last: true },
        content.subarray(MIB),
      );
      assert.deepEqual(
        { type: written.type, path: written.path, size: written.size },
        { type: "written", path: "report.bin", size: content.length },
      );
      assert.ok(readFileSync(join(workspace, "report.bin")).equals(content));
      assert.deepEqual(temporaries(workspace), []);

      // Until its last part, what was at the path stays.
      void part("report.bin", 0, new Uint8Array(10));
      const listed = await ask({ type: "list" });
      assert.ok(readFileSync(join(workspace, "report.bin")).equals(content));
      assert.equal(listed.entries.filter((entry: Answer) => entry.name === "report.bin").length, 1);

      // A part that doesn't start where the last ended is refused, and that file is given up.
      const gap = await ask(
        { type: "write", path: "report.bin", offset: 500, length: 1, last: true },
        new Uint8Array(1),
      );
      assert.match(gap.message, /next part of report\.bin starts at 10/);
      await until(() => temporaries(workspace).length === 0, "the unfinished file to go");
      assert.ok(readFileSync(join(workspace, "report.bin")).equals(content));

      const short = await ask(
        { type: "write", path: "x", offset: 0, length: 5, last: true },
        new Uint8Array(3),
      );
      assert.match(short.message, /said 5 bytes, and 3 came/);
      const nowhere = await ask(
        { type: "write", path: "missing/x", offset: 0, length: 0, last: true },
        new Uint8Array(0),
      );
      assert.match(nowhere.message, /No such file or folder/);
      const empty = await ask(
        { type: "write", path: "empty", offset: 0, length: 0, last: true },
        new Uint8Array(0),
      );
      assert.equal(empty.size, 0);
      assert.ok(existsSync(join(workspace, "empty")));

      // A socket that closes with a file unfinished leaves nothing of it.
      void part("left.bin", 0, new Uint8Array(1000));
      await ask({ type: "list" });
      ws.close();
      await until(() => temporaries(workspace).length === 0, "the unfinished file to go");
      assert.equal(existsSync(join(workspace, "left.bin")), false);
    },
  );

  test(
    `isolation ${isolation}: watching can't write, and a computer that only reads offers no writing`,
    options,
    async (t) => {
      const { Computer, to, workspace } = await setup(t, extra);
      writeFileSync(join(workspace, "a.txt"), "a");
      const writer = await Computer.create({ ...to, access: "files", workspace });
      t.after(() => writer.close());
      const watching = await window((await writer.liveSession("files", "watch")).url);
      t.after(() => watching.ws.close());
      const refused = await watching.ask({
        type: "write",
        path: "b.txt",
        offset: 0,
        length: 0,
        last: true,
      });
      assert.match(refused.message, /This socket watches/);
      // The bytes of a write that was refused are let pass; bytes that follow no write end the
      // socket.
      watching.ws.send(new Uint8Array(4));
      assert.equal((await watching.ask({ type: "list" })).entries.length, 1);
      watching.ws.send(new Uint8Array(4));
      assert.equal(await watching.closed, 1008);

      const reader = await Computer.create({ ...to, access: "read", workspace });
      t.after(() => reader.close());
      assert.deepEqual((await reader.getInfo()).surfaces, [
        { surface: "files", protocol: "files@1", operate: false },
      ]);
      await assert.rejects(reader.liveSession("files", "operate"), /watched, not operated/);
      const reading = await window((await reader.liveSession("files")).url);
      t.after(() => reading.ws.close());
      const read = await reading.ask({ type: "read", path: "a.txt", offset: 0, length: 10 });
      assert.equal(read.bytes.toString(), "a");
      assert.equal(existsSync(join(workspace, "b.txt")), false);

      // A message larger than a part of a file is never taken.
      const large = await window((await writer.liveSession("files", "operate")).url);
      large.ws.send(new Uint8Array(2 * MIB));
      assert.equal(await large.closed, 1009);
    },
  );
}
