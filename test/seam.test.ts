// The provider and the kinds it keeps meet only at the seam: the provider tells a kind by what it
// declares, never by its name, and a new kind is kept with no change to the provider.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ApiError } from "@agentorg/computer-base/error";
import { Computers } from "../src/computers.ts";
import type { Isolation, Runtime } from "../src/seam.ts";

// out/test/seam.test.js → the repository.
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
/** The provider's own sources. */
const PROVIDER = ["computers.ts", "service.ts", "handlers.ts", "running.ts", "seam.ts"];

test("the provider reads a kind's name in one place only, an old record's at load, and no part", () => {
  const named: string[] = [];
  for (const file of PROVIDER) {
    const text = readFileSync(join(root, "src", file), "utf8");
    for (const line of text.split("\n"))
      if (/isolation[^;]*"(none|container)"|"(none|container)"[^;]*isolation/.test(line))
        named.push(`${file}: ${line.trim()}`);
    assert.doesNotMatch(text, /\bruntimes\.(none|container)\b/, file);
    assert.doesNotMatch(
      text,
      /from "@agentorg\/(exec|computer-browser|computer-screen|computer-inside)/,
      file,
    );
  }
  assert.deepEqual(named, [
    'computers.ts: const isolation = entry.isolation ?? "none";',
    'computers.ts: if (isolation === "none" && !entry.attached) this.#retired.add(entry.id);',
  ]);
});

test("a kind the provider has never named is kept by what it declares, with no change to the provider", async (t) => {
  const data = mkdtempSync(join(tmpdir(), "seam-"));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  const calls: string[] = [];
  /** A stand-in kind: it says what it is, and records what the provider asks of it. */
  const kind = (isolation: string, attaches: boolean): Runtime => ({
    isolation: isolation as Isolation,
    attaches,
    ...(attaches ? { notMade: `${isolation} is attached, not made.` } : {}),
    tools: ({ access }) => ({
      computer: access === "none" ? [] : [`${isolation} tool`],
      screen: [],
    }),
    offer: async () => ({ ready: true, capabilities: [], browsers: [] }),
    prepare: async () => {},
    starting: () => ({ reason: "It is being started.", progress: null }),
    start: async (spec) => {
      calls.push(`${isolation} start ${spec.id}`);
      return {
        browserTools: [],
        version: `${isolation} 1`,
        surfaces: [],
        handle: async () => {},
        openLive: async () => {},
        stop: async () => {
          calls.push(`${isolation} stop ${spec.id}`);
        },
      };
    },
    stopLeftover: async (id) => {
      calls.push(`${isolation} leftover ${id}`);
    },
    remove: async (id) => {
      calls.push(`${isolation} remove ${id}`);
    },
  });
  const computers = new Computers(data, () => "http://127.0.0.1:1", [
    kind("none", true),
    kind("container", false),
    kind("vm", false),
  ]);
  t.after(() => computers.close());

  // Offered: the one attached as this computer, and each that makes, in their order.
  const offered = await computers.offers();
  assert.equal(offered.thisComputer.ready, true);
  assert.deepEqual(
    offered.made.map((one) => one.isolation),
    ["container", "vm"],
  );

  // Made as the kind named, recorded by its name, with its tools and its version.
  const { computerID: vm } = await computers.create({
    access: "read",
    browser: false,
    isolation: "vm" as never,
  });
  const detail = computers.get(vm);
  assert.deepEqual(
    [detail.isolation, detail.attached, detail.tools.computer, detail.version],
    ["vm", false, ["vm tool"], "vm 1"],
  );
  await computers.stop(vm);
  await computers.start(vm);
  await computers.kill(vm);
  assert.deepEqual(
    calls.filter((call) => call.endsWith(vm)),
    [`vm start ${vm}`, `vm stop ${vm}`, `vm start ${vm}`, `vm stop ${vm}`, `vm remove ${vm}`],
  );

  // With none named, the one that makes first; asked to make the one attached, its own refusal.
  const { computerID: made } = await computers.create({ access: "read", browser: false });
  assert.equal(computers.get(made).isolation, "container");
  await assert.rejects(
    computers.create({ access: "read", browser: false, isolation: "none" }),
    (error) => {
      assert.ok(error instanceof ApiError);
      assert.deepEqual([error.status, error.message], [400, "none is attached, not made."]);
      return true;
    },
  );

  // Attached: the kind that attaches.
  const { computerID: attached } = await computers.attach({
    access: "read",
    browser: false,
    screen: false,
    workspace: data,
  });
  assert.deepEqual(
    [computers.get(attached).isolation, computers.get(attached).attached],
    ["none", true],
  );
});
