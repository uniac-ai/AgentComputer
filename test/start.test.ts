// The service started for a person: in the background, once for a data folder, found again after
// what started it has gone and after a crash.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "..", "..", "dist", "agentcomputer.js");
const { version } = JSON.parse(readFileSync(join(here, "..", "..", "package.json"), "utf8")) as {
  version: string;
};
// A driver that isn't there, so that no Cua Driver on the machine running this is asked.
const anyPort = ["--listen", "127.0.0.1:0", "--screen-driver", "/nonexistent/cua-driver"];

/** A data folder of the test's own, and the program run on it. */
function setup(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "ac-"));
  const data = join(root, "data");
  const run = (...args: string[]) =>
    new Promise<{ code: number; out: string; err: string }>((done) => {
      execFile(process.execPath, [CLI, ...args, "--data", data], (error, out, err) =>
        done({ code: error ? Number(error.code) : 0, out, err }),
      );
    });
  t.after(async () => {
    await run("down");
    rmSync(root, { recursive: true, force: true });
  });
  return { data, run };
}

async function until(check: () => Promise<boolean> | boolean, what: string) {
  for (const deadline = Date.now() + 15_000; !(await check()); ) {
    assert.ok(Date.now() < deadline, `Waited too long for ${what}.`);
    await new Promise((done) => setTimeout(done, 50));
  }
}
const gone = (pid: number) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
};

test("--version says which program this is, with no service", async (t) => {
  const { run } = setup(t);
  assert.deepEqual(await run("--version"), { code: 0, out: `${version}\n`, err: "" });
});

test("up runs it in the background once, status finds it, and down ends it", async (t) => {
  const { data, run } = setup(t);
  const none = `No service is running with its data in ${data}. Start one: agentcomputer up\n`;
  assert.deepEqual(await run("status"), { code: 1, out: "", err: none });

  const started = await run("up", ...anyPort);
  assert.equal(started.code, 0, started.err);
  const { url, pid, ...said } = JSON.parse(started.out) as Record<string, unknown>;
  assert.match(String(url), /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.deepEqual(said, { version });

  // Asked again it is the same one, and another can't be run beside it.
  assert.deepEqual(await run("status"), { code: 0, out: started.out, err: "" });
  assert.deepEqual(await run("up", ...anyPort), { code: 0, out: started.out, err: "" });
  const beside = await run("serve", ...anyPort);
  assert.equal(beside.code, 1);
  assert.equal(beside.err, `A service is already running with its data in ${data}, at ${url}.\n`);

  // A computer's start and stop are not the service's: with the id forgotten they stop nothing.
  for (const [word, service] of [
    ["start", "up"],
    ["stop", "down"],
  ] as const) {
    const forgot = await run(word);
    assert.equal(forgot.code, 2);
    assert.ok(
      forgot.err.startsWith(
        `${word} takes a computer's id. For the service itself: agentcomputer ${service}\n`,
      ),
    );
  }
  assert.deepEqual(await run("status"), { code: 0, out: started.out, err: "" });

  // Stopping says nothing, whether or not one was running.
  assert.deepEqual(await run("down"), { code: 0, out: "", err: "" });
  await until(() => gone(pid as number), "the service going");
  assert.deepEqual(await run("status"), { code: 1, out: "", err: none });
  assert.deepEqual(await run("down"), { code: 0, out: "", err: "" });
});

test("its log keeps the end of what it wrote, and up says why it failed", async (t) => {
  const { data, run } = setup(t);
  mkdirSync(data, { mode: 0o700 });
  const log = join(data, "service.log");
  writeFileSync(log, "x".repeat(2 * 1024 * 1024));
  const refused = await run("up", "--isolation", "none");
  assert.equal(refused.code, 1);
  assert.match(
    refused.err,
    /^The service didn't start\. It said:\nOnly create takes --isolation\.\n/,
  );
  assert.ok(statSync(log).size < 1024 * 1024 + 4096);

  const { url } = JSON.parse((await run("up", ...anyPort)).out) as { url: string };
  assert.ok(readFileSync(log, "utf8").endsWith(`AgentComputer on ${url}, data in ${data}\n`));
});

test("it stays when its starter goes, and starts again over a crash's record", async (t) => {
  const { data, run } = setup(t);
  // A starter that starts it and lives on, as an app would, in a group of its own to be ended.
  const starter = spawn(
    "sh",
    [
      "-c",
      '"$0" "$1" up --data "$2" --listen 127.0.0.1:0 >/dev/null && sleep 60',
      process.execPath,
      CLI,
      data,
    ],
    { detached: true, stdio: "ignore" },
  );
  const endStarter = () => {
    try {
      process.kill(-(starter.pid as number), "SIGKILL");
    } catch {
      // It has gone.
    }
  };
  t.after(endStarter);
  await until(async () => (await run("status")).code === 0, "the service answering");
  const before = JSON.parse((await run("status")).out) as { pid: number; url: string };
  endStarter();
  await until(() => gone(starter.pid as number), "the starter going");
  assert.deepEqual(JSON.parse((await run("status")).out), before);

  // It is killed outright, which leaves its record naming nothing.
  process.kill(before.pid, "SIGKILL");
  await until(() => gone(before.pid), "the service going");
  assert.equal((await run("status")).code, 1);
  assert.ok(existsSync(join(data, "server.json")));

  // Started again at the address it had, it is the new one that is given, not the record's.
  const again = await run("up", "--listen", new URL(before.url).host);
  assert.equal(again.code, 0, again.err);
  const after = JSON.parse(again.out) as { pid: number; url: string };
  assert.equal(after.url, before.url);
  assert.notEqual(after.pid, before.pid);
  assert.deepEqual(await run("status"), { code: 0, out: again.out, err: "" });
});
