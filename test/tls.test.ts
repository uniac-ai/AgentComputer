// The service beyond loopback. Each client is a process of its own, trusting a test certificate
// the way a person would: through NODE_EXTRA_CA_CERTS.
import assert from "node:assert/strict";
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "..", "..", "dist", "agentcomputer.js");
const CLIENT = join(here, "..", "..", "test", "fixtures", "tls-client.js");
const SERVICE_IMAGE = process.env.AGENTCOMPUTER_TEST_SERVICE_IMAGE;
const COMPUTER_IMAGE = process.env.AGENTCOMPUTER_TEST_IMAGE;
const run = promisify(execFile);

const outward = Object.values(networkInterfaces())
  .flat()
  .find((address) => address?.family === "IPv4" && !address.internal)?.address;

function folders(t: test.TestContext) {
  const root = realpathSync(
    mkdtempSync(join(process.env.AGENTCOMPUTER_TEST_ROOT ?? tmpdir(), "ac-")),
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, data: join(root, "data") };
}

async function certificate(root: string, ...names: string[]) {
  const cert = join(root, "cert.pem");
  const key = join(root, "key.pem");
  await run("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "1",
    "-subj",
    "/CN=agentcomputer-test",
    "-addext",
    `subjectAltName=${names.join(",")}`,
    "-keyout",
    key,
    "-out",
    cert,
  ]);
  return { cert, key };
}

