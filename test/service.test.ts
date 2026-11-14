// The built service, run as a person runs it, used by a hand-run MCP client.
import assert from "node:assert/strict";
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { type AddressInfo, connect } from "node:net";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { z } from "zod";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "..", "..", "dist", "agentcomputer.js");
const realBrowser = process.env.AGENTCOMPUTER_BROWSER_PATH;
/** The headless shell, never the Chrome installed on this machine. */
const BROWSER_ARGS = realBrowser
  ? ["--browser-name", "chromium", "--browser-path", realBrowser]
  : [];
const withBrowser = { skip: !realBrowser && "needs AGENTCOMPUTER_BROWSER_PATH" };
const run = promisify(execFile);

interface Created {
  computerID: string;
  state: string;
  isolation: string;
  attached: boolean;
  version: string | null;
  accessToken: string;
  workspace: string | null;
  endpoints: { computer: string | null; browser: string | null };
}

/** Ask for a WebSocket at this request target, as sent, and give the first line of the answer. */
function upgrade(port: number, target: string) {
  return new Promise<string>((done) => {
    const socket = connect(port, "127.0.0.1", () =>
      socket.write(
        [
          `GET ${target} HTTP/1.1`,
          "Host: localhost",
          "Upgrade: websocket",
          "Connection: Upgrade",
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
          "Sec-WebSocket-Version: 13",
          "\r\n",
        ].join("\r\n"),
      ),
    );
    let got = "";
    socket.on("data", (data) => {
      got += data;
    });
    socket.on("error", () => {});
    socket.on("close", () => done(got.split("\r\n")[0] ?? ""));
  });
}

