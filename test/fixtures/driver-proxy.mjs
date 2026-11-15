// A thin proxy in front of the pinned Cua Driver over MCP's stdio, for the screen image's tests. It
// answers a click in the background at x 77 as the driver does for an app whose toolkit reads the
// real pointer, refused before anything is sent, and one at x 78 as failed after it may have been
// sent. Everything else reaches the driver, the whole screen's picture asked for smaller than the
// screen, as a Mac's driver gives it. Each tool call is written to /tmp/proxy/calls.jsonl, and the
// driver's words in answer to each click it was sent.
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const driver = spawn("cua-driver", ["mcp"], { stdio: ["pipe", "pipe", "inherit"] });
driver.on("exit", (code) => process.exit(code ?? 0));
// One writer of whole lines, so that the driver's answers and the proxy's never interleave.
const send = (line) => process.stdout.write(`${line}\n`);
const note = (call) => appendFileSync("/tmp/proxy/calls.jsonl", `${JSON.stringify(call)}\n`);
/** The ids of the clicks sent to the driver, whose answers are noted. */
const clicks = new Set();
createInterface({ input: driver.stdout }).on("line", (line) => {
  const { id, result } = JSON.parse(line);
  if (clicks.delete(id)) note({ name: "answered", text: result?.content?.[0]?.text ?? "" });
  send(line);
});

const said = (text, structuredContent) => ({
  content: [{ type: "text", text }],
  ...(structuredContent ? { structuredContent } : {}),
  isError: true,
});
const answers = {
  77: () =>
    said(
      'Background pixel click is not available for this pid: its Tk toolkit reads the hardware pointer position. Retry this action with delivery_mode:"foreground"; Cua Driver will activate the window, move the pointer to the target, and click.',
      {
        code: "background_unavailable",
        event_kind: "mouse_click",
        reason: "pointer_reading_toolkit",
        toolkit: "Tk",
        escalation: {
          recommended: "foreground",
          reason: "the target toolkit reads the hardware pointer position",
        },
      },
    ),
  78: () => said("click failed: the posting task stopped after the press"),
};

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "tools/call") {
    const { name, arguments: args = {} } = message.params;
    note({ name, args });
    const answer = name === "click" && args.delivery_mode === "background" && answers[args.x];
    if (answer) {
      send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: answer() }));
      return;
    }
    if (name === "click") clicks.add(message.id);
    if (name === "get_desktop_state" && args.max_image_dimension === undefined) {
      message.params.arguments = { ...args, max_image_dimension: 960 };
      driver.stdin.write(`${JSON.stringify(message)}\n`);
      return;
    }
  }
  driver.stdin.write(`${line}\n`);
});
process.stdin.on("end", () => driver.stdin.end());
