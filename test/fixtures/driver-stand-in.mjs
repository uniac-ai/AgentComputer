// A stand-in for Cua Driver over MCP, answering as the real one answered on a Mac: a click by a
// point posted in the background with its advice to retry in the foreground, a click by an element
// that can't be pressed refused with its raw words, a hint and a suggested next call naming its
// own tools, a typing refusal advising the foreground, and its window list with fields. Its window
// tree and a window title mention "foreground", as a person's can. `--version` says the version.
//
// The real pointer, on a Retina Mac's screen: a click in the foreground puts it at (500, 400), and
// the person moves it a further (3, 4) meanwhile. A click by a point at x 777 to 782 is answered in
// the background as the driver can: 777 refused before anything was sent, saying the foreground
// would do it; 778 failed after it may have been sent; 779 refused for a toolkit that reads the
// real pointer; 780 like 777, with the pointer then not put back; 781 like 777, and refused in the
// foreground too; 782 refused, with no foreground to try; 783 like 777, with the person moving the
// pointer again once it is put back; 784 like 777, the foreground click answered with an error that
// says nothing more, after it moved the pointer; 785 like 777, with the screen's size unread; 786
// like 777, with the pointer unread once after the click; 787 clicked in the background, the next
// picture of the whole screen then failing; 788 like 781, refused in the foreground as nothing
// sent; 789 clicked in the background, the next pointer read only where the driver last put it.
// Its whole screen's picture is smaller than the screen, and a point in the whole screen it is
// then sent is read against it.
//
// The person's click, drag or scroll in the live view, at a point of the whole screen in the
// foreground, is made as a Mac's driver makes it: the pointer goes to the point (a drag's end),
// and the person moves it a further (3, 4) meanwhile. One starting at x 601 then leaves the pointer
// where it can't be moved back; 602 is refused before anything is sent; 603 fails after the
// pointer moved; 604 is moved back somewhere else, as the driver says; 605 is answered 400 ms after
// the pointer moved, as a drag takes its time; 606 fails after the pointer moved, where it can't be
// moved back. With STANDIN_POINTER=unread, the pointer is never read.
//
// Its drawn pointer, as the driver draws one for each connection: a move with no scope glides it
// alone, and an input at a point of the whole screen glides it there first, where it isn't yet,
// before the real pointer goes. With STANDIN_HAND=moving, the person's hand moves the real pointer
// a further (50, 30) during each glide.
//
// With STANDIN_CALLS, each call is written to that file as a line of JSON, with STANDIN_WHO's name
// where that is set.
import { appendFileSync } from "node:fs";
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
/** The real pointer, in the screen's points; the screen is twice that in pixels. */
let pointer = { x: 100, y: 100 };
let stuck = false;
let drifting = false;
let sizeless = false;
let unread = 0;
let pictureFails = false;
let synthetic = false;
let astray = false;
/** How much smaller than the screen the last picture of the whole of it was. */
let desktop = { x: 1, y: 1 };
const DESKTOP = { screenshot_width: 1366, screenshot_height: 887 };
const SCREEN = { screenshot_original_width: 3024, screenshot_original_height: 1964 };
const refused = (fields) =>
  said(
    'Background pixel click is not available for pid 19249. Retry this action with delivery_mode:"foreground".',
    {
      code: "background_unavailable",
      ...fields,
      escalation: { recommended: "foreground", reason: "background routing can't reach it" },
    },
    true,
  );
