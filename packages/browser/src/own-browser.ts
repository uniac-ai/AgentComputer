// The person's own browser, for this computer: Chrome or Edge, whichever has remote debugging on,
// Chrome first, as they use it, signed in. It is reached through the browser's own attach, from
// version 144: the person switches on remote debugging once, on its inspect page, and the browser
// then writes where it is reached in DevToolsActivePort, in its user data folder, and asks the
// person to allow each connection. Nothing is installed, and no port is opened on the person's
// profile by the service.
import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** One browser the person may have, as this machine has it. */
export interface Kind {
  browser: "chrome" | "edge" | "named";
  name: string;
  /** Where the person switches on remote debugging. */
  page: string;
  /** Its user data folder, where it writes DevToolsActivePort. */
  folder: string;
  /** Whether it is here: one whose folder the service was given is taken to be. */
  installed: boolean;
  /** Its app or program, where this can open it; none for a folder named by the service. */
  at?: string | undefined;
}

export type OwnBrowser =
  | { ready: true; name: string; endpoint: string }
  | { ready: false; reason: string };

/** A program on the path, where there is one. */
const onPath = (names: string[]) =>
  names
    .flatMap((name) =>
      (process.env.PATH ?? "")
        .split(delimiter)
        .filter((dir) => isAbsolute(dir))
        .map((dir) => join(dir, name)),
    )
    .find((path) => existsSync(path));

/** The system browsers are looked for on: this one, unless a test stands in. */
export interface Where {
  platform: NodeJS.Platform;
  home: string;
  /** Where macOS apps are looked for. */
  applications: string[];
}
export const here = (): Where => ({
  platform: process.platform,
  home: homedir(),
  applications: ["/Applications", join(homedir(), "Applications")],
});

/** Chrome, then Edge, where each would be on this machine, installed or not. */
function kinds({ platform, home, applications }: Where): Omit<Kind, "installed">[] {
  if (platform === "darwin") {
    const app = (name: string) =>
      applications.map((folder) => join(folder, name)).find((path) => existsSync(path));
    const support = join(home, "Library", "Application Support");
    return [
      {
        browser: "chrome",
        name: "Chrome",
        page: "chrome://inspect/#remote-debugging",
        folder: join(support, "Google", "Chrome"),
        at: app("Google Chrome.app"),
      },
      {
        browser: "edge",
        name: "Edge",
        page: "edge://inspect/#remote-debugging",
        folder: join(support, "Microsoft Edge"),
        at: app("Microsoft Edge.app"),
      },
    ];
  }
  const config =
    process.env.CHROME_CONFIG_HOME || process.env.XDG_CONFIG_HOME || join(home, ".config");
  return [
    {
      browser: "chrome",
      name: "Chrome",
      page: "chrome://inspect/#remote-debugging",
      folder: join(config, "google-chrome"),
      at: onPath(["google-chrome", "google-chrome-stable"]),
    },
    {
      browser: "edge",
      name: "Edge",
      page: "edge://inspect/#remote-debugging",
      folder: join(config, "microsoft-edge"),
      at: onPath(["microsoft-edge", "microsoft-edge-stable"]),
    },
  ];
}

/**
 * Whether what listens on this port is this user's, as the person's browser is. Another user's
 * process, on a port a browser that has closed left behind, can't stand in for it.
 */
async function ours(port: number) {
  const uid = process.getuid?.();
  if (process.platform === "linux") {
    const hex = `:${port.toString(16).toUpperCase().padStart(4, "0")}`;
    return ["/proc/net/tcp", "/proc/net/tcp6"].some((table) => {
      try {
        // Each socket: its local address and port in hex, its state (0A listens), its owner.
        return readFileSync(table, "utf8")
          .split("\n")
          .slice(1)
          .map((line) => line.trim().split(/\s+/))
          .some((f) => f[1]?.endsWith(hex) && f[3] === "0A" && Number(f[7]) === uid);
      } catch {
        return false;
      }
    });
  }
  try {
    const { stdout } = await run("/usr/sbin/lsof", [
      "-nP",
      `-iTCP:${port}`,
      "-sTCP:LISTEN",
      "-a",
      "-u",
      String(uid),
      "-t",
    ]);
    return stdout.trim() !== "";
  } catch {
    // It finds none.
    return false;
  }
}