async function setup(
  t: test.TestContext,
  extra: string[] = BROWSER_ARGS,
  env: Record<string, string> = {},
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agentcomputer-")));
  const data = join(root, "data");
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  let child: ChildProcess;
  let url = "";
  const start = async () => {
    child = spawn(
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
        ...extra,
      ],
      {
        env: { PATH: process.env.PATH ?? "", HOME: root, SHELL: "/bin/bash", ...env },
        stdio: ["ignore", "pipe", "inherit"],
      },
    );
    url = await new Promise<string>((done, failed) => {
      child.once("exit", (code) => failed(new Error(`The service exited ${code}.`)));
      createInterface({ input: child.stdout as NodeJS.ReadableStream }).on("line", (line) => {
        const found = /^AgentComputer on (\S+),/.exec(line);
        if (found) done(found[1] as string);
      });
    });
  };
  const stop = async () => {
    child.removeAllListeners("exit");
    const gone = once(child, "exit");
    child.kill("SIGTERM");
    await gone;
  };
  await start();
  const clients: Client[] = [];
  t.after(async () => {
    for (const client of clients) await client.close().catch(() => {});
    await stop();
    rmSync(root, { recursive: true, force: true });
  });
  const cli = async (...args: string[]) =>
    (await run(process.execPath, [CLI, ...args, "--data", data])).stdout;
  const create = async (...args: string[]) => JSON.parse(await cli("create", ...args)) as Created;
  const attach = async (...args: string[]) => JSON.parse(await cli("attach", ...args)) as Created;
  const control = readFileSync(join(data, "control-token"), "utf8").trim();
  const api = (path: string, init: RequestInit = {}, token = control) =>
    fetch(`${url}/v1/computers${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    });
  const mcp = async (endpoint: string, token: string) => {
    const client = new Client({ name: "by-hand", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(endpoint), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    );
    clients.push(client);
    const names = async () => (await client.listTools()).tools.map((tool) => tool.name).sort();
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const { content, isError } = (await client.callTool({ name, arguments: args })) as {
        content: { type: string; text?: string; mimeType?: string; data?: string }[];
        isError?: boolean;
      };
      return {
        text: content.map((b) => b.text ?? "").join(""),
        isError: !!isError,
        images: content.filter((b) => b.type === "image"),
      };
    };
    return { names, call, client };
  };
  /** Stop it and start it again, doing this to its data folder in between. */
  const restart = async (between: () => void = () => {}) => {
    await stop();
    between();
    await start();
  };
  return {
    root,
    data,
    workspace,
    cli,
    create,
    attach,
    control,
    api,
    mcp,
    restart,
    url: () => url,
  };
}

const initialize = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "x", version: "1" },
  },
});
const raw = (endpoint: string, token: string) =>
  fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: initialize,
  });

test("agentcomputer attach gives endpoints a hand-run MCP client uses", withBrowser, async (t) => {
  const { attach, mcp, workspace, root } = await setup(t);
  const made = await attach("--access", "terminal", "--browser", "--workspace", workspace);
  assert.deepEqual([made.state, made.attached, made.isolation], ["running", true, "none"]);
  const computer = await mcp(made.endpoints.computer as string, made.accessToken);
  const ran = await computer.call("exec_command", { cmd: "pwd" });
  assert.equal(ran.isError, false);
  assert.match(ran.text, /^exit_code: 0\n/);
  assert.ok(ran.text.includes(workspace));
  const edited = await computer.call("edit", { path: "n.txt", old_text: "", new_text: "hi\n" });
  assert.equal(edited.isError, false);
  assert.equal(readFileSync(join(workspace, "n.txt"), "utf8"), "hi\n");
  // Its files reach the whole machine, as whoever started the service: the folder is where its
  // work starts, not a wall.
  writeFileSync(join(root, "beside.txt"), "beside\n");
  assert.match(
    (await computer.call("read", { path: join(root, "beside.txt") })).text,
    /^1\tbeside$/m,
  );
  const started = await computer.call("exec_command", { cmd: "cat", yield_time_ms: 250 });
  const session_id = /session_id: (\S+)/.exec(started.text)?.[1] as string;
  const typed = await computer.call("write_stdin", {
    session_id,
    chars: "x\n",
    yield_time_ms: 2000,
  });
  assert.match(typed.text, /text:\nx\n$/);
  await computer.call("write_stdin", { session_id, chars: "\u0004", yield_time_ms: 5000 });

  // What calls its tools puts the commands it starts in a group, and ends that group together.
  // A command's call that is given up while it waits leaves the command running; the stop ends
  // it, answering once it has ended, and never touches a command in no group.
  const givenUp = new AbortController();
  const waiting = computer.client
    .callTool(
      {
        name: "exec_command",
        arguments: { cmd: "sleep 100", yield_time_ms: 30_000 },
        _meta: { "agentexec/group": "a" },
      },
      { signal: givenUp.signal },
    )
    .catch((error: Error) => error.message);
  await computer.call("exec_command", { cmd: "sleep 101", yield_time_ms: 250 });
  const sessions = async () => (await computer.call("list_sessions")).text;
  for (let tries = 0; !(await sessions()).includes("cmd: sleep 100"); tries++) {
    assert.ok(tries < 200, "The command never became a session.");
    await sleep(50);
  }
  givenUp.abort(new Error("Given up."));
  assert.match(String(await waiting), /Given up\.$/);
  assert.match(await sessions(), /exit_code: running\ncmd: sleep 100/);
  assert.deepEqual(
    await computer.client.request(
      { method: "agentexec/group/stop", params: { group: "a" } },
      z.object({ stopped: z.number() }),
    ),
    { stopped: 1 },
  );
  const after = await sessions();
  assert.match(after, /exit_code: 130\ncmd: sleep 100/);
  assert.match(after, /exit_code: running\ncmd: sleep 101/);

  const browser = await mcp(made.endpoints.browser as string, made.accessToken);
  assert.ok((await browser.names()).includes("browser_navigate"));
  assert.equal((await browser.call("browser_navigate", { url: "about:blank" })).isError, false);

  // A screenshot of its browser comes back as a picture, and a picture in its folder is read as
  // one, by its bytes and not its name: both are what a client passes on to a model.
  const shots = (await browser.call("browser_take_screenshot")).images;
  assert.deepEqual(
    shots.map((shot) => shot.mimeType),
    ["image/png"],
  );
  writeFileSync(join(workspace, "shot"), Buffer.from(shots[0]?.data ?? "", "base64"));
  const read = await computer.call("read", { path: "shot" });
  assert.equal(read.text, "shot: image/png");
  assert.deepEqual(read.images, shots);

  // A long page of noise, which doesn't compress, below a blank screenful: asked for whole it is
  // refused in words that say how to take a smaller one, and what is on screen is still a picture.
  const noise =
    "const c = document.querySelector('canvas'), x = c.getContext('2d');" +
    "const d = x.createImageData(c.width, c.height);" +
    "for (let i = 0; i < d.data.length; i++) d.data[i] = Math.random() * 256;" +
    "x.putImageData(d, 0, 0);";
  const page = `<div style="height:2000px"></div><canvas width="1200" height="2000"></canvas><script>${noise}</script>`;
  await browser.call("browser_navigate", { url: `data:text/html,${encodeURIComponent(page)}` });
  const whole = await browser.call("browser_take_screenshot", { fullPage: true });
  assert.deepEqual([whole.isError, whole.images], [true, []]);
  assert.match(
    whole.text,
    /^The screenshot is \d+\.\d MiB, and the most a screenshot may be is 3 MiB\. Take it again without fullPage for what is on screen, or with element and target for one part of the page\.$/,
  );
  const onScreen = await browser.call("browser_take_screenshot");
  assert.deepEqual([onScreen.isError, onScreen.images.length], [false, 1]);
});

test("the control token and each computer's token reach only their own", async (t) => {
  const { attach, api, control, workspace, data, url } = await setup(t);
  const one = await attach("--access", "read", "--workspace", workspace);
  const two = await attach("--access", "read", "--workspace", workspace);
  const endpoint = one.endpoints.computer as string;
  assert.equal((await raw(endpoint, one.accessToken)).status, 200);
  assert.equal((await raw(endpoint, two.accessToken)).status, 401);
  assert.equal((await raw(endpoint, control)).status, 401);
  assert.equal((await raw(endpoint, "wrong")).status, 401);
  assert.equal((await fetch(endpoint, { method: "POST", body: initialize })).status, 401);

  assert.equal((await api("")).status, 200);
  assert.equal((await api("", {}, one.accessToken)).status, 401);
  assert.equal((await api(`/${one.computerID}`, {}, one.accessToken)).status, 401);
  assert.equal(
    (await api(`/${one.computerID}`, { method: "DELETE" }, one.accessToken)).status,
    401,
  );
  assert.equal((await api("", {}, "wrong")).status, 401);
  assert.equal((await raw(`${url()}/v1/mcp`, control)).status, 200);
  assert.equal((await raw(`${url()}/v1/mcp`, one.accessToken)).status, 401);

  // A token is shown once and kept only as a digest.
  const listed = JSON.stringify(await (await api("")).json());
  assert.ok(!listed.includes(one.accessToken));
  assert.ok(!readFileSync(join(data, "computers.json"), "utf8").includes(one.accessToken));
  for (const file of ["control-token", "computers.json", "server.json"])
    assert.equal(statSync(join(data, file)).mode & 0o777, 0o600, file);
  assert.equal(statSync(data).mode & 0o777, 0o700);
});

for (const [access, tools] of [
  ["read", ["about", "list", "read", "search"]],
  ["files", ["about", "edit", "list", "read", "search"]],
  [
    "terminal",
    ["about", "edit", "exec_command", "list", "list_sessions", "read", "search", "write_stdin"],
  ],
] as const)
  test(`at ${access} the service lists only its tools`, async (t) => {
    const { attach, mcp, workspace, api } = await setup(t);
    const made = await attach("--access", access, "--workspace", workspace);
    assert.deepEqual(
      await (await mcp(made.endpoints.computer as string, made.accessToken)).names(),
      tools,
    );
    const got = (await (await api(`/${made.computerID}`)).json()) as {
      tools: { computer: string[] };
    };
    assert.deepEqual([...got.tools.computer].sort(), tools);
  });

test("about tells the agent what a person reads of its computer", async (t) => {
  const { attach, mcp, workspace } = await setup(t);
  const made = await attach("--access", "files", "--workspace", workspace);
  const computer = await mcp(made.endpoints.computer as string, made.accessToken);
  const { text, isError } = await computer.call("about");
  assert.equal(isError, false);
  const { rows } = JSON.parse(text) as { rows: Record<string, unknown>[] };
  assert.deepEqual(rows.slice(0, 5), [
    { label: "Where", value: hostname() },
    { label: "Folder", value: workspace, path: true },
    { label: "Reaches", value: "Files" },
    { label: "Isolation", value: "None: it acts as you, on the whole machine", caution: true },
    { label: "Acting now", value: "Nobody else" },
  ]);
  const [cpu, memory, disk] = rows.slice(5).map((row) => `${row.label}: ${row.value}`);
  assert.match(cpu ?? "", /^CPU: \d+%$/);
  assert.match(memory ?? "", /^Memory: [\d.]+ of [\d.]+ GB$/);
  assert.match(disk ?? "", /^Disk: \d+ of \d+ GB$/);
  assert.equal(rows.length, 8);
});

test(
  "below terminal the tool that runs code is hidden and refused, at terminal it's there",
  withBrowser,
  async (t) => {
    const { attach, mcp, workspace } = await setup(t);
    const below = await attach("--access", "files", "--browser", "--workspace", workspace);
    const browser = await mcp(below.endpoints.browser as string, below.accessToken);
    const names = await browser.names();
    assert.ok(names.includes("browser_navigate"));
    assert.ok(!names.includes("browser_run_code_unsafe"));
    await assert.rejects(browser.call("browser_run_code_unsafe"), /Unknown tool/);
    // Nor does it get by in a body that isn't one request read here as the browser's server would
    // read it: a batch, or one behind a byte order mark, which that server skips. On a session of
    // its own, each is refused whole and nothing is passed on.
    const post = (body: string, session?: string) =>
      fetch(below.endpoints.browser as string, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${below.accessToken}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          ...(session ? { "mcp-session-id": session } : {}),
        },
        body,
      });
    const hello = await post(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "by-hand", version: "1" },
        },
      }),
    );
    const session = hello.headers.get("mcp-session-id") as string;
    await hello.text();
    const call = JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "browser_run_code_unsafe", arguments: { code: "async () => 6 * 7" } },
    });
    const list = JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" });
    // The session is a live one: asked plainly, it lists its tools, less the hidden one.
    const plain = await (await post(list, session)).text();
    assert.ok(plain.includes("browser_navigate") && !plain.includes("browser_run_code_unsafe"));
    for (const body of [`[${call}]`, `[${list}]`, `\ufeff${call}`, `\ufeff${list}`, "[]", "null"]) {
      const refused = await post(body, session);
      assert.deepEqual(
        [refused.status, ((await refused.json()) as { error: { message: string } }).error.message],
        [
          400,
          "A body is one JSON-RPC request, as a JSON object: send each request in its own POST.",
        ],
        body,
      );
    }
    const full = await attach("--access", "terminal", "--browser", "--workspace", workspace);
    assert.ok(
      (await (await mcp(full.endpoints.browser as string, full.accessToken)).names()).includes(
        "browser_run_code_unsafe",
      ),
    );
    // What each reaches is told to its agent as a person reads it.
    for (const [made, reaches] of [
      [below, "Files, Browser"],
      [full, "Files and terminal, Browser"],
    ] as const) {
      const computer = await mcp(made.endpoints.computer as string, made.accessToken);
      const { rows } = JSON.parse((await computer.call("about")).text) as { rows: unknown[] };
      assert.deepEqual(rows[2], { label: "Reaches", value: reaches });
    }
  },
);

test("a computer has only what it was asked for", withBrowser, async (t) => {
  const { attach, api, workspace, url, data } = await setup(t);
  const plain = await attach("--access", "read", "--workspace", workspace);
  assert.equal(plain.endpoints.browser, null);
  assert.equal(
    (await raw(`${url()}/v1/computers/${plain.computerID}/mcp/browser`, plain.accessToken)).status,
    404,
  );
  const only = await attach("--access", "none", "--browser", "--workspace", workspace);
  assert.equal(only.endpoints.computer, null);
  assert.ok(only.endpoints.browser);
  // Made or attached, the same is refused, before anything is made.
  for (const path of ["", "/attach"]) {
    const refuse = async (body: object) =>
      (await api(path, { method: "POST", body: JSON.stringify(body) })).status;
    assert.equal(await refuse({ access: "none", workspace }), 400, path);
    assert.equal(await refuse({ access: "everything", workspace }), 400, path);
    assert.equal(await refuse({ access: "read", workspace: "relative" }), 400, path);
    assert.equal(await refuse({ access: "read", workspace: join(workspace, "nope") }), 400, path);
    assert.equal(await refuse({ access: "read", workspace, timeout: -1 }), 400, path);
  }
  // This computer only with a work folder.
  const bare = await api("/attach", { method: "POST", body: JSON.stringify({ access: "read" }) });
  assert.equal(bare.status, 400);
  // A workspace that starts as a copy is one of its own, of a folder that is there, and made only
  // where there is a workspace; this computer has none to copy into.
  const make = async (path: string, body: object) => {
    const answer = await api(path, { method: "POST", body: JSON.stringify(body) });
    return [answer.status, ((await answer.json()) as { message: string }).message];
  };
  assert.deepEqual(await make("", { access: "read", workspace, copyFrom: workspace }), [
    400,
    "Give workspace or copyFrom, not both: copyFrom fills a workspace the service makes.",
  ]);
  assert.deepEqual(await make("", { access: "none", browser: true, copyFrom: workspace }), [
    400,
    "With access none there is no workspace. Give access read, files or terminal, or leave out copyFrom.",
  ]);
  for (const copyFrom of ["relative", join(workspace, "nope")])
    assert.deepEqual(await make("", { access: "read", copyFrom }), [
      400,
      `There's no folder at ${copyFrom}.`,
    ]);
  assert.equal((await make("/attach", { access: "read", workspace, copyFrom: workspace }))[0], 400);
  // A copy that fails leaves nothing behind: no computer, and no folder of one.
  const unreadable = join(workspace, "locked");
  mkdirSync(unreadable);
  writeFileSync(join(unreadable, "secret.txt"), "x");
  chmodSync(join(unreadable, "secret.txt"), 0o000);
  const ids = async () =>
    ((await (await api("")).json()) as Created[]).map((one) => one.computerID);
  const [listed, folders] = [await ids(), readdirSync(join(data, "computers")).sort()];
  const [status] = await make("", { access: "read", copyFrom: unreadable });
  chmodSync(join(unreadable, "secret.txt"), 0o600);
  assert.equal(status, 500);
  assert.deepEqual(await ids(), listed);
  assert.deepEqual(readdirSync(join(data, "computers")).sort(), folders);
});