/** A click by a point in the background, at one of the markers. */
const background = {
  777: () => refused({ effect: "refused", reason: "windowserver_connection_invalid" }),
  778: () => said("click failed: the posting task stopped after the press", undefined, true),
  779: () =>
    refused({ event_kind: "mouse_click", reason: "pointer_reading_toolkit", toolkit: "Tk" }),
  780: () => {
    stuck = true;
    return refused({ effect: "refused", reason: "windowserver_connection_invalid" });
  },
  781: () => refused({ effect: "refused", reason: "windowserver_connection_invalid" }),
  783: () => {
    drifting = true;
    return refused({ effect: "refused", reason: "windowserver_connection_invalid" });
  },
  784: () => refused({ effect: "refused", reason: "windowserver_connection_invalid" }),
  785: () => {
    sizeless = true;
    return refused({ effect: "refused", reason: "windowserver_connection_invalid" });
  },
  786: () => {
    unread = 1;
    return refused({ effect: "refused", reason: "windowserver_connection_invalid" });
  },
  787: (args) => {
    pictureFails = true;
    return standing(args);
  },
  788: () => refused({ effect: "refused", reason: "windowserver_connection_invalid" }),
  789: () => {
    synthetic = true;
    return refused({ effect: "refused", reason: "windowserver_connection_invalid" });
  },
  782: () =>
    said(
      "Background input refused (minimized_or_hidden_window): window 12895 is minimized.",
      {
        code: "minimized_or_hidden_window",
        effect: "refused",
        escalation: { recommended: "accessibility" },
      },
      true,
    ),
};
const foreground = ({ x }) => {
  if (x === 781)
    return said(
      "click failed: foreground HID delivery to window 12895 was not possible: it didn't come forward",
      { code: "foreground_unavailable" },
      true,
    );
  if (x === 788)
    return said(
      "Foreground input refused (screen_locked): the screen is locked.",
      { code: "screen_locked", effect: "refused" },
      true,
    );
  pointer = { x: 503, y: 404 };
  if (x === 784) return said("Task error: the connection closed", undefined, true);
  return said(
    "✅ Posted click at screen-point (500,400) for pid 19249 (delivery_mode:foreground; window fronted, hardware pointer moved, HID event tap).",
    { path: "cgevent_hid", verified: false, effect: "unverifiable" },
  );
};
/** The person's input at a point of the whole screen, in the foreground. */
/** The drawn pointer, in the screen's points, once it has been placed. */
let drawn;
/** The drawn pointer glided to a point, while the person's hand may move the real one. */
const glide = (to) => {
  if (drawn && Math.abs(drawn.x - to.x) <= 1 && Math.abs(drawn.y - to.y) <= 1) return;
  if (process.env.STANDIN_HAND === "moving") pointer = { x: pointer.x + 50, y: pointer.y + 30 };
  drawn = to;
};
const atDesktop = (name, args) => {
  const from = { x: args.x ?? args.from_x, y: args.y ?? args.from_y };
  if (from.x === 602)
    return said(
      "Foreground input refused (screen_locked): the screen is locked.",
      { code: "screen_locked", effect: "refused" },
      true,
    );
  glide({ x: (from.x * desktop.x) / 2, y: (from.y * desktop.y) / 2 });
  const [px, py] = name === "drag" ? [args.to_x, args.to_y] : [from.x, from.y];
  const end = { x: (px * desktop.x) / 2, y: (py * desktop.y) / 2 };
  drawn = end;
  pointer = { x: end.x + 3, y: end.y + 4 };
  if (from.x === 601 || from.x === 606) stuck = true;
  if (from.x === 604) astray = true;
  if (from.x === 603 || from.x === 606)
    return said("Task error: the connection closed", undefined, true);
  if (from.x === 605)
    return new Promise((done) =>
      setTimeout(() => done(said("✅ Sent screen-absolute click (desktop scope)")), 400),
    );
  const at = (point) => `(${point.x.toFixed(1)}, ${point.y.toFixed(1)})`;
  const sent = { scope: "desktop", path: "hid", effect: "unverifiable" };
  if (name === "drag")
    return said(
      `Dragged desktop from ${at({ x: (from.x * desktop.x) / 2, y: (from.y * desktop.y) / 2 })} to ${at(end)}.`,
      sent,
    );
  if (name === "scroll")
    return said(
      `Scrolled desktop ${args.direction} by line × ${args.amount ?? 3} at ${at(end)}.`,
      sent,
    );
  return said(
    `✅ Sent screen-absolute ${args.button === "right" ? "right-click" : "click"} at desktop-pixel (${px},${py}) → screen-point (${end.x.toFixed(0)},${end.y.toFixed(0)}) (desktop scope; not driver-verified).`,
    { path: "cgevent_hid", verified: false, effect: "unverifiable" },
  );
};
const inDesktop = (args) => args.target?.kind === "desktop" && args.delivery_mode === "foreground";
/** A click by an element, or by any other point, in the background. */
const standing = ({ element_token }) =>
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
        });
const answers = {
  get_cursor_position: () => {
    if (process.env.STANDIN_POINTER === "unread")
      return said("the pointer couldn't be read", undefined, true);
    if (pointer.x === 503 && unread > 0 && unread--)
      return said("the pointer couldn't be read", undefined, true);
    if (synthetic) {
      synthetic = false;
      return said("where the driver last put it", { source: "synthetic", ...pointer });
    }
    return said(`${pointer.x},${pointer.y}`, { source: "cgevent", ...pointer });
  },
  get_screen_size: () =>
    sizeless
      ? said("the screen's size couldn't be read", undefined, true)
      : said("✅ Main display: 1512x982 points @ 2x", {
          width: 1512,
          height: 982,
          scale_factor: 2,
        }),
  get_desktop_state: () => {
    if (pictureFails) {
      pictureFails = false;
      return said("Desktop screenshot failed", undefined, true);
    }
    desktop = {
      x: SCREEN.screenshot_original_width / DESKTOP.screenshot_width,
      y: SCREEN.screenshot_original_height / DESKTOP.screenshot_height,
    };
    return said("✅ Desktop screenshot 1366x887 (screen 1512x982)", { ...DESKTOP, ...SCREEN });
  },
  move_cursor: ({ x, y, scope }) => {
    // With no scope, the drawn pointer alone, in the screen's points.
    if (scope !== "desktop") {
      glide({ x, y });
      return said(`Agent cursor 'mcp' moved to (${x.toFixed(1)}, ${y.toFixed(1)}).`);
    }
    if (stuck) return said("desktop pointer move failed: refused", undefined, true);
    // A point in the whole screen, read against its last picture, then turned into points.
    const to = { x: (x * desktop.x) / 2 + (astray ? 40 : 0), y: (y * desktop.y) / 2 };
    astray = false;
    pointer = { x: to.x + (drifting ? 5 : 0), y: to.y };
    return said(`Moved the real desktop pointer to (${to.x.toFixed(1)}, ${to.y.toFixed(1)}).`, {
      scope: "desktop",
    });
  },
  click: (args) =>
    inDesktop(args)
      ? atDesktop("click", args)
      : args.delivery_mode === "foreground"
        ? foreground(args)
        : (background[args.x] ?? standing)(args),
  drag: (args) => (inDesktop(args) ? atDesktop("drag", args) : said("✅ drag")),
  scroll: (args) => (inDesktop(args) ? atDesktop("scroll", args) : said("✅ scroll")),
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
  "get_cursor_position",
  "get_screen_size",
  "move_cursor",
])
  server.registerTool(
    name,
    { description: name, inputSchema: z.object({}).passthrough() },
    async (args) => {
      if (process.env.STANDIN_CALLS)
        appendFileSync(
          process.env.STANDIN_CALLS,
          `${JSON.stringify({ name, args, ...(process.env.STANDIN_WHO ? { who: process.env.STANDIN_WHO } : {}) })}\n`,
        );
      return (answers[name] ?? (() => said(`✅ ${name}`)))(args);
    },
  );
await server.connect(new StdioServerTransport());
