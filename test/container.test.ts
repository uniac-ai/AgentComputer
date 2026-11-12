// Computers as containers, for real. Needs Docker and the computer image, named by
// AGENTCOMPUTER_TEST_IMAGE; AGENTCOMPUTER_TEST_ROOT is a folder Docker can mount, if the temporary
// one isn't.
import assert from "node:assert/strict";
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

type Sdk = typeof import("../src/sdk.ts");
const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "..", "dist");
const CLI = join(dist, "agentcomputer.js");
const IMAGE = process.env.AGENTCOMPUTER_TEST_IMAGE;
const run = promisify(execFile);
const options = { skip: !IMAGE, timeout: 180_000 };

const environment = () => ({
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? "",
  ...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}),
});

async function until(check: () => Promise<boolean>, what: string) {
  const deadline = Date.now() + 30_000;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, `Waited too long for ${what}.`);
    await new Promise((done) => setTimeout(done, 200));
  }
}

async function setup(t: test.TestContext) {
  const root = realpathSync(
    mkdtempSync(join(process.env.AGENTCOMPUTER_TEST_ROOT ?? tmpdir(), "ac-")),
  );
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
        "--isolation",
        "container",
        "--image",
        IMAGE as string,
      ],
      { env: environment(), stdio: ["ignore", "pipe", "inherit"] },
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
  const { Computer } = (await import(pathToFileURL(join(dist, "sdk.js")).href)) as Sdk;
  const apiKey = readFileSync(join(data, "control-token"), "utf8").trim();
  const to = () => ({ apiUrl: url, apiKey });
  const clients: Client[] = [];
  t.after(async () => {
    for (const client of clients) await client.close().catch(() => {});
    for (const computer of await Computer.list(to()).catch(() => []))
      await Computer.kill(computer.computerID, to()).catch(() => {});
    await stop();
    rmSync(root, { recursive: true, force: true });
  });
  const mcp = async (endpoint: string, token: string) => {
    const client = new Client({ name: "by-hand", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(endpoint), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    );
    clients.push(client);
    return client;
  };
  const restart = async () => {
    await stop();
    await start();
  };
  return { Computer, to, root, data, workspace, mcp, restart, control: apiKey };
}

const docker = async (...args: string[]) => (await run("docker", args)).stdout.trim();
const running = async (id: string) =>
  (await docker("inspect", "--format", "{{.State.Running}}", `agentcomputer-${id}`)) === "true";
const textOf = (result: unknown) =>
  (result as { content: { text?: string }[] }).content.map((block) => block.text ?? "").join("");

test(
  "a command has its own container, and of this machine's files only the workspace",
  options,
  async (t) => {
    const { Computer, to, root, workspace } = await setup(t);
    writeFileSync(join(root, "secret.txt"), "not for it");
    writeFileSync(join(workspace, "here.txt"), "for it");
    const computer = await Computer.create({ ...to(), access: "terminal", workspace });
    t.after(() => computer.close());
    const sh = async (cmd: string) => computer.commands.run(cmd);

    assert.equal((await sh("pwd")).output.trim(), "/workspace");
    assert.equal((await sh("cat here.txt")).output, "for it");
    assert.notEqual((await sh(`cat ${root}/secret.txt`)).exitCode, 0);
    assert.equal((await sh("printenv AGENTCOMPUTER_INNER_TOKEN")).exitCode, 1);
    assert.match((await sh("grep CapEff /proc/self/status")).output, /CapEff:\s+0{16}/);
    assert.equal((await sh("id -u")).output.trim(), String(process.getuid?.()));
    assert.equal(
      (await sh("touch ~/.npm-can-write && mkdir -p ~/.npm && touch ~/.npm/x")).exitCode,
      0,
    );

    await sh("echo made > made.txt");
    assert.equal(readFileSync(join(workspace, "made.txt"), "utf8"), "made\n");
  },
);