test("killing this computer detaches it, and removes nothing of the machine's", async (t) => {
  const { attach, cli, workspace, data, api } = await setup(t);
  writeFileSync(join(workspace, "kept.txt"), "kept\n");
  const attached = await attach("--access", "files", "--workspace", workspace);
  await cli("kill", attached.computerID);
  assert.equal(readFileSync(join(workspace, "kept.txt"), "utf8"), "kept\n");
  assert.equal((await api(`/${attached.computerID}`)).status, 404);
  assert.equal(
    (await raw(attached.endpoints.computer as string, attached.accessToken)).status,
    401,
  );
  // What the service kept for it, its log and its token's digest, goes.
  assert.equal(existsSync(join(data, "computers", attached.computerID)), false);
});

test("a computer stops at its timeout, its folder stays, and a running one can be extended", async (t) => {
  const { attach, cli, api, workspace } = await setup(t);
  const short = await attach("--access", "read", "--workspace", workspace, "--timeout", "1");
  const kept = await attach("--access", "read", "--workspace", workspace, "--timeout", "1");
  const extended = JSON.parse(await cli("timeout", kept.computerID, "600")) as { endAt: string };
  assert.ok(Date.parse(extended.endAt) > Date.now() + 500_000);
  await new Promise((done) => setTimeout(done, 1500));
  const stopped = (await (await api(`/${short.computerID}`)).json()) as { state: string };
  assert.equal(stopped.state, "stopped");
  assert.equal((await raw(short.endpoints.computer as string, short.accessToken)).status, 409);
  assert.ok(existsSync(workspace));
  assert.equal((await raw(kept.endpoints.computer as string, kept.accessToken)).status, 200);
  assert.equal(
    (await api(`/${short.computerID}/timeout`, { method: "POST", body: '{"timeout":60}' })).status,
    409,
  );
});

