// Run inside the screen test image, with the built service mounted at /repo: a service that only
// lends this machine, whose Cua Driver is the pinned one behind a thin proxy (driver-proxy.mjs). The
// proxy refuses one click in the background before sending anything, as a Mac's driver does for an
// app that reads the real pointer, and answers another as failed after it may have been sent. It
// prints what the agent was told, where the real pointer was around each, and the driver's calls.
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
/** Until `check` holds, for at most 10 s; `what` names it. */
async function until(check, what) {
  for (const deadline = Date.now() + 10_000; Date.now() < deadline; await sleep(50))
    if (await check()) return;
  throw new Error(`Waited too long for ${what}.`);
}

const children = [];
const start = (command, args) => {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "inherit"] });
  children.push(child);
  return child;
};
const out = {};
try {
  start("Xvfb", [":99", "-screen", "0", "1920x1200x24"]);
  await until(() => existsSync("/tmp/.X11-unix/X99"), "the display");
  start("openbox", ["--startup", "touch /tmp/wm-ready"]);
  await until(() => existsSync("/tmp/wm-ready"), "the window manager");
  start("xterm", ["-T", "screen-test", "-geometry", "80x20+40+40"]);

  // The driver the service is given: the proxy for `mcp`, the pinned driver for anything else.
  mkdirSync("/tmp/proxy");
  const program = "/tmp/proxy/cua-driver";
  writeFileSync(
    program,
    `#!/bin/sh\nif [ "$1" = mcp ]; then exec "${process.execPath}" /repo/test/fixtures/driver-proxy.mjs; fi\nexec cua-driver "$@"\n`,
  );
  chmodSync(program, 0o755);
  const data = mkdtempSync(join(tmpdir(), "ac-"));
  const workspace = mkdtempSync(join(tmpdir(), "ws-"));
  const service = start(process.execPath, [
    "/repo/dist/agentcomputer.js",
    "serve",
    "--lend",
    "--listen",
    "127.0.0.1:0",
    "--data",
    data,
    "--screen-driver",
    program,
  ]);
  const url = await new Promise((done, failed) => {
    service.once("exit", (code) => failed(new Error(`The service exited ${code}.`)));
    createInterface({ input: service.stdout }).on("line", (line) => {
      const found = /^AgentComputer on (\S+),/.exec(line);
      if (found) done(found[1]);
    });
  });
  const { Computer } = await import("/repo/dist/sdk.js");
  const to = { apiUrl: url, apiKey: readFileSync(join(data, "control-token"), "utf8").trim() };
  // A lent machine starts with each part switched off, for the person to switch on.
  await fetch(`${url}/v1/setup/screen`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${to.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ on: true }),
  });
  await until(
    async () =>
      (await Computer.serviceInfo(to)).thisComputer.capabilities.find(
        (one) => one.capability === "screen",
      )?.ready,
    "the screen, ready",
  );
  const computer = await Computer.attach({ ...to, access: "read", workspace, screen: true });
  const info = await computer.getInfo();
  const client = new Client({ name: "screen-put-back", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(info.endpoints.screen), {
      requestInit: { headers: { Authorization: `Bearer ${computer.getMcpToken()}` } },
    }),
  );
  const call = async (name, args = {}) => {
    const { content, isError, structuredContent } = await client.callTool({
      name,
      arguments: args,
    });
    return {
      isError: !!isError,
      structured: structuredContent,
      text: content
        .filter((one) => one.type === "text")
        .map((one) => one.text)
        .join("\n"),
    };
  };
  const listed = /window_id=(\d+) pid=(\d+) "screen-test"/;
  let apps;
  await until(async () => {
    apps = await call("apps");
    return listed.test(apps.text);
  }, "the terminal's window");
  const [, windowId, pid] = listed.exec(apps.text) ?? [];
  const term = { pid: Number(pid), window_id: Number(windowId) };
  // The agent sees the whole screen, in a picture half its size, then the window, so that a
  // point in its picture can be aimed at.
  out.desktop = (await call("see")).structured;
  await call("see", term);

  // Where the real pointer is, read on a connection of the test's own.
  const driver = new Client({ name: "pointer", version: "1" });
  await driver.connect(
    new StdioClientTransport({
      command: "cua-driver",
      args: ["mcp"],
      env: { ...process.env },
      stderr: "ignore",
    }),
  );
  const pointer = async () => {
    const { x, y } = (await driver.callTool({ name: "get_cursor_position", arguments: {} }))
      .structuredContent;
    return { x, y };
  };
  out.before = await pointer();
  out.refused = await call("act", { action: "click", ...term, x: 77, y: 33 });
  out.after = await pointer();
  out.failedAfter = await call("act", { action: "click", ...term, x: 78, y: 33 });
  out.afterFailed = await pointer();
  await driver.close();
  out.calls = readFileSync("/tmp/proxy/calls.jsonl", "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter((one) =>
      ["click", "answered", "move_cursor", "get_cursor_position"].includes(one.name),
    );
  out.logs = (await computer.getLogs())
    .map((one) => one.line)
    .filter((line) => /foreground/.test(line));
  await client.close();
  await computer.kill();
} catch (error) {
  out.error = error instanceof Error ? error.stack : String(error);
} finally {
  for (const child of children.reverse()) child.kill("SIGTERM");
  await sleep(200);
  process.stdout.write(`${JSON.stringify(out)}\n`);
  process.exit(0);
}
