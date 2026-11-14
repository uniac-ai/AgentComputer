// A stand-in for Cua Driver over MCP, answering as the real one answered on a Mac: a click by a
// point posted in the background with its advice to retry in the foreground, a click by an element
// that can't be pressed refused with its raw words, a hint and a suggested next call naming its
// own tools, a typing refusal advising the foreground, and its window list with fields. Its window
// tree and a window title mention "foreground", as a person's can. `--version` says the version.
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

if (process.argv[2] === "--version") {
  process.stdout.write("cua-driver 0.49.7\n");
  process.exit(0);
}

const said = (text, structuredContent, isError) => ({
  content: [{ type: "text", text }],
  ...(structuredContent ? { structuredContent } : {}),
  ...(isError ? { isError: true } : {}),
});
const POSTED =
  '✅ Posted click to pid 19249 (background CGEvent routed to the pid; the hardware pointer was not moved, so apps that read the pointer position may not receive it at the target; not driver-verified — confirm via screenshot and retry with delivery_mode:"foreground" if nothing changed).';
const answers = {
  click: ({ element_token }) =>
    element_token === "s0:1"
      ? said(
          "The element_token s0:1 is from an earlier snapshot; see the window again.",
          undefined,
          true,
        )
      : element_token
        ? said(
            "AX action failed: AXUIElementPerformAction(AXPress) returned -25206",
            { code: "tool_invocation_failed" },
            true,
          )
        : said(POSTED, {
            delivery: { mode: "background" },
            effect: "unverifiable",
            hint: "The click was sent but nothing confirmed it. Read what changed before clicking again; a repeat can toggle or double-fire.",
            next_call: {
              tool: "get_window_state",
              arguments: { pid: 19249, window_id: 12895, since: "latest" },
            },
            route: "synthetic_events",
            summary: POSTED,
          }),
  type_text: () =>
    said(
      'Typing into this window can\'t be delivered in the background; retry with delivery_mode:"foreground".',
      { code: "background_unavailable" },
      true,
    ),
  get_window_state: () =>
    said(
      'Window "Prefs" (snapshot s1).\n- [3] AXCheckBox "Foreground colour"\n  - [4] AXStaticText "Use the foreground. Then save."',
    ),
  list_apps: () =>
    said("✅ Found 1 app(s): 1 running.\n- TextEdit (pid 19249) [com.apple.TextEdit]"),
  list_windows: () =>
    said(
      'Found 2 window(s).\n- TextEdit (pid 19249) "Untitled" [window_id: 12895]\n- TextEdit (pid 19249) "foreground.txt" [window_id: 12896]',
      {
        windows: [
          {
            app_name: "TextEdit",
            title: "Untitled",
            pid: 19249,
            window_id: 12895,
            bounds: { x: 120, y: 80, width: 586, height: 488 },
            z_index: 3,
            is_on_screen: true,
            layer: 0,
            space_ids: [1],
          },
        ],
      },
    ),
};
const server = new McpServer({ name: "cua-driver", version: "0.49.7" });
for (const name of [
  "get_desktop_state",
  "get_window_state",
  "click",
  "drag",
  "scroll",
  "type_text",
  "press_key",
  "hotkey",
  "list_apps",
  "list_windows",
  "bring_to_front",
])
  server.registerTool(
    name,
    { description: name, inputSchema: z.object({}).passthrough() },
    async (args) => (answers[name] ?? (() => said(`✅ ${name}`)))(args),
  );
await server.connect(new StdioServerTransport());
