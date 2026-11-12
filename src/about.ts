// What a computer says of itself to its agent: the `about` tool at its `computer` endpoint. It is
// what a person looking at the computer reads, in rows of a label and a value.
import type { ExtraTool } from "@agentorg/exec";
import type { components } from "./generated/schema.js";
import type { LoadLive } from "./load-live.ts";

type Access = components["schemas"]["Access"];
interface Row {
  label: string;
  value: string;
  /** The value is a path. */
  path?: true;
  /** The value is to be read as a caution. */
  caution?: true;
}
interface Facts {
  /** The machine it is on, by its own name. */
  machine: string;
  /** Where its workspace is on that machine, and where its own commands find it. */
  workspace: { outside: string; inside: string };
  access: Exclude<Access, "none">;
  browser: boolean;
  /** Whether it is a container of its own. */
  contained: boolean;
}

const REACHES: Record<Facts["access"], string> = {
  read: "Read-only files",
  files: "Files",
  terminal: "Files and terminal",
};
/** Memory is counted in 1024s and a disk in 1000s, and both are written GB. */
const GIB = 1024 ** 3;
const GB = 1000 ** 3;
const tenths = (count: number) => String(Math.round(count * 10) / 10);
const whole = (count: number) => String(Math.round(count));

export function aboutTool(facts: Facts, load: LoadLive): ExtraTool {
  return {
    name: "about",
    description:
      'What this computer is, in the words a person looking at it reads: where it is, its folder, what it reaches, how it is isolated and how loaded it is. Takes nothing. Answers JSON text: {"rows": [{"label": "Where", "value": "..."}]}, with "path": true on a value that is a path and "caution": true on one to be read as a caution.',
    readOnly: true,
    async call() {
      const { outside, inside } = facts.workspace;
      const rows: Row[] = [
        { label: "Where", value: facts.machine },
        // In a container its commands find the folder somewhere else, so the row says both.
        inside === outside
          ? { label: "Folder", value: outside, path: true }
          : { label: "Folder", value: `${outside} on the machine, mounted at ${inside} in it` },
        { label: "Reaches", value: REACHES[facts.access] + (facts.browser ? ", Browser" : "") },
        facts.contained
          ? { label: "Isolation", value: "A container of its own" }
          : { label: "Isolation", value: "None: it acts as you", caution: true },
      ];
      const reading = await load.now();
      if (reading)
        rows.push(
          { label: "CPU", value: `${whole(reading.cpuUsedPct)}%` },
          {
            label: "Memory",
            value: `${tenths(reading.memUsed / GIB)} of ${tenths(reading.memTotal / GIB)} GB`,
          },
          {
            label: "Disk",
            value: `${whole(reading.diskUsed / GB)} of ${whole(reading.diskTotal / GB)} GB`,
          },
        );
      return JSON.stringify({ rows });
    },
  };
}