test(
  "computers and tokens come back when the service restarts, and logs say what happened",
  withBrowser,
  async (t) => {
    const { attach, restart, cli, url, workspace } = await setup(t);
    const made = await attach("--access", "read", "--browser", "--workspace", workspace);
    const before = new URL(made.endpoints.computer as string).pathname;
    await restart();
    assert.equal((await raw(`${url()}${before}`, made.accessToken)).status, 200);
    assert.match(await cli("logs", made.computerID), /POST mcp\/computer/);
    const listed = JSON.parse(await cli("list")) as Created[];
    // This computer runs the service's own program.
    const { version } = JSON.parse(await cli("info")) as { version: string };
    assert.deepEqual(
      listed.map((one) => [one.computerID, one.state, one.attached, one.version]),
      [[made.computerID, "running", true, version]],
    );
  },
);

for (const [why, reason, args] of [
  ["another address without TLS", /TLS/, ["--listen", "0.0.0.0:0"]],
  [
    "an isolation of its own",
    /Only create takes --isolation\./,
    ["--listen", "127.0.0.1:0", "--isolation", "container"],
  ],
] as const)
  test(`serve refuses ${why}`, async (t) => {
    const data = mkdtempSync(join(tmpdir(), "agentcomputer-"));
    t.after(() => rmSync(data, { recursive: true, force: true }));
    await assert.rejects(
      run(process.execPath, [CLI, "serve", ...args, "--data", data]),
      (error: Error & { stderr: string }) => reason.test(error.stderr),
    );
  });