test(
  "about tells its agent what a person outside reads, and where the folder is inside",
  options,
  async (t) => {
    const { Computer, to, workspace, mcp } = await setup(t);
    const computer = await Computer.create({ ...to(), access: "read", workspace });
    t.after(() => computer.close());
    const client = await mcp(computer.getMcpUrl(), computer.getMcpToken());
    const told = await client.callTool({ name: "about", arguments: {} });
    const { rows } = JSON.parse(textOf(told)) as { rows: { label: string }[] };
    assert.deepEqual(rows.slice(0, 4), [
      { label: "Where", value: hostname() },
      { label: "Folder", value: `${workspace} on the machine, mounted at /workspace in it` },
      { label: "Reaches", value: "Read-only files" },
      { label: "Isolation", value: "A container of its own" },
    ]);
    assert.deepEqual(
      rows.slice(4).map((row) => row.label),
      ["CPU", "Memory", "Disk"],
    );
  },
);

test("read access is a read-only mount, and lists only its tools", options, async (t) => {
  const { Computer, to, workspace, mcp } = await setup(t);
  writeFileSync(join(workspace, "here.txt"), "for it");
  const computer = await Computer.create({ ...to(), access: "read", workspace });
  t.after(() => computer.close());
  assert.equal(await computer.files.read("here.txt"), "for it");
  const mounts = await docker(
    "inspect",
    "--format",
    "{{(index .Mounts 0).RW}}",
    `agentcomputer-${computer.computerID}`,
  );
  assert.equal(mounts, "false");
  const client = await mcp(computer.getMcpUrl(), computer.getMcpToken());
  assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name).sort(), [
    "about",
    "list",
    "read",
    "search",
  ]);
});

test(
  "its browser ships in the image, and the tool that runs code is hidden below terminal",
  options,
  async (t) => {
    const { Computer, to, workspace, mcp } = await setup(t);
    writeFileSync(
      join(workspace, "index.html"),
      "<!doctype html><title>Checkout</title><button>Pay now</button>",
    );
    const full = await Computer.create({ ...to(), access: "terminal", browser: true, workspace });
    t.after(() => full.close());
    const server = await full.commands.run("python3 -m http.server 9000 --bind 127.0.0.1", {
      background: true,
    });
    assert.ok("sessionId" in server);
    const browser = await mcp(full.getMcpUrl("browser"), full.getMcpToken());
    const names = (await browser.listTools()).tools.map((tool) => tool.name);
    assert.ok(names.includes("browser_run_code_unsafe"));
    const opened = await browser.callTool({
      name: "browser_navigate",
      arguments: { url: "http://127.0.0.1:9000/" },
    });
    assert.match(textOf(opened), /- Page Title: Checkout/);
    assert.match(
      textOf(await browser.callTool({ name: "browser_snapshot", arguments: {} })),
      /button "Pay now"/,
    );
    // Its screenshot is a picture, and so is that picture read from its folder.
    const picturesOf = (result: unknown) =>
      (result as { content: { type: string; mimeType?: string; data?: string }[] }).content.filter(
        (block) => block.type === "image",
      );
    const [shot] = picturesOf(
      await browser.callTool({ name: "browser_take_screenshot", arguments: {} }),
    );
    assert.equal(shot?.mimeType, "image/png");
    writeFileSync(join(workspace, "shot"), Buffer.from(shot?.data ?? "", "base64"));
    const computer = await mcp(full.getMcpUrl(), full.getMcpToken());
    const read = await computer.callTool({ name: "read", arguments: { path: "shot" } });
    assert.equal(textOf(read), "shot: image/png");
    assert.deepEqual(picturesOf(read), [shot]);

    const below = await Computer.create({ ...to(), access: "files", browser: true, workspace });
    t.after(() => below.close());
    const limited = await mcp(below.getMcpUrl("browser"), below.getMcpToken());
    assert.ok(
      !(await limited.listTools()).tools.some((tool) => tool.name === "browser_run_code_unsafe"),
    );
    await assert.rejects(
      limited.callTool({ name: "browser_run_code_unsafe", arguments: {} }),
      /Unknown tool/,
    );

    const only = await Computer.create({ ...to(), access: "none", browser: true });
    const alone = await mcp(only.getMcpUrl("browser"), only.getMcpToken());
    assert.ok((await alone.listTools()).tools.some((tool) => tool.name === "browser_navigate"));
  },
);