/** What a browser's DevToolsActivePort names, and when it was written; none where it names none. */
function named(folder: string) {
  try {
    const file = join(folder, "DevToolsActivePort");
    const [port, path] = readFileSync(file, "utf8").split("\n");
    const number = Number(port);
    if (!Number.isInteger(number) || !path?.startsWith("/devtools/browser/")) return undefined;
    return { port: number, path: path.trim(), written: statSync(file).mtimeMs };
  } catch {
    return undefined;
  }
}

/** Where a browser is reached, from its DevToolsActivePort, while it is listening there. */
export async function reachedAt(folder: string) {
  const at = named(folder);
  return at && (await ours(at.port)) ? `ws://127.0.0.1:${at.port}${at.path}` : undefined;
}

/** How long a browser found listening is taken to be, while its DevToolsActivePort is the same. */
const KEPT_MS = 60_000;
/** Each browser found listening, by its folder: what its DevToolsActivePort said, and when. */
const listening = new Map<string, { said: string; at: number }>();

/**
 * Whether a browser's remote debugging is on, as the setup shows it, read often. Finding who
 * listens on its port starts a program on a Mac, so one found listening is taken to be, for a
 * minute, while its DevToolsActivePort names the same port and was written at the same time. A
 * browser that has closed has removed that file; one that crashed may have left it, and is taken
 * as on for up to that minute. Attaching to it checks afresh.
 */
export async function debuggingOn(folder: string, now = Date.now()) {
  const at = named(folder);
  if (!at) return false;
  const said = `${at.port} ${at.path} ${at.written}`;
  const kept = listening.get(folder);
  if (kept?.said === said && now - kept.at < KEPT_MS) return true;
  if (!(await ours(at.port))) return false;
  listening.set(folder, { said, at: now });
  return true;
}

/** The person's browsers: Chrome, then Edge, installed or not, or the one whose folder is named. */
export function browsers(folder?: string, where: Where = here()): Kind[] {
  if (folder)
    return [
      {
        browser: "named",
        name: "the browser",
        page: "chrome://inspect/#remote-debugging",
        folder,
        installed: true,
      },
    ];
  return kinds(where).map((kind) => ({ ...kind, installed: kind.at !== undefined }));
}

/**
 * The person's browser, and where it is reached, or why it can't be. `folder`, where given, is
 * the user data folder of the browser to use, in place of looking for Chrome and Edge.
 */
export async function ownBrowser(folder?: string, where: Where = here()): Promise<OwnBrowser> {
  const found = browsers(folder, where).filter((kind) => kind.installed);
  // The one with remote debugging on, Chrome first: turning it on is choosing it.
  for (const { name, folder } of found) {
    const endpoint = await reachedAt(folder);
    if (endpoint) return { ready: true, name, endpoint };
  }
  const [first, second] = found;
  if (!first)
    return { ready: false, reason: "Neither Chrome nor Edge is installed on this machine." };
  if (second)
    return {
      ready: false,
      reason: `Neither ${first.name}'s nor ${second.name}'s remote debugging is on, or the browser isn't open. On this machine, open the one you use, version 144 or later, go to its inspect page, ${first.page} or ${second.page}, and switch on remote debugging. It then asks you to allow each connection.`,
    };
  const { name, page } = first;
  const Name = name[0]?.toUpperCase() + name.slice(1);
  return {
    ready: false,
    reason: `${Name}'s remote debugging is off, or ${name} isn't open. On this machine, open ${name}, version 144 or later, go to its inspect page, ${page}, and switch on remote debugging. ${Name} then asks you to allow each connection.`,
  };
}
