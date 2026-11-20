// The brand the app is built under, in brand.json, and nowhere else in its code: Tauri's config and
// the background item's plist, which Tauri and macOS read themselves, carry the same values, and no
// string in the app's code, the window's page or their scripts names it. Comments, tests and
// documentation may.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const brand = JSON.parse(read("brand.json"));

test("Tauri's config and the background item's plist carry the brand's values", () => {
  const config = JSON.parse(read("src-tauri/tauri.conf.json"));
  assert.equal(config.productName, brand.name);
  assert.equal(config.mainBinaryName, brand.name);
  assert.equal(config.identifier, brand.identifier);
  assert.deepEqual(
    config.app.windows.map((window) => window.title),
    [brand.name],
  );
  assert.deepEqual(config.bundle.icon, [brand.icon.icns, brand.icon.png]);
  assert.equal(
    config.bundle.macOS.files[`Library/LaunchAgents/${brand.identifier}.provider.plist`],
    "provider.plist",
  );
  const plist = read("src-tauri/provider.plist");
  const string = (key) => new RegExp(`<key>${key}</key><string>([^<]*)</string>`).exec(plist)?.[1];
  const strings = (key) =>
    [
      ...(new RegExp(`<key>${key}</key><array>(.*?)</array>`).exec(plist)?.[1] ?? "").matchAll(
        /<string>([^<]*)<\/string>/g,
      ),
    ].map((found) => found[1]);
  assert.equal(string("Label"), `${brand.identifier}.provider`);
  assert.equal(string("BundleProgram"), `Contents/MacOS/${brand.name}`);
  assert.deepEqual(strings("ProgramArguments"), [brand.name, "--provider"]);
  assert.deepEqual(strings("AssociatedBundleIdentifiers"), [brand.identifier]);
});

test("what a release signs names the app as the brand does", () => {
  const signing = JSON.parse(read("signing.json"));
  assert.equal(signing.bundle, `${brand.name}.app`);
  assert.ok(Object.hasOwn(signing.programs, `Contents/MacOS/${brand.name}`));
});

/** Each file under `folder`, by its path from the package's folder. */
const under = (folder) =>
  readdirSync(new URL(`../${folder}`, import.meta.url), { recursive: true, withFileTypes: true })
    .filter((one) => one.isFile())
    .map((one) => join(one.parentPath, one.name));

test("no string in the app's code, its page or their scripts names the brand", () => {
  const names = [brand.name, brand.identifier, brand.dataFolder, brand.client, brand.open.launcher];
  const files = [
    ...under("src-tauri/src").filter((path) => path.endsWith(".rs")),
    ...under("scripts").filter((path) => path.endsWith(".mjs")),
    ...under("../mac-window/src").filter((path) => /\.tsx?$/.test(path) && !path.includes("/ui/")),
    ...under("../mac-window/scripts"),
  ];
  assert.ok(files.length >= 15, `only ${files.length} files found`);
  const found = [];
  for (const path of files) {
    // A Rust file's tests, at its end, may name it.
    const code = readFileSync(path, "utf8").split(/\n#\[cfg\(test\)\]\nmod tests/)[0];
    code.split("\n").forEach((line, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
      for (const literal of line.matchAll(/"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`|'(?:[^'\\]|\\.)*'/g))
        if (names.some((name) => literal[0].toLowerCase().includes(name.toLowerCase())))
          found.push(`${path}:${i + 1}: ${literal[0]}`);
    });
  }
  assert.deepEqual(found, []);
});
