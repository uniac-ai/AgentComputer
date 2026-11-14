// The person's own browser, for this computer. The browser here is a stand-in: the one
// AGENTCOMPUTER_BROWSER_PATH names, started by the test with remote debugging on and a profile of
// its own, which writes DevToolsActivePort there as Chrome does once its remote debugging is
// switched on. It asks nobody to allow the connection, as Chrome and Edge do: their prompt, and
// Edge's switch, are yet to be tried at a person's own browser.
import assert from "node:assert/strict";
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { after, before, describe, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { chromium, type Page } from "playwright-core";
import { WebSocket } from "ws";
import { ownBrowser, reachedAt } from "../src/own-browser.ts";

type Sdk = typeof import("../src/sdk.ts");
type Computer = Awaited<ReturnType<Sdk["Computer"]["attach"]>>;
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = join(root, "dist", "agentcomputer.js");
const BROWSER = process.env.AGENTCOMPUTER_BROWSER_PATH;
const skip = !BROWSER && "needs AGENTCOMPUTER_BROWSER_PATH";
const PAGE = "data:text/html,<title>The person's page</title>";
const run = promisify(execFile);
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
/** What a browser named by its folder says while it doesn't answer there. */
const NOT_OPEN =
  "The browser's remote debugging is off, or the browser isn't open. On this machine, open the browser, version 144 or later, go to its inspect page, chrome://inspect/#remote-debugging, and switch on remote debugging. The browser then asks you to allow each connection.";

const cleanups: (() => Promise<unknown> | unknown)[] = [];
after(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});
const folderOf = (prefix: string) => {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  cleanups.push(() => rmSync(folder, { recursive: true, force: true }));
  return folder;
};

/** The stand-in for the person's browser, open on one page of theirs. */
async function personsBrowser() {
  const folder = folderOf("ac-own-");
  const child = spawn(
    BROWSER as string,
    [
      "--remote-debugging-port=0",
      `--user-data-dir=${folder}`,
      "--no-first-run",
      ...(process.platform === "linux" ? ["--no-sandbox"] : []),
      PAGE,
    ],
    { stdio: "ignore" },
  );
  cleanups.push(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const gone = once(child, "exit");
    child.kill();
    await gone;
  });
  for (let i = 0; i < 100 && !(await reachedAt(folder)); i++) await sleep(100);
  const endpoint = await reachedAt(folder);
  assert.ok(endpoint, "The stand-in browser wrote no DevToolsActivePort that answers.");
  return { folder, child, endpoint };
}

/** A service of its own, with the person's browser's folder named. */
async function service(browserData: string) {
  const home = folderOf("ac-");
  const data = join(home, "data");
  const workspace = join(home, "workspace");
  mkdirSync(workspace);
  const child: ChildProcess = spawn(
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
      "--own-browser-data",
      browserData,
    ],
    { env: { PATH: process.env.PATH ?? "", HOME: home }, stdio: ["ignore", "pipe", "inherit"] },
  );
  cleanups.push(async () => {
    const gone = once(child, "exit");
    child.kill("SIGTERM");
    await gone;
  });
  const apiUrl = await new Promise<string>((done) =>
    createInterface({ input: child.stdout as NodeJS.ReadableStream }).on("line", (line) => {
      const found = /^AgentComputer on (\S+),/.exec(line);
      if (found) done(found[1] as string);
    }),
  );
  const { Computer } = (await import(pathToFileURL(join(root, "dist", "sdk.js")).href)) as Sdk;
  const to = { apiUrl, apiKey: readFileSync(join(data, "control-token"), "utf8").trim() };
  return { Computer, to, workspace };
}