test("info says what this computer offers, each ready or not and why", async (t) => {
  // A driver that isn't there, so that no Cua Driver on the machine running this is asked.
  const noDriver = ["--screen-driver", "/nonexistent/cua-driver"];
  const { cli } = await setup(t, ["--browser-path", "/nonexistent/browser", ...noDriver]);
  const screen = {
    capability: "screen",
    ready: false,
    reason:
      "Cua Driver isn't installed on this machine. Install the signed app from cua.ai/download, then grant it Screen Recording and Accessibility.",
  };
  const offered = (browser: object) => ({
    ready: true,
    capabilities: [
      { capability: "about", ready: true },
      { capability: "terminal", ready: true },
      { capability: "files", ready: true },
      screen,
    ],
    browsers: [{ kind: "headless", ...browser }],
  });
  const { thisComputer } = JSON.parse(await cli("info")) as Record<string, unknown>;
  assert.deepEqual(
    thisComputer,
    offered({
      ready: false,
      reason:
        "There's no browser at /nonexistent/browser. Start the service with a --browser-path that exists.",
    }),
  );
  const other = await setup(t, ["--browser-name", "no-such-channel", ...noDriver]);
  assert.deepEqual(
    (JSON.parse(await other.cli("info")) as Record<string, unknown>).thisComputer,
    offered({
      ready: false,
      reason:
        "The browser no-such-channel isn't installed on this machine. Install it, or start the service with --browser-name or --browser-path.",
    }),
  );
  if (realBrowser)
    assert.deepEqual(
      (
        JSON.parse(await (await setup(t, [...BROWSER_ARGS, ...noDriver])).cli("info")) as Record<
          string,
          unknown
        >
      ).thisComputer,
      offered({ ready: true }),
    );
});