test(
  "stop keeps its disk and token, start brings it back, and kill removes it all",
  options,
  async (t) => {
    const { Computer, to, data } = await setup(t);
    const computer = await Computer.create({ ...to(), access: "terminal" });
    t.after(() => computer.close());
    const id = computer.computerID;
    const { workspace } = await computer.getInfo();
    assert.ok(workspace?.startsWith(data));
    await computer.commands.run("echo kept > ~/kept");

    await computer.stop();
    assert.equal(await running(id), false);
    const refused = await fetch(computer.getMcpUrl(), {
      method: "POST",
      headers: { Authorization: `Bearer ${computer.getMcpToken()}` },
      body: "{}",
    });
    assert.equal(refused.status, 409);

    await computer.start();
    assert.equal(await running(id), true);
    assert.equal((await computer.commands.run("cat ~/kept")).output, "kept\n");

    await computer.kill();
    await assert.rejects(running(id));
    assert.equal(existsSync(workspace as string), false);
  },
);

test("a computer that reaches its timeout has its container stopped", options, async (t) => {
  const { Computer, to } = await setup(t);
  const computer = await Computer.create({ ...to(), access: "read", timeoutMs: 1000 });
  await until(async () => !(await computer.isRunning()), "its timeout");
  await until(async () => !(await running(computer.computerID)), "its container to stop");
});

test(
  "a container that ends by itself shows as failed, and stop and start recover it",
  options,
  async (t) => {
    const { Computer, to } = await setup(t);
    const computer = await Computer.create({ ...to(), access: "terminal" });
    t.after(() => computer.close());
    await docker("kill", `agentcomputer-${computer.computerID}`);
    await until(async () => (await computer.getInfo()).state === "failed", "it to show as failed");
    await computer.stop();
    await computer.close();
    await computer.start();
    assert.equal((await computer.commands.run("echo back")).output, "back\n");
  },
);

test(
  "its port is on loopback and takes neither the computer's token nor the control token",
  options,
  async (t) => {
    const { Computer, to, control } = await setup(t);
    const computer = await Computer.create({ ...to(), access: "read" });
    const ports = JSON.parse(
      await docker(
        "inspect",
        "--format",
        "{{json .NetworkSettings.Ports}}",
        `agentcomputer-${computer.computerID}`,
      ),
    ) as Record<string, { HostIp: string; HostPort: string }[]>;
    const binding = ports["8000/tcp"]?.[0] as { HostIp: string; HostPort: string };
    assert.equal(binding.HostIp, "127.0.0.1");
    const inner = `http://127.0.0.1:${binding.HostPort}/ready`;
    assert.equal((await fetch(inner)).status, 401);
    for (const token of [computer.getMcpToken(), control])
      assert.equal(
        (await fetch(inner, { headers: { Authorization: `Bearer ${token}` } })).status,
        401,
      );
  },
);

test("computers stop with the service and come back with their tokens", options, async (t) => {
  const { Computer, to, restart } = await setup(t);
  const computer = await Computer.create({ ...to(), access: "terminal" });
  const { computerID } = computer;
  const accessToken = computer.getMcpToken();
  await computer.close();
  await restart();
  assert.equal(await running(computerID), true);
  const again = await Computer.connect(computerID, { ...to(), accessToken });
  t.after(() => again.close());
  assert.equal((await again.commands.run("echo back")).output, "back\n");
});

test("serve says so when Docker doesn't answer", options, async (t) => {
  const data = mkdtempSync(join(tmpdir(), "agentcomputer-"));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  await assert.rejects(
    run(process.execPath, [CLI, "serve", "--isolation", "container", "--data", data], {
      env: { ...environment(), DOCKER_HOST: "unix:///nonexistent/docker.sock" },
    }),
    (error: Error & { stderr: string }) => /needs Docker/.test(error.stderr),
  );
});
