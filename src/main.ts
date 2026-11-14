// `agentcomputer`: run the service, or ask a running one to do something.
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { isMainThread } from "node:worker_threads";
import { CONNECT_VARIABLE, hostBrowser } from "./browser-host.ts";
import { serveBrowserMcp } from "./browser-mcp.ts";
import { ContainerRuntime } from "./container.ts";
import { VERSION } from "./handlers.ts";
import { serveInside } from "./inside.ts";
import { down, recorded, running, up } from "./running.ts";
import { ProcessRuntime } from "./runtime.ts";
import { Computer, type CreateOpts, type LiveMode, type LiveSurface } from "./sdk.ts";
import { serve } from "./service.ts";

const USAGE = `Usage: agentcomputer <command> [--data DIR]

  serve [--listen HOST:PORT] [--image IMAGE]
        [--tls-cert FILE --tls-key FILE | --tls-proxy] [--public-url URL] [--allow-origin ORIGIN]...
        [--browser-name NAME] [--browser-path PATH] [--screen-driver PATH]
        [--own-browser-data DIR] [--lend]
                                    run the service; 127.0.0.1:7878 by default, and
                                    anywhere else only with TLS; with --lend, it lends
                                    this machine and makes no computers
  up [the options of serve]         run the service in the background and return once it
                                    answers, printing where; one running is left as it is
  down                              stop the service, and its computers with it
  status                            where the service is running, if it is
  info                              the service's version and what it offers: this computer,
                                    the kinds it makes, and their browsers, each ready or not
  create --access none|read|files|terminal [--browser] [--workspace DIR | --copy-from DIR]
         [--name NAME] [--isolation container] [--timeout SECONDS] [--metadata KEY=VALUE]...
                                    make a computer, in a container; prints its endpoints and
                                    token, once
  attach --access none|read|files|terminal --workspace DIR [--browser | --own-browser] [--screen]
         [--name NAME] [--timeout SECONDS] [--metadata KEY=VALUE]...
                                    attach this computer, whole and acting as you, with DIR its
                                    work folder, and a headless browser or your own; prints its
                                    endpoints and token, once
  list [--state starting|running|stopped|failed]
                                    the computers
  get <id>                          one computer
  timeout <id> <seconds>            it now stops this long from now
  stop <id>                         stop it, keeping its folder and token
  start <id> [--timeout SECONDS]    start a stopped computer again
  logs <id>                         what its servers wrote
  live <id> --surface terminal|files|browser|load|presence|screen [--mode watch|operate]
                                    a one-time ticket to open one live, as a WebSocket
  kill <id>                         stop it and remove what the service made, or detach this
                                    computer

--version prints this program's version, with no service.

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

const none = (data: string) =>
  `No service is running with its data in ${data}. Start one: agentcomputer up`;

function connectionTo(data: string) {
  const said = recorded(data);
  if (!said) throw new Error(none(data));
  return { apiUrl: said.url, apiKey: said.token };
}

async function main() {
  const { values, positionals, tokens } = parseArgs({
    allowPositionals: true,
    tokens: true,
    options: {
      version: { type: "boolean" },
      data: { type: "string" },
      listen: { type: "string" },
      isolation: { type: "string" },
      image: { type: "string" },
      lend: { type: "boolean" },
      "tls-cert": { type: "string" },
      "tls-key": { type: "string" },
      "tls-proxy": { type: "boolean" },
      "public-url": { type: "string" },
      "allow-origin": { type: "string", multiple: true },
      surface: { type: "string" },
      mode: { type: "string" },
      browser: { type: "boolean" },
      screen: { type: "boolean" },
      "screen-driver": { type: "string" },
      "browser-name": { type: "string" },
      "browser-path": { type: "string" },
      profile: { type: "string" },
      channel: { type: "string" },
      executable: { type: "string" },
      "no-sandbox": { type: "boolean" },
      endpoint: { type: "string" },
      "own-browser": { type: "boolean" },
      own: { type: "boolean" },
      "own-browser-data": { type: "string" },
      output: { type: "string" },
      access: { type: "string" },
      workspace: { type: "string" },
      "copy-from": { type: "string" },
      name: { type: "string" },
      timeout: { type: "string" },
      state: { type: "string" },
      metadata: { type: "string", multiple: true },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command, id, extra] = positionals;
  if (values.version) return void process.stdout.write(`${VERSION}\n`);
  if (values.help || !command) return void process.stdout.write(USAGE);
  const data = dataFolder(values.data);
  const out = (value: unknown) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  if (command === "status") {
    const found = await running(data);
    if (!found) throw new Error(none(data));
    return out(found);
  }
  if (command === "up") {
    // `serve` gets the same arguments, less the one word.
    const given = process.argv.slice(2);
    given.splice(tokens.find((token) => token.kind === "positional")?.index as number, 1);
    return out(await up(data, process.argv[1] as string, given));
  }
  if (command === "down") return down(data);
  // These two are a computer's: with its id forgotten they stop nothing and say whose they are.
  if ((command === "start" || command === "stop") && !id) {
    const service = command === "start" ? "up" : "down";
    throw new UsageError(
      `${command} takes a computer's id. For the service itself: agentcomputer ${service}`,
    );
  }
  const idOf = () => {
    if (!id) throw new UsageError(`${command} takes a computer's id.`);
    return id;
  };
  const milliseconds = (seconds: string) => Number(seconds) * 1000;
  const { isolation } = values;
  for (const flag of ["isolation", "copy-from"] as const)
    if (values[flag] !== undefined && command !== "create")
      throw new UsageError(`Only create takes --${flag}.`);
  if (values["own-browser"] && command !== "attach")
    throw new UsageError("Only attach takes --own-browser.");
  if (values["own-browser"] && values.browser)
    throw new UsageError("Take --browser or --own-browser: a computer has one browser.");
  if (command === "serve") {
    const { "tls-cert": cert, "tls-key": key } = values;
    if (Boolean(cert) !== Boolean(key))
      throw new UsageError("--tls-cert and --tls-key go together.");
    return serve({
      listen: values.listen ?? "127.0.0.1:7878",
      data,
      tls: cert && key ? { cert, key } : undefined,
      tlsProxy: values["tls-proxy"],
      publicUrl: values["public-url"],
      allowOrigins: values["allow-origin"],
      runtimes: {
        none: new ProcessRuntime(
          { browser: values["browser-name"], path: values["browser-path"] },
          false,
          values["screen-driver"],
          values["own-browser-data"],
        ),
        // Lending this machine only, it makes no computers.
        ...(values.lend
          ? {}
          : { container: new ContainerRuntime(values.image ?? `${IMAGE}:${VERSION}`) }),
      },
    });
  }
  // Started by the service for each browser, not for a person to run.
  if (command === "browser-host")
    return hostBrowser({
      profile: values.profile ?? "",
      connect: process.env[CONNECT_VARIABLE],
      channel: values.channel,
      executable: values.executable,
      sandbox: values["no-sandbox"] ? false : undefined,
    });
  // Started by the service beside each browser host, not for a person to run.
  if (command === "browser-mcp")
    return serveBrowserMcp({
      endpoint: values.endpoint ?? "",
      outputDir: values.output ?? "",
      own: values.own === true,
    });
  // The image's command, not for a person to run.
  if (command === "inside") {
    if (!values.name) throw new UsageError("inside takes --name, its agent's name.");
    return serveInside({
      access: values.access as CreateOpts["access"],
      browser: values.browser === true,
      name: values.name,
    });
  }
  const connection = connectionTo(data);
  /** What create and attach both take. */
  const making = () => {
    if (!values.access) throw new UsageError(`${command} takes --access.`);
    return {
      ...connection,
      access: values.access as CreateOpts["access"],
      ...(values.browser ? { browser: true } : {}),
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
    };
  };
  const printMade = async (computer: Computer) =>
    out({ ...(await computer.getInfo()), accessToken: computer.getMcpToken() });
  switch (command) {
    case "info":
      return out(await Computer.serviceInfo(connection));
    case "create":
      return printMade(
        await Computer.create({
          ...making(),
          ...(isolation ? { isolation: isolation as CreateOpts["isolation"] } : {}),
          ...(values.workspace ? { workspace: resolve(values.workspace) } : {}),
          ...(values["copy-from"] ? { copyFrom: resolve(values["copy-from"]) } : {}),
        }),
      );
    case "attach":
      if (!values.workspace) throw new UsageError("attach takes --workspace.");
      return printMade(
        await Computer.attach({
          ...making(),
          workspace: resolve(values.workspace),
          ...(values["own-browser"] ? { browser: "own" as const } : {}),
          ...(values.screen ? { screen: true } : {}),
        }),
      );
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
    case "live":
      if (!values.surface) throw new UsageError("live takes --surface.");
      return out(
        await Computer.createLiveSession(
          idOf(),
          {
            surface: values.surface as LiveSurface,
            ...(values.mode ? { mode: values.mode as LiveMode } : {}),
          },
          connection,
        ),
      );
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