test("where Docker doesn't answer, nothing is made and this computer is still attached", async (t) => {
  const { cli, create, attach, api, workspace } = await setup(t, BROWSER_ARGS, {
    DOCKER_HOST: "unix:///nonexistent/docker.sock",
  });
  const needsDocker = "A container needs Docker, which isn't answering on this machine.";
  const { made } = JSON.parse(await cli("info")) as { made: Record<string, unknown>[] };
  assert.deepEqual(
    made.map(({ isolation, ready, reason }) => [isolation, ready, reason]),
    [["container", false, needsDocker]],
  );
  const refused = (words: RegExp) => (error: Error & { stderr: string }) =>
    words.test(error.stderr);
  const asked = ["--access", "read", "--workspace", workspace];
  await assert.rejects(create(...asked), refused(new RegExp(needsDocker)));
  await assert.rejects(
    create(...asked, "--isolation", "container"),
    refused(new RegExp(needsDocker)),
  );
  const answer = await api("", {
    method: "POST",
    body: JSON.stringify({ access: "read", workspace }),
  });
  assert.deepEqual(
    [answer.status, await answer.json()],
    [409, { code: 409, message: needsDocker }],
  );
  await assert.rejects(
    create(...asked, "--isolation", "vm"),
    refused(/isolation must be equal to one of the allowed values/),
  );
  // Only create takes an isolation: attach, which has none, refuses one.
  await assert.rejects(
    attach(...asked, "--isolation", "container"),
    refused(/Only create takes --isolation\./),
  );
  // A computer with no isolation is no longer made: what does that is this computer, attached.
  const none = await api("", {
    method: "POST",
    body: JSON.stringify({ access: "read", workspace, isolation: "none" }),
  });
  assert.deepEqual(
    [none.status, await none.json()],
    [
      400,
      {
        code: 400,
        message:
          "A computer with no isolation is no longer made. Attach this computer, or make a container.",
      },
    ],
  );
  assert.equal((await attach(...asked)).attached, true);
  assert.deepEqual(
    (JSON.parse(await cli("list")) as Created[]).map((one) => [one.isolation, one.attached]),
    [["none", true]],
  );
});