async function serve(t: test.TestContext, data: string, ...args: string[]) {
  const child: ChildProcess = spawn(process.execPath, [CLI, "serve", "--data", data, ...args], {
    env: { PATH: process.env.PATH ?? "", HOME: data, SHELL: "/bin/bash" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    child.removeAllListeners("exit");
    const gone = once(child, "exit");
    child.kill("SIGTERM");
    await gone;
  };
  t.after(stop);
  const url = await new Promise<string>((done, failed) => {
    child.once("exit", (code) => failed(new Error(`The service exited ${code}.`)));
    createInterface({ input: child.stdout as NodeJS.ReadableStream }).on("line", (line) => {
      const found = /^AgentComputer on (\S+),/.exec(line);
      if (found) done(found[1] as string);
    });
  });
  return { url, token: readFileSync(join(data, "control-token"), "utf8").trim(), stop };
}

/** Why a service that other machines can reach doesn't offer this computer. */
const NOT_HERE =
  "This service can be reached from other machines, so it doesn't offer the machine it runs on. A service that listens on loopback, with no proxy in front, does.";

/** The service's API in the clear, at the address it listens on, with its control token. */
const clear =
  (address: string, token: string) =>
  (path: string, body?: object, method = body ? "POST" : "GET") =>
    fetch(`http://${address}/v1${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

/** Attach this computer with `workspace`, or with none make one in a container, and use it. */
async function across(url: string, token: string, ca: string, workspace?: string) {
  const { stdout } = await run(
    process.execPath,
    [CLIENT, url, token, "terminal", ...(workspace ? [workspace] : [])],
    {
      env: { PATH: process.env.PATH ?? "", NODE_EXTRA_CA_CERTS: ca },
    },
  );
  return JSON.parse(stdout) as { output: string; endpoint: string };
}

async function freePort() {
  const probe = createServer().listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address() as { port: number };
  probe.close();
  await once(probe, "close");
  return port;
}

test("over TLS on loopback, a client makes and uses a computer", async (t) => {
  const { root, data } = folders(t);
  const { cert, key } = await certificate(root, "IP:127.0.0.1");
  const { url, token } = await serve(
    t,
    data,
    "--listen",
    "127.0.0.1:0",
    "--tls-cert",
    cert,
    "--tls-key",
    key,
  );
  assert.match(url, /^https:/);
  const answer = await across(url, token, cert, root);
  assert.equal(answer.output, "across\n");
  assert.ok(answer.endpoint.startsWith(`${url}/v1/computers/`));
  await assert.rejects(fetch(`${url.replace("https:", "http:")}/openapi.json`));
});

test("a client that doesn't trust the certificate is refused", async (t) => {
  const { root, data } = folders(t);
  const { cert, key } = await certificate(root, "IP:127.0.0.1");
  const { url } = await serve(
    t,
    data,
    "--listen",
    "127.0.0.1:0",
    "--tls-cert",
    cert,
    "--tls-key",
    key,
  );
  await assert.rejects(fetch(`${url}/openapi.json`));
});

test("on an address other machines can reach, over TLS, a computer is made in a container", {
  skip:
    (!outward && "needs an address other machines can reach") ||
    (!COMPUTER_IMAGE && "needs AGENTCOMPUTER_TEST_IMAGE"),
  timeout: 120_000,
}, async (t) => {
  const { root, data } = folders(t);
  const { cert, key } = await certificate(root, `IP:${outward}`);
  const { url, token } = await serve(
    t,
    data,
    "--listen",
    `${outward}:0`,
    "--tls-cert",
    cert,
    "--tls-key",
    key,
    "--image",
    COMPUTER_IMAGE as string,
  );
  assert.equal(new URL(url).hostname, outward);
  assert.equal((await across(url, token, cert)).output, "across\n");
});

test("behind a proxy it listens in the clear and gives out the public address", {
  skip: !COMPUTER_IMAGE && "needs AGENTCOMPUTER_TEST_IMAGE",
  timeout: 120_000,
}, async (t) => {
  const { data } = folders(t);
  const host = outward ?? "127.0.0.1";
  const port = await freePort();
  const { url, token } = await serve(
    t,
    data,
    "--listen",
    `${host}:${port}`,
    "--tls-proxy",
    "--public-url",
    "https://computers.example.com/",
    "--image",
    COMPUTER_IMAGE as string,
  );
  assert.equal(url, "https://computers.example.com");
  const api = clear(`${host}:${port}`, token);
  const made = await api("/computers", { access: "read" });
  assert.equal(made.status, 201);
  const { computerID, endpoints } = (await made.json()) as {
    computerID: string;
    endpoints: { computer: string };
  };
  assert.equal((await api(`/computers/${computerID}`, undefined, "DELETE")).status, 204);
  assert.ok(endpoints.computer.startsWith("https://computers.example.com/v1/computers/"));
});

test("a service other machines can reach doesn't offer this computer, even one attached before", async (t) => {
  const { root, data } = folders(t);
  // On loopback this computer is attached, as on a person's own machine.
  const port = await freePort();
  const first = await serve(t, data, "--listen", `127.0.0.1:${port}`);
  const attached = await clear(`127.0.0.1:${port}`, first.token)("/computers/attach", {
    access: "read",
    workspace: root,
  });
  assert.equal(attached.status, 201);
  const { computerID } = (await attached.json()) as { computerID: string };
  await first.stop();
  // Started again behind a proxy, which other machines reach through, it is a server.
  const { token } = await serve(
    t,
    data,
    "--listen",
    `127.0.0.1:${port}`,
    "--tls-proxy",
    "--public-url",
    "https://computers.example.com/",
  );
  const api = clear(`127.0.0.1:${port}`, token);
  const { thisComputer } = (await (await api("/info")).json()) as {
    thisComputer: { ready: boolean; reason?: string };
  };
  assert.deepEqual([thisComputer.ready, thisComputer.reason], [false, NOT_HERE]);
  const refused = await api("/computers/attach", { access: "read", workspace: root });
  assert.deepEqual([refused.status, await refused.json()], [409, { code: 409, message: NOT_HERE }]);
  const before = (await (await api(`/computers/${computerID}`)).json()) as { state: string };
  assert.equal(before.state, "failed");
  await api(`/computers/${computerID}/stop`, {});
  const start = await api(`/computers/${computerID}/start`, {});
  assert.deepEqual([start.status, await start.json()], [409, { code: 409, message: NOT_HERE }]);
});

for (const [why, reason, args] of [
  ["a certificate without a key", /go together/, ["--tls-cert", "x"]],
  ["a key without a certificate", /go together/, ["--tls-key", "x"]],
  ["both ways of doing TLS", /alternatives/, ["--tls-cert", "x", "--tls-key", "y", "--tls-proxy"]],
  [
    "a proxy with no public address",
    /needs --public-url/,
    ["--tls-proxy", "--listen", "10.0.0.1:0"],
  ],
  [
    "a wildcard with no public address",
    /needs --public-url/,
    ["--tls-cert", "x", "--tls-key", "y", "--listen", "0.0.0.0:0"],
  ],
  [
    "a public address in the clear beyond loopback",
    /has to be https/,
    ["--tls-proxy", "--listen", "10.0.0.1:0", "--public-url", "http://example.com"],
  ],
  [
    "a certificate that isn't there",
    /ENOENT/,
    ["--tls-cert", "/nonexistent", "--tls-key", "/nonexistent"],
  ],
] as const)
  test(`serve refuses ${why}`, async (t) => {
    const { data } = folders(t);
    await assert.rejects(
      run(process.execPath, [CLI, "serve", "--data", data, ...args]),
      (error: Error & { stderr: string }) => reason.test(error.stderr),
    );
    assert.equal(existsSync(join(data, "server.json")), false);
  });

test("the service's image, with the machine's Docker, serves a computer across TLS", {
  skip: !SERVICE_IMAGE || !COMPUTER_IMAGE,
  timeout: 180_000,
}, async (t) => {
  const { root, data } = folders(t);
  const { cert, key } = await certificate(root, "DNS:localhost");
  const port = await freePort();
  const name = `agentcomputer-test-${port}`;
  const socket = "/var/run/docker.sock:/var/run/docker.sock";
  const group = (
    await run("docker", [
      "run",
      "--rm",
      "-v",
      socket,
      "--entrypoint",
      "stat",
      SERVICE_IMAGE as string,
      "-c",
      "%g",
      "/var/run/docker.sock",
    ])
  ).stdout.trim();
  await run("docker", [
    "run",
    "--detach",
    "--name",
    name,
    "--network",
    "host",
    "--user",
    `${process.getuid?.()}:${process.getgid?.()}`,
    "--group-add",
    group,
    "-v",
    socket,
    "-v",
    `${root}:${root}`,
    SERVICE_IMAGE as string,
    "serve",
    "--image",
    COMPUTER_IMAGE as string,
    "--data",
    data,
    "--listen",
    `0.0.0.0:${port}`,
    "--tls-cert",
    cert,
    "--tls-key",
    key,
    "--public-url",
    `https://localhost:${port}`,
  ]);
  t.after(async () => {
    await run("docker", ["rm", "--force", name]).catch(() => {});
  });
  const tokenFile = join(data, "control-token");
  const deadline = Date.now() + 30_000;
  while (!existsSync(join(data, "server.json"))) {
    if (Date.now() > deadline) {
      const logs = await run("docker", ["logs", name]);
      assert.fail(`It didn't start: ${logs.stdout}${logs.stderr}`);
    }
    await new Promise((done) => setTimeout(done, 200));
  }
  const answer = await across(
    `https://localhost:${port}`,
    readFileSync(tokenFile, "utf8").trim(),
    cert,
  );
  assert.equal(answer.output, "across\n");
  assert.ok(answer.endpoint.startsWith(`https://localhost:${port}/v1/computers/`));
});