test("the person's browser is ready where it answers from its folder, and says what to do where not", {
  skip,
}, async () => {
  assert.deepEqual(await ownBrowser(folderOf("ac-own-")), { ready: false, reason: NOT_OPEN });
  const { folder, endpoint } = await personsBrowser();
  assert.deepEqual(await ownBrowser(folder), { ready: true, name: "the browser", endpoint });
  assert.match(endpoint, /^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\//);
});

describe("attached with the person's browser", { skip }, () => {
  let browser: Awaited<ReturnType<typeof personsBrowser>>;
  let made: Awaited<ReturnType<typeof service>>;
  let computer: Computer;
  let said: (name: string, args?: Record<string, unknown>) => Promise<string>;
  /** The person's own page, as they have it. */
  let theirs: Page;

  before(async () => {
    browser = await personsBrowser();
    made = await service(browser.folder);
    computer = await made.Computer.attach({
      ...made.to,
      access: "read",
      workspace: made.workspace,
      browser: "own",
    });
    const info = await computer.getInfo();
    assert.equal(info.browser, "own");
    const client = new Client({ name: "own-browser", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(info.endpoints.browser as string), {
        requestInit: { headers: { Authorization: `Bearer ${computer.getMcpToken()}` } },
      }),
    );
    cleanups.push(() => client.close());
    said = async (name, args = {}) => {
      const { content } = (await client.callTool({ name, arguments: args })) as {
        content: { type: string; text?: string }[];
      };
      return content.map((part) => part.text ?? "").join("\n");
    };
    // The person, at their browser: their page, and a dialog they leave for themselves to answer.
    const person = await chromium.connectOverCDP(browser.endpoint, { noDefaults: true });
    cleanups.push(() => person.close());
    const context = person.contexts()[0];
    context?.on("dialog", () => {});
    theirs = context?.pages().find((page) => page.url().startsWith("data:")) as Page;
    assert.ok(theirs, "The person's page isn't there.");
  });

  test("info says it is ready", async () => {
    const own = (await made.Computer.serviceInfo(made.to)).thisComputer.browsers.find(
      (one) => one.kind === "own",
    );
    assert.deepEqual(own, { kind: "own", ready: true });
  });

  test("the agent's tools see only the tabs it opened, and the first is one of its own", async () => {
    await said("browser_navigate", { url: "data:text/html,<title>The agent's page</title>" });
    const tabs = await said("browser_tabs", { action: "list" });
    assert.match(tabs, /The agent's page/);
    assert.doesNotMatch(tabs, /The person's page/);
    assert.equal(await theirs.title(), "The person's page");
  });

  test("a page the agent's page opens is the agent's too", async () => {
    // A blank page, which a script may open, given a title only once it is open.
    await said("browser_navigate", {
      url: `data:text/html,<title>Opener</title><script>window.open("").document.title = "Its " + "popup"</script>`,
    });
    let tabs = "";
    for (let i = 0; !/Its popup/.test(tabs) && i < 50; i++) {
      tabs = await said("browser_tabs", { action: "list" });
      if (!/Its popup/.test(tabs)) await sleep(100);
    }
    assert.match(tabs, /Its popup/);
    assert.doesNotMatch(tabs, /The person's page/);
  });

  test("a later session finds the agent's tabs, and still not the person's", async () => {
    const info = await computer.getInfo();
    const later = new Client({ name: "later", version: "1" });
    await later.connect(
      new StreamableHTTPClientTransport(new URL(info.endpoints.browser as string), {
        requestInit: { headers: { Authorization: `Bearer ${computer.getMcpToken()}` } },
      }),
    );
    const { content } = (await later.callTool({
      name: "browser_tabs",
      arguments: { action: "list" },
    })) as { content: { text?: string }[] };
    await later.close();
    const tabs = content.map((part) => part.text ?? "").join("\n");
    assert.match(tabs, /Its popup/);
    assert.doesNotMatch(tabs, /The person's page/);
  });

  test("a dialog in the person's tab stays for them to answer", async () => {
    await theirs.evaluate("setTimeout(() => { window.answered = confirm('Leave?') }, 0)");
    await sleep(1_000);
    const blocked = await Promise.race([
      theirs.evaluate("'answered' in window").then(() => "answered"),
      sleep(1_500).then(() => "still open"),
    ]);
    assert.equal(blocked, "still open");
  });

  test("closing the browser isn't the agent's to do", async () => {
    await said("browser_close", {});
    assert.equal(browser.child.exitCode, null);
    assert.equal((await ownBrowser(browser.folder)).ready, true);
  });

  test("switched off by the person, the agent's calls are refused; on again, they are answered", async () => {
    const set = (on: boolean) =>
      fetch(`${made.to.apiUrl}/v1/setup/browser`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${made.to.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ on }),
      });
    assert.equal((await set(false)).status, 200);
    const where = process.platform === "darwin" ? "this Mac" : "this machine";
    assert.equal(
      await said("browser_tabs", { action: "list" }),
      `The person turned off their own browser for agents on ${where}.`,
    );
    assert.equal((await set(true)).status, 200);
    assert.match(await said("browser_tabs", { action: "list" }), /Opener/);
  });

  test("the person watches every tab in the live view, theirs among them", async () => {
    const live = new WebSocket((await computer.liveSession("browser", "watch")).url);
    const tabs = await new Promise<string>((done, failed) => {
      live.on("error", failed);
      live.on("message", (data, binary) => {
        if (!binary && /"type":"tabs"/.test(data.toString())) done(data.toString());
      });
    });
    live.close();
    assert.match(tabs, /The person's page/);
    assert.match(tabs, /Opener/);
  });

  test("detached, the browser is let go, and stays open", async () => {
    await computer.kill();
    assert.equal(browser.child.exitCode, null);
    assert.equal((await ownBrowser(browser.folder)).ready, true);
  });

  test("when the person's browser closes, the computer is failed, and attaching is refused with why", async () => {
    const again = await made.Computer.attach({
      ...made.to,
      access: "read",
      workspace: made.workspace,
      browser: "own",
    });
    const gone = once(browser.child, "exit");
    browser.child.kill();
    await gone;
    let state = "";
    for (let i = 0; state !== "failed" && i < 100; i++) {
      state = (await again.getInfo()).state;
      if (state !== "failed") await sleep(100);
    }
    assert.equal(state, "failed");
    await assert.rejects(
      made.Computer.attach({
        ...made.to,
        access: "read",
        workspace: made.workspace,
        browser: "own",
      }),
      { code: 409, message: NOT_OPEN },
    );
  });
});

test("a connection the browser doesn't allow is refused with 409 and what to do", {
  skip,
}, async () => {
  // Something of the person's on the port the browser named, which refuses what is asked of it.
  const refusing = createServer((_, answer) => answer.writeHead(403).end());
  await new Promise<void>((done) => refusing.listen(0, "127.0.0.1", done));
  cleanups.push(() => refusing.close());
  const folder = folderOf("ac-own-");
  const { port } = refusing.address() as AddressInfo;
  writeFileSync(join(folder, "DevToolsActivePort"), `${port}\n/devtools/browser/refused\n`);
  const { Computer, to, workspace } = await service(folder);
  await assert.rejects(Computer.attach({ ...to, access: "read", workspace, browser: "own" }), {
    code: 409,
    message:
      "The browser didn't allow the connection, or nobody answered it within 2 minutes. Allow it when the browser asks, on this machine.",
  });
});

test("only attach takes --own-browser, and not beside --browser", async () => {
  for (const [args, said] of [
    [["create", "--access", "read", "--own-browser"], "Only attach takes --own-browser."],
    [
      ["attach", "--access", "read", "--workspace", ".", "--browser", "--own-browser"],
      "Take --browser or --own-browser: a computer has one browser.",
    ],
  ] as const)
    await assert.rejects(run(process.execPath, [CLI, ...args]), (error: { stderr: string }) =>
      error.stderr.startsWith(said),
    );
});