test("info doesn't wait on a Docker that hangs", async (t) => {
  // A `docker` that never answers, first on the service's PATH.
  const bin = mkdtempSync(join(tmpdir(), "agentcomputer-bin-"));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  writeFileSync(join(bin, "docker"), "#!/bin/sh\nexec sleep 60\n", { mode: 0o755 });
  const { cli } = await setup(t, BROWSER_ARGS, { PATH: `${bin}:${process.env.PATH ?? ""}` });
  const asked = Date.now();
  const { made } = JSON.parse(await cli("info")) as { made: { ready: boolean }[] };
  assert.deepEqual(
    made.map((one) => one.ready),
    [false],
  );
  assert.ok(Date.now() - asked < 3_000);
});

test("a computer made with no isolation before can't start again, and its folder is kept", async (t) => {
  const { attach, restart, cli, api, workspace, data, url } = await setup(t);
  const named = await attach("--access", "files", "--workspace", workspace);
  const own = await attach("--access", "files", "--workspace", workspace);
  // Their records as services before this one wrote them, made with no isolation and neither
  // attached: one as 0.0.15 to 0.0.18 did, in a folder someone named, and one as 0.0.14 and
  // earlier did, keeping no isolation, in a folder the service made.
  const ownFolder = join(data, "computers", own.computerID, "workspace");
  await restart(() => {
    const file = join(data, "computers.json");
    const records = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>[];
    for (const record of records) {
      delete record.attached;
      if (record.id === own.computerID) {
        delete record.isolation;
        record.workspace = ownFolder;
      }
    }
    writeFileSync(file, JSON.stringify(records));
    mkdirSync(ownFolder);
    writeFileSync(join(ownFolder, "work.txt"), "work\n");
  });
  const words = (folder: string) =>
    `A computer with no isolation is no longer made. Its folder is kept at ${folder}. Attach this computer with that folder as its work folder, or make a container whose workspace starts as a copy of it.`;
  const listed = JSON.parse(await cli("list")) as Created[];
  assert.deepEqual(
    listed.map((one) => [one.computerID, one.state, one.isolation, one.attached]),
    [
      [own.computerID, "failed", "none", false],
      [named.computerID, "failed", "none", false],
    ],
  );
  for (const [made, folder] of [
    [named, workspace],
    [own, ownFolder],
  ] as const) {
    assert.ok(
      (await cli("logs", made.computerID)).includes(`It didn't start again: ${words(folder)}`),
    );
    // Stopped and started again as the failed are, it is refused with what to do instead.
    await cli("stop", made.computerID);
    const start = await api(`/${made.computerID}/start`, { method: "POST", body: "{}" });
    assert.deepEqual(
      [start.status, await start.json()],
      [409, { code: 409, message: words(folder) }],
    );
    const endpoint = `${url()}${new URL(made.endpoints.computer as string).pathname}`;
    assert.equal((await raw(endpoint, made.accessToken)).status, 409);
  }
  // Removed, each leaves its folder: the service's own one too, with nothing else of it.
  await cli("kill", named.computerID);
  await cli("kill", own.computerID);
  assert.ok(existsSync(workspace));
  assert.equal(existsSync(join(data, "computers", named.computerID)), false);
  assert.equal(readFileSync(join(ownFolder, "work.txt"), "utf8"), "work\n");
  assert.deepEqual(readdirSync(dirname(ownFolder)), ["workspace"]);
  assert.equal((await api("")).status, 200);
});

