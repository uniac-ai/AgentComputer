// Computers as containers, for real. Needs Docker and the computer image, named by
// AGENTCOMPUTER_TEST_IMAGE; AGENTCOMPUTER_TEST_ROOT is a folder Docker can mount, if the temporary
// one isn't.
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
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { z } from "zod";
import { type Kind, make } from "./kinds.ts";

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

async function until(check: () => Promise<boolean>, what: string, ms = 30_000) {
  const deadline = Date.now() + ms;
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
  const start = async (env: Record<string, string> = {}, image = IMAGE as string) => {
    child = spawn(
      process.execPath,
      [
        CLI,
        "serve",
        "--listen",
        "127.0.0.1:0",
        "--data",
        data,
        "--image",
        image,
        "--screen-driver",
        "/nonexistent/cua-driver",
      ],
      { env: { ...environment(), ...env }, stdio: ["ignore", "pipe", "inherit"] },
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
  /** Stop it, do what is given to do while it is stopped, and start it again. */
  const restart = async (
    env?: Record<string, string>,
    image?: string,
    between: () => Promise<unknown> = async () => {},
  ) => {
    await stop();
    await between();
    await start(env, image);
    // What it brings back starts after it is up: wait until none is starting.
    await until(
      async () => (await Computer.list(to())).every((computer) => computer.state !== "starting"),
      "the computers brought back",
      120_000,
    );
  };
  return { Computer, to, root, data, workspace, mcp, restart, control: apiKey };
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

const docker = async (...args: string[]) => (await run("docker", args)).stdout.trim();
const running = async (id: string) =>
  (await docker("inspect", "--format", "{{.State.Running}}", `agentcomputer-${id}`)) === "true";
const Stopped = z.object({ stopped: z.number() });
const textOf = (result: unknown) =>
  (result as { content: { text?: string }[] }).content.map((block) => block.text ?? "").join("");

test(
  "a command has its own container, and of this machine's files only the workspace",
  options,
  async (t) => {
    const { Computer, to, root, workspace, mcp } = await setup(t);
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

    // What calls its tools ends a group of its commands together, in the container as outside.
    // The stop answers once they have ended, so their exit codes are there to read.
    const tools = await mcp(computer.getMcpUrl(), computer.getMcpToken());
    const sleep100 = { name: "exec_command", arguments: { cmd: "sleep 100", yield_time_ms: 250 } };
    await tools.callTool({ ...sleep100, _meta: { "agentexec/group": "a" } });
    await tools.callTool({ ...sleep100, arguments: { ...sleep100.arguments, cmd: "sleep 101" } });
    assert.deepEqual(
      await tools.request({ method: "agentexec/group/stop", params: { group: "a" } }, Stopped),
      { stopped: 1 },
    );
    const sessions = textOf(await tools.callTool({ name: "list_sessions", arguments: {} }));
    assert.match(sessions, /exit_code: 130\ncmd: sleep 100/);
    assert.match(sessions, /exit_code: running\ncmd: sleep 101/);
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
      ["Acting now", "CPU", "Memory", "Disk"],
    );
  },
);

test("what runs in a container refuses a malformed live address, and stays", options, async (t) => {
  const { Computer, to, workspace } = await setup(t);
  const computer = await Computer.create({ ...to(), access: "read", workspace });
  t.after(() => computer.close());
  // Its own port on this machine's loopback, which any process here can reach, with no token.
  const port = Number(
    await docker("port", `agentcomputer-${computer.computerID}`, "8000/tcp").then((line) =>
      line.split(":").pop(),
    ),
  );
  assert.equal(await upgrade(port, "http://["), "HTTP/1.1 401 Unauthorized");
  assert.equal(await running(computer.computerID), true);
  // And what is in it still answers.
  assert.ok(Array.isArray(await computer.files.list()));
});

test("read access is a read-only mount, and lists only its tools", options, async (t) => {
  const { Computer, to, workspace, mcp } = await setup(t);
  writeFileSync(join(workspace, "here.txt"), "for it");
  const computer = await Computer.create({ ...to(), access: "read", workspace });
  t.after(() => computer.close());
  assert.equal(await computer.files.read("here.txt"), "for it");
  const mounts = await docker(
    "inspect",
    "--format",
    '{{range .Mounts}}{{if eq .Destination "/workspace"}}{{.RW}}{{end}}{{end}}',
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

test("a workspace can start as a copy of a folder, which is left as it was", options, async (t) => {
  const { Computer, to, root, data } = await setup(t);
  const from = join(root, "old");
  mkdirSync(join(from, "notes"), { recursive: true });
  writeFileSync(join(from, "a.txt"), "a\n");
  writeFileSync(join(from, "notes", "b.txt"), "b\n");
  const computer = await Computer.create({ ...to(), access: "terminal", copyFrom: from });
  t.after(() => computer.close());
  const { workspace } = await computer.getInfo();
  assert.equal(workspace, join(data, "computers", computer.computerID, "workspace"));
  const sh = async (cmd: string) => (await computer.commands.run(cmd)).output;
  assert.equal(await sh("cat /workspace/a.txt /workspace/notes/b.txt"), "a\nb\n");
  await sh("echo changed > /workspace/a.txt && touch /workspace/new.txt");
  assert.equal(readFileSync(join(from, "a.txt"), "utf8"), "a\n");
  assert.equal(existsSync(join(from, "new.txt")), false);
  await computer.kill();
  assert.equal(existsSync(workspace as string), false);
  assert.equal(readFileSync(join(from, "notes", "b.txt"), "utf8"), "b\n");

  // A folder that can't be written is copied so, and the copy is still removed; a pipe is left
  // out; and a link to the folder is copied as the folder.
  chmodSync(join(from, "notes"), 0o555);
  await run("mkfifo", [join(from, "pipe")]);
  symlinkSync(from, join(root, "link"));
  const again = await Computer.create({ ...to(), access: "read", copyFrom: join(root, "link") });
  chmodSync(join(from, "notes"), 0o755);
  t.after(() => again.close());
  const copy = (await again.getInfo()).workspace as string;
  assert.deepEqual(readdirSync(copy).sort(), ["a.txt", "notes"]);
  assert.equal(statSync(join(copy, "notes")).mode & 0o777, 0o555);
  await again.kill();
  assert.equal(existsSync(copy), false);
});

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

/** This computer attached, or a container made, and how each then says and shows where it runs. */
function sideBySide({ Computer, to, workspace }: Awaited<ReturnType<typeof setup>>) {
  const container = async () => (await Computer.serviceInfo(to())).made[0];
  const made = async (kind: Kind) => {
    const computer = await make(Computer, kind, { ...to(), access: "terminal", workspace });
    return { id: computer.computerID, token: computer.getMcpToken() };
  };
  // Where its commands run shows it: in a container the folder is mounted at /workspace.
  const told = async ({ id, token }: { id: string; token: string }) => {
    const computer = await Computer.connect(id, { ...to(), accessToken: token });
    const { isolation, attached } = await computer.getInfo();
    return [isolation, attached, (await computer.commands.run("pwd")).output.trim()];
  };
  return { container, made, told };
}

test("this computer and a container side by side, each where it runs", options, async (t) => {
  const service = await setup(t);
  const { container, made, told } = sideBySide(service);
  assert.deepEqual(await container(), {
    isolation: "container",
    ready: true,
    capabilities: [
      { capability: "about", ready: true },
      { capability: "terminal", ready: true },
      { capability: "files", ready: true },
    ],
    browsers: [{ kind: "headless", ready: true }],
  });
  const inside = await made("container");
  const outside = await made("this");
  assert.deepEqual(await told(inside), ["container", false, "/workspace"]);
  assert.deepEqual(await told(outside), ["none", true, service.workspace]);
  await service.restart();
  assert.deepEqual(await told(inside), ["container", false, "/workspace"]);
  assert.deepEqual(await told(outside), ["none", true, service.workspace]);
});

test(
  "where Docker stops answering, a computer in a container is failed and kept, and this computer goes on",
  options,
  async (t) => {
    const service = await setup(t);
    const { Computer, to } = service;
    const { container, made, told } = sideBySide(service);
    const inside = await made("container");
    const outside = await made("this");
    await service.restart({ DOCKER_HOST: "unix:///nonexistent/docker.sock" });
    try {
      const needs = "A container needs Docker, which isn't answering on this machine.";
      const down = await container();
      assert.deepEqual([down?.ready, down?.reason], [false, needs]);
      assert.equal((await Computer.getInfo(inside.id, to())).state, "failed");
      const why = /A container needs Docker, which isn't answering on this machine\.$/;
      assert.match((await Computer.getLogs(inside.id, to())).at(-1)?.line ?? "", why);
      assert.deepEqual(await told(outside), ["none", true, service.workspace]);
      // Its container can't be removed now, so it isn't forgotten: it is refused, and kept.
      await assert.rejects(Computer.kill(inside.id, to()), why);
      assert.equal((await Computer.getInfo(inside.id, to())).state, "stopped");
      assert.equal(await running(inside.id), false);
    } finally {
      // With Docker back, whatever happened above, so that what was made can be removed.
      await service.restart();
    }
    await Computer.start(inside.id, to());
    assert.deepEqual(await told(inside), ["container", false, "/workspace"]);
  },
);

test(
  "after an update a computer is made again, keeping its home, and an old one's home is copied out",
  options,
  async (t) => {
    const { Computer, to, workspace, data, restart } = await setup(t);
    // Another image, as an update brings. It has no home of its own, so a container made the
    // old way from it has none to copy out.
    const other = "agentcomputer-remake:test";
    t.after(() => docker("rmi", other).catch(() => {}));
    await new Promise<void>((done, failed) => {
      const build = spawn("docker", ["build", "--quiet", "--tag", other, "-"], { stdio: "pipe" });
      build.once("exit", (code) => (code === 0 ? done() : failed(new Error(`build ${code}`))));
      build.stdin.end(`FROM ${IMAGE}\nUSER root\nRUN rm -rf /home/computer\nUSER 1000:1000\n`);
    });
    const made = await Computer.create({ ...to(), access: "terminal", workspace });
    const { computerID } = made;
    const name = `agentcomputer-${computerID}`;
    t.after(() => docker("rm", "--force", name).catch(() => {}));
    const idOf = (image: string) => docker("image", "inspect", "--format", "{{.Id}}", image);
    const imageOf = () => docker("inspect", "--format", "{{.Image}}", name);
    const home = join(data, "computers", computerID, "home");
    const sh = async (cmd: string) => {
      const computer = await Computer.connect(computerID, {
        ...to(),
        accessToken: made.getMcpToken(),
      });
      return (await computer.commands.run(cmd)).output;
    };
    const logs = async () => (await Computer.getLogs(computerID, to())).map((one) => one.line);
    await sh("echo kept > ~/kept && echo gone > /tmp/gone");
    assert.equal(readFileSync(join(home, "kept"), "utf8"), "kept\n");

    await t.test("started under another image, it is made again, with its home", async () => {
      await restart({}, other);
      assert.equal(await imageOf(), await idOf(other));
      assert.equal(await sh("cat ~/kept; ls /tmp/gone 2>/dev/null || echo none"), "kept\nnone\n");
      assert.ok(
        (await logs()).includes(
          `Its container was made from another image, so it is made again from ${other}.`,
        ),
      );
    });

    // A container made the old way, with its home inside it and no home mounted, put in the
    // computer's place while the service is stopped.
    const old = async (image: string, file?: string) => {
      await docker("rm", "--force", name);
      rmSync(home, { recursive: true, force: true });
      await docker(
        "create",
        "--name",
        name,
        "--label",
        `agentcomputer.computer=${computerID}`,
        image,
      );
      if (file) {
        writeFileSync(join(data, "old"), file);
        await docker("cp", join(data, "old"), `${name}:/home/computer/old`);
      }
    };
    // The paths mounted in the container, sorted: Docker lists mounts in no fixed order.
    const mounts = async () =>
      (await docker("inspect", "--format", "{{range .Mounts}}{{.Destination}} {{end}}", name))
        .split(" ")
        .filter(Boolean)
        .sort();

    await t.test("where its home can't be copied out, the old container is kept", async () => {
      await restart({}, IMAGE, () => old(other));
      assert.equal(await imageOf(), await idOf(other));
      assert.deepEqual(await mounts(), []);
      assert.equal(existsSync(home), false);
      assert.ok(
        (await logs()).some((line) =>
          line.startsWith("Its home couldn't be copied out of its container ("),
        ),
      );
    });

    await t.test("where it can, its home is copied out, and it is made again", async () => {
      // A home left by an earlier try is not in its way: the container's is the one kept.
      await restart({}, other, async () => {
        await old(IMAGE as string, "from the old home\n");
        mkdirSync(home);
        writeFileSync(join(home, "earlier"), "");
      });
      assert.equal(existsSync(join(home, "earlier")), false);
      assert.equal(await imageOf(), await idOf(other));
      assert.deepEqual(await mounts(), ["/home/computer", "/workspace"]);
      assert.equal(await sh("cat ~/old"), "from the old home\n");
      assert.ok((await logs()).includes("Its home was copied out of its container, to keep."));
      // Started again under the same image, it is the same container.
      const container = await docker("inspect", "--format", "{{.Id}}", name);
      await Computer.stop(computerID, to());
      await Computer.start(computerID, to());
      assert.equal(await docker("inspect", "--format", "{{.Id}}", name), container);
    });
  },
);
