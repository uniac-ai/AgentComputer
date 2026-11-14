// Run inside the screen test image, with the built service mounted at /repo: a virtual display with
// a terminal window, the service on loopback, and this computer attached with the screen. It
// prints what each step answered, as JSON, for the test outside to judge.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(check, what) {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await sleep(50);
  }
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
  start("Xvfb", [":99", "-screen", "0", "1280x800x24"]);
  await until(() => existsSync("/tmp/.X11-unix/X99"), "the display");
  // A window manager, which makes a window active as foreground delivery needs.
  start("openbox", []);
  await sleep(500);
  start("xterm", ["-T", "screen-test", "-geometry", "80x20+40+40"]);

  const data = mkdtempSync(join(tmpdir(), "ac-"));
  const workspace = mkdtempSync(join(tmpdir(), "ws-"));
  const service = start(process.execPath, [
    "/repo/dist/agentcomputer.js",
    "serve",
    "--listen",
    "127.0.0.1:0",
    "--data",
    data,
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
  out.screenOffered = (await Computer.serviceInfo(to)).thisComputer.capabilities.find(
    (one) => one.capability === "screen",
  );
  const computer = await Computer.attach({
    ...to,
    access: "read",
    workspace,
    name: "Scout",
    screen: true,
  });
  const info = await computer.getInfo();
  out.attached = { screen: info.screen, endpoint: info.endpoints.screen, tools: info.tools.screen };

  const client = new Client({ name: "screen-run", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(info.endpoints.screen), {
      requestInit: { headers: { Authorization: `Bearer ${computer.getMcpToken()}` } },
    }),
  );
  const call = async (name, args = {}) => {
    try {
      const { content, isError } = await client.callTool({ name, arguments: args });
      return {
        isError: !!isError,
        kinds: content.map((one) => one.type),
        text: content
          .filter((one) => one.type === "text")
          .map((one) => one.text)
          .join("\n"),
      };
    } catch (error) {
      // Input the tool's schema refuses comes back as a protocol error.
      return {
        isError: true,
        kinds: [],
        text: error instanceof Error ? error.message : String(error),
      };
    }
  };
  out.tools = (await client.listTools()).tools.map((one) => one.name).sort();
  out.see = await call("see");
  out.apps = await call("apps");
  const [, windowId, pid] = /window_id=(\d+) pid=(\d+) "screen-test"/.exec(out.apps.text) ?? [];
  const term = { pid: Number(pid), window_id: Number(windowId) };
  // The terminal window: typing into it in the background is refused here, where nothing can
  // deliver keys without the focus; in the foreground it is typed, and enter runs it.
  const command = { action: "type", ...term, text: "echo screen-ok > /tmp/screen-ok" };
  out.background = await call("act", command);
  out.typed = await call("act", { ...command, delivery_mode: "foreground" });
  out.pressed = await call("act", {
    action: "key",
    ...term,
    key: "enter",
    delivery_mode: "foreground",
  });
  await until(() => existsSync("/tmp/screen-ok"), "the command typed on the screen");
  out.ran = readFileSync("/tmp/screen-ok", "utf8");
  out.window = await call("see", term);
  // What act refuses before the driver is asked: a key it doesn't know, keys with nowhere to go.
  out.unknownKey = await call("act", { action: "click", element: "s0:0" });
  out.noTarget = await call("act", { action: "type", text: "x" });
  out.halfWindow = await call("act", { action: "click", pid: term.pid, x: 5, y: 5 });
  // The rest of what act does, in the foreground as this display needs, and bringing it forward.
  const fore = { ...term, delivery_mode: "foreground" };
  out.click = await call("act", { action: "click", ...fore, x: 20, y: 20 });
  out.double = await call("act", { action: "double_click", ...fore, x: 20, y: 20 });
  out.right = await call("act", { action: "right_click", ...fore, x: 20, y: 20 });
  await call("act", { action: "key", ...fore, key: "escape" });
  out.scroll = await call("act", { action: "scroll", ...fore, x: 20, y: 20, direction: "down" });
  out.hotkey = await call("act", { action: "hotkey", ...fore, keys: ["ctrl", "l"] });
  out.drag = await call("act", { action: "drag", ...fore, x: 20, y: 20, to_x: 60, to_y: 40 });
  out.front = await call("apps", term);
  // Another computer attached to the machine, without the screen, sees the agent on it.
  const other = await Computer.attach({ ...to, access: "read", workspace, name: "Helper" });
  const otherInfo = await other.getInfo();
  out.other = { screen: otherInfo.screen, endpoint: otherInfo.endpoints.screen };
  const about = async (one) => {
    const agent = new Client({ name: "about", version: "1" });
    await agent.connect(
      new StreamableHTTPClientTransport(new URL((await one.getInfo()).endpoints.computer), {
        requestInit: { headers: { Authorization: `Bearer ${one.getMcpToken()}` } },
      }),
    );
    const { content } = await agent.callTool({ name: "about", arguments: {} });
    await agent.close();
    return JSON.parse(content[0].text).rows.filter((row) => /Reaches|Acting now/.test(row.label));
  };
  out.about = await about(computer);
  out.otherAbout = await about(other);
  await client.close();
  await computer.kill();
  await other.kill();
} catch (error) {
  out.error = error instanceof Error ? error.stack : String(error);
} finally {
  for (const child of children.reverse()) child.kill("SIGTERM");
  await sleep(200);
  process.stdout.write(`${JSON.stringify(out)}\n`);
  process.exit(0);
}
