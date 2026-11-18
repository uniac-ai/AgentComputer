// The app's version is the program's: the one this repository's root package.json carries, which
// every release sets, so that the app and the service it carries say the same number.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const json = (url) => JSON.parse(readFileSync(url, "utf8"));

test("the app takes its version from the program's package, at the repository's root", () => {
  const configUrl = new URL("../src-tauri/tauri.conf.json", import.meta.url);
  const config = json(configUrl);
  const from = json(new URL(config.version, configUrl));
  assert.equal(from.name, "@agentorg/computer");
  assert.equal(from.version, json(new URL("../../../package.json", import.meta.url)).version);
  assert.match(from.version, /^\d+\.\d+\.\d+$/);
});