test("a malformed live address is refused, and the service stays", async (t) => {
  const { url, api } = await setup(t, []);
  const port = Number(new URL(url()).port);
  // A ticket with a broken escape in it, and a target no URL can be made of, from anyone.
  for (const target of ["/v1/live/%E0%A4%A", "http://["])
    assert.equal(await upgrade(port, target), "HTTP/1.1 404 Not Found", target);
  assert.equal((await api("")).status, 200);
});

test("a command with no service running says how to start one", async () => {
  const data = mkdtempSync(join(tmpdir(), "agentcomputer-"));
  await assert.rejects(
    run(process.execPath, [CLI, "list", "--data", data]),
    (error: Error & { stderr: string }) => /Start one: agentcomputer up/.test(error.stderr),
  );
  rmSync(data, { recursive: true, force: true });
});

test("real: Playwright MCP opens and reads a page through the proxy", {
  skip: !realBrowser,
}, async (t) => {
  const site = createServer((_, response) => {
    response.setHeader("content-type", "text/html");
    response.end("<!doctype html><title>Checkout</title><button>Pay now</button>");
  }).listen(0, "127.0.0.1");
  await once(site, "listening");
  t.after(() => site.close());
  const page = `http://127.0.0.1:${(site.address() as AddressInfo).port}/`;
  const { attach, mcp, workspace } = await setup(t, [
    "--browser-name",
    "chromium",
    "--browser-path",
    realBrowser as string,
  ]);
  const made = await attach("--access", "read", "--browser", "--workspace", workspace);
  const browser = await mcp(made.endpoints.browser as string, made.accessToken);
  const names = await browser.names();
  assert.ok(names.includes("browser_snapshot"));
  assert.ok(!names.includes("browser_run_code_unsafe"));
  assert.match(
    (await browser.call("browser_navigate", { url: page })).text,
    /- Page Title: Checkout/,
  );
  assert.match((await browser.call("browser_snapshot")).text, /button "Pay now"/);
});
