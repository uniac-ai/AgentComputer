// The person's own browser, for this computer: Chrome, or else Edge, as they use it, signed in. It
// is reached through the browser's own attach, from version 144: the person switches on remote
// debugging once, on its inspect page, and the browser then writes where it is reached in
// DevToolsActivePort, in its user data folder, and asks the person to allow each connection.
// Nothing is installed, and no port is opened on the person's profile by the service.
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** One browser the person may have, as this machine has it. */
interface Kind {
  name: string;
  /** Where the person switches on remote debugging. */
  page: string;
  /** Its user data folder, where it writes DevToolsActivePort. */
  folder: string;
  /** Whether it is installed here. */
  installed: boolean;
}

export type OwnBrowser =
  | { ready: true; name: string; endpoint: string }
  | { ready: false; reason: string };

/** A program on the path, where there is one. */
const onPath = (names: string[]) =>
  names.some((name) =>
    (process.env.PATH ?? "")
      .split(delimiter)
      .some((dir) => isAbsolute(dir) && existsSync(join(dir, name))),
  );

/** Chrome, then Edge, where each would be on this machine. */
function kinds(): Kind[] {
  const home = homedir();
  if (process.platform === "darwin") {
    const app = (name: string) =>
      [join("/Applications", name), join(home, "Applications", name)].some((path) =>
        existsSync(path),
      );
    const support = join(home, "Library", "Application Support");
    return [
      {
        name: "Chrome",
        page: "chrome://inspect/#remote-debugging",
        folder: join(support, "Google", "Chrome"),
        installed: app("Google Chrome.app"),
      },
      {
        name: "Edge",
        page: "edge://inspect/#remote-debugging",
        folder: join(support, "Microsoft Edge"),
        installed: app("Microsoft Edge.app"),
      },
    ];
  }
  const config =
    process.env.CHROME_CONFIG_HOME || process.env.XDG_CONFIG_HOME || join(home, ".config");
  return [
    {
      name: "Chrome",
      page: "chrome://inspect/#remote-debugging",
      folder: join(config, "google-chrome"),
      installed: onPath(["google-chrome", "google-chrome-stable"]),
    },
    {
      name: "Edge",
      page: "edge://inspect/#remote-debugging",
      folder: join(config, "microsoft-edge"),
      installed: onPath(["microsoft-edge", "microsoft-edge-stable"]),
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

/** Where a browser is reached, from its DevToolsActivePort, while it is listening there. */
export async function reachedAt(folder: string) {
  try {
    const [port, path] = readFileSync(join(folder, "DevToolsActivePort"), "utf8").split("\n");
    const number = Number(port);
    if (!Number.isInteger(number) || !path?.startsWith("/devtools/browser/")) return undefined;
    return (await ours(number)) ? `ws://127.0.0.1:${number}${path.trim()}` : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The person's browser, and where it is reached, or why it can't be. `folder`, where given, is
 * the user data folder of the browser to use, in place of looking for Chrome and Edge.
 */
export async function ownBrowser(folder?: string): Promise<OwnBrowser> {
  const found = folder
    ? {
        name: "the browser",
        page: "its inspect page, chrome://inspect/#remote-debugging",
        folder,
        installed: true,
      }
    : kinds().find((kind) => kind.installed);
  if (!found)
    return { ready: false, reason: "Neither Chrome nor Edge is installed on this machine." };
  const { name, page } = found;
  const endpoint = await reachedAt(found.folder);
  if (endpoint) return { ready: true, name, endpoint };
  const Name = name[0]?.toUpperCase() + name.slice(1);
  return {
    ready: false,
    reason: `${Name}'s remote debugging is off, or ${name} isn't open. On this machine, open ${name}, version 144 or later, go to ${page} and switch on remote debugging. ${Name} then asks you to allow each connection.`,
  };
}
