// One version for the repository's published packages: the program's and the SDK's.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// out/test/versions.test.js → the repository.
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (...path: string[]) => JSON.parse(readFileSync(join(root, ...path), "utf8"));

test("the SDK's package is the program's version, and the program's build takes that one", () => {
  const program = read("package.json");
  const sdk = read("packages", "sdk", "package.json");
  assert.equal(sdk.version, program.version);
  assert.equal(program.devDependencies["@agentorg/computer-sdk"], program.version);
});
