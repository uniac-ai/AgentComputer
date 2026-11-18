// The browser's two processes, its host and its MCP server, are this program run again with their
// own arguments, and a person reads their command lines in `ps`. Those lines are as they were
// when the browser found the program by its own file: Node, the program's file, the arguments.
import assert from "node:assert/strict";
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

type Sdk = typeof import("@agentorg/computer-sdk");
const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "..", "dist");
const CLI = join(dist, "agentcomputer.js");
const BROWSER = process.env.AGENTCOMPUTER_BROWSER_PATH;
const run = promisify(execFile);

/** Every process's id, its parent's, and its command line as `ps` shows it. */
async function processes() {
  const { stdout } = await run("ps", ["-A", "-ww", "-o", "pid=,ppid=,args="]);
  return stdout
    .split("\n")
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
    .filter((found) => found !== null)
    .map(([, pid, ppid, args]) => ({ pid: Number(pid), ppid: Number(ppid), args: args as string }));
}

test("the browser's host and MCP server are run as before: Node, the program's file, their arguments", {
  skip: !BROWSER && "needs AGENTCOMPUTER_BROWSER_PATH",
}, async (t) => {
  const root = realpathSync(
    mkdtempSync(join(process.env.AGENTCOMPUTER_TEST_ROOT ?? tmpdir(), "ac-")),
  );
  const data = join(root, "data");
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const service: ChildProcess = spawn(
    process.execPath,
    [
      CLI,
      "serve",
      "--listen",
      "127.0.0.1:0",
      "--data",
      data,
      "--screen-driver",
      "/nonexistent/cua-driver",
      "--browser-name",
      "chromium",
      "--browser-path",
      BROWSER as string,
    ],
    {
      env: { PATH: process.env.PATH ?? "", HOME: root, SHELL: "/bin/bash" },
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  const url = await new Promise<string>((done, failed) => {
    service.once("exit", (code) => failed(new Error(`The service exited ${code}.`)));
    createInterface({ input: service.stdout as NodeJS.ReadableStream }).on("line", (line) => {
      const found = /^AgentComputer on (\S+),/.exec(line);
      if (found) done(found[1] as string);
    });
  });
  service.removeAllListeners("exit");
  const { Computer } = (await import(pathToFileURL(join(dist, "sdk.js")).href)) as Sdk;
  const to = { apiUrl: url, apiKey: readFileSync(join(data, "control-token"), "utf8").trim() };
  t.after(async () => {
    for (const computer of await Computer.list(to).catch(() => []))
      await Computer.kill(computer.computerID, to).catch(() => {});
    const gone = once(service, "exit");
    service.kill("SIGTERM");
    await gone;
    rmSync(root, { recursive: true, force: true });
  });

  const computer = await Computer.attach({ ...to, access: "read", browser: true, workspace });
  const folder = join(data, "computers", computer.computerID, "browser");
  // The program as Node runs it: the file it was started as, with links followed.
  const program = `${process.execPath} ${realpathSync(CLI)}`;
  let started: { args: string }[] = [];
  for (const deadline = Date.now() + 30_000; Date.now() < deadline; ) {
    started = (await processes()).filter(({ ppid }) => ppid === service.pid);
    if (started.some(({ args }) => args.includes(" browser-mcp "))) break;
    await new Promise((done) => setTimeout(done, 100));
  }
  const host = started.find(({ args }) => args.includes(" browser-host "));
  const mcp = started.find(({ args }) => args.includes(" browser-mcp "));
  assert.equal(
    host?.args,
    `${program} browser-host --profile ${join(folder, "profile")} --executable ${BROWSER}`,
  );
  assert.match(
    mcp?.args ?? "",
    new RegExp(
      `^${program.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} browser-mcp --endpoint \\S+ --output ${join(folder, "output").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
    ),
  );
});

test("unbundled, the browser runs the program it is given, as its own package's build", {
  skip: !BROWSER && "needs AGENTCOMPUTER_BROWSER_PATH",
}, async (t) => {
  const { Browser } = await import("@agentorg/computer-browser/browser");
  const folder = realpathSync(
    mkdtempSync(join(process.env.AGENTCOMPUTER_TEST_ROOT ?? tmpdir(), "ac-")),
  );
  const browser = new Browser(
    { path: BROWSER, browser: "chromium", program: [process.execPath, CLI] },
    folder,
    folder,
    false,
    () => {},
    () => {},
  );
  t.after(async () => {
    await browser.stop();
    rmSync(folder, { recursive: true, force: true });
  });
  await browser.ready();
  assert.ok(browser.tools.includes("browser_navigate"), browser.tools.join(", "));
});
