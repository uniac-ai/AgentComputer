// `agentcomputer`: run the service, or ask a running one to do something.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { isMainThread } from "node:worker_threads";
import { ContainerRuntime } from "./container.ts";
import { VERSION } from "./handlers.ts";
import { serveInside } from "./inside.ts";
import { ProcessRuntime } from "./runtime.ts";
import { Computer, type CreateOpts } from "./sdk.ts";
import { serve } from "./service.ts";

const USAGE = `Usage: agentcomputer <command> [--data DIR]

  serve [--listen HOST:PORT] [--isolation none|container] [--image IMAGE]
        [--browser-name NAME] [--browser-path PATH]
                                    run the service; 127.0.0.1:7878 by default
  info                              the service's version and isolation
  create --access none|read|files|terminal [--browser] [--workspace DIR] [--name NAME]
         [--timeout SECONDS] [--metadata KEY=VALUE]...
                                    make a computer; prints its endpoints and token, once
  list [--state running|stopped|failed]
                                    the computers
  get <id>                          one computer
  timeout <id> <seconds>            it now stops this long from now
  stop <id>                         stop it, keeping its folder and token
  start <id> [--timeout SECONDS]    start a stopped computer again
  logs <id>                         what its servers wrote
  kill <id>                         stop it and remove what the service made

The data folder is --data, else $AGENTCOMPUTER_DATA, else $XDG_DATA_HOME/agentcomputer, else
~/.local/share/agentcomputer. Commands find the running service there, with its control token.
`;

const IMAGE = "ghcr.io/uniac-ai/agentcomputer/computer";

class UsageError extends Error {}

function dataFolder(given?: string) {
  const xdg = process.env.XDG_DATA_HOME;
  return resolve(
    given ??
      process.env.AGENTCOMPUTER_DATA ??
      (xdg && isAbsolute(xdg)
        ? join(xdg, "agentcomputer")
        : join(homedir(), ".local", "share", "agentcomputer")),
  );
}

function connectionTo(data: string) {
  try {
    const { url } = JSON.parse(readFileSync(join(data, "server.json"), "utf8")) as { url: string };
    return { apiUrl: url, apiKey: readFileSync(join(data, "control-token"), "utf8").trim() };
  } catch {
    throw new Error(
      `No service is running with its data in ${data}. Start one: agentcomputer serve`,
    );
  }
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      data: { type: "string" },
      listen: { type: "string" },
      isolation: { type: "string" },
      image: { type: "string" },
      browser: { type: "boolean" },
      "browser-name": { type: "string" },
      "browser-path": { type: "string" },
      "playwright-cli": { type: "string" },
      access: { type: "string" },
      workspace: { type: "string" },
      name: { type: "string" },
      timeout: { type: "string" },
      state: { type: "string" },
      metadata: { type: "string", multiple: true },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command, id, extra] = positionals;
  if (values.help || !command) return void process.stdout.write(USAGE);
  const data = dataFolder(values.data);
  const out = (value: unknown) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  const idOf = () => {
    if (!id) throw new UsageError(`${command} takes a computer's id.`);
    return id;
  };
  const milliseconds = (seconds: string) => Number(seconds) * 1000;
  if (command === "serve") {
    const isolation = values.isolation ?? "none";
    if (isolation !== "none" && isolation !== "container")
      throw new UsageError("--isolation is none or container.");
    return serve({
      listen: values.listen ?? "127.0.0.1:7878",
      data,
      runtime:
        isolation === "container"
          ? new ContainerRuntime(values.image ?? `${IMAGE}:${VERSION}`)
          : new ProcessRuntime({
              cli: values["playwright-cli"],
              browser: values["browser-name"],
              path: values["browser-path"],
            }),
    });
  }
  // The image's command, not for a person to run.
  if (command === "inside")
    return serveInside({
      access: values.access as CreateOpts["access"],
      browser: values.browser === true,
    });
  const connection = connectionTo(data);
  switch (command) {
    case "info":
      return out(await Computer.serviceInfo(connection));
    case "create": {
      if (!values.access) throw new UsageError("create takes --access.");
      const computer = await Computer.create({
        ...connection,
        access: values.access as CreateOpts["access"],
        ...(values.browser ? { browser: true } : {}),
        ...(values.workspace ? { workspace: resolve(values.workspace) } : {}),
        ...(values.name ? { name: values.name } : {}),
        ...(values.timeout ? { timeoutMs: milliseconds(values.timeout) } : {}),
        ...(values.metadata
          ? {
              metadata: Object.fromEntries(
                values.metadata.map((pair) => {
                  const at = pair.indexOf("=");
                  if (at < 1) throw new UsageError("--metadata takes KEY=VALUE.");
                  return [pair.slice(0, at), pair.slice(at + 1)];
                }),
              ),
            }
          : {}),
      });
      return out({ ...(await computer.getInfo()), accessToken: computer.getMcpToken() });
    }
    case "list":
      return out(
        await Computer.list({
          ...connection,
          ...(values.state ? { state: values.state as "running" } : {}),
        }),
      );
    case "get":
      return out(await Computer.getInfo(idOf(), connection));
    case "timeout":
      return out(await Computer.setTimeout(idOf(), milliseconds(extra ?? ""), connection));
    case "stop":
      return out(await Computer.stop(idOf(), connection));
    case "start":
      return out(
        await Computer.start(idOf(), {
          ...connection,
          ...(values.timeout ? { timeoutMs: milliseconds(values.timeout) } : {}),
        }),
      );
    case "logs":
      return out({ logs: await Computer.getLogs(idOf(), connection) });
    case "kill":
      return Computer.kill(idOf(), connection);
    default:
      throw new UsageError(`There's no command ${command}.`);
  }
}

// On a worker thread this file is AgentExec's search, not the service.
if (isMainThread)
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    if (error instanceof UsageError) process.stderr.write(USAGE);
    process.exit(error instanceof UsageError ? 2 : 1);
  });
