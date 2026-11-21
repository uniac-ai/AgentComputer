// The notices of the crates the app's own program is built from, over stand-ins for `cargo
// metadata`'s answer and the crates' folders. Nothing is fetched and nothing is built.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { crateNotices, crates } from "../scripts/crate-notices.mjs";

const CRATES_IO = "registry+https://github.com/rust-lang/crates.io-index";

/** A folder of files, by their paths, each holding what is given. */
function folder(t, held) {
  const root = mkdtempSync(join(tmpdir(), "crates-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, body] of Object.entries(held)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  return root;
}

/** A crate as `cargo metadata` lists it, its folder in `root`. */
const crate = (root, name, more = {}) => ({
  id: name,
  name,
  version: "1.0.0",
  license: "MIT",
  manifest_path: join(root, name, "Cargo.toml"),
  source: CRATES_IO,
  ...more,
});

test("the crates are those the app reaches by normal and build dependencies, not dev ones", () => {
  const edge = (pkg, ...kinds) => ({ pkg, dep_kinds: kinds.map((kind) => ({ kind })) });
  const metadata = {
    packages: ["app", "normal", "built", "both", "dev", "dev-only", "unreached"].map((id) => ({
      id,
    })),
    resolve: {
      root: "app",
      nodes: [
        { id: "app", deps: [edge("normal", null), edge("both", "dev", null), edge("dev", "dev")] },
        { id: "normal", deps: [edge("built", "build")] },
        { id: "built", deps: [] },
        { id: "both", deps: [] },
        { id: "dev", deps: [edge("dev-only", null)] },
        { id: "dev-only", deps: [] },
        { id: "unreached", deps: [] },
      ],
    },
  };
  assert.deepEqual(
    crates(metadata).map(({ id }) => id),
    ["normal", "built", "both"],
  );
});

test("each crate's section: where its source is, then its licence files and NOTICE", (t) => {
  const root = folder(t, {
    "zeta/Cargo.toml": "",
    "zeta/LICENSE-MIT": "zeta's MIT\n",
    "zeta/LICENSE-APACHE": "zeta's Apache\n",
    "zeta/NOTICE": "zeta's notice\n",
    "zeta/README.md": "not a licence",
    "alpha/Cargo.toml": "",
    "alpha/COPYING": "alpha's licence",
    "alpha/licenses/extra": "a folder isn't read",
  });
  const text = crateNotices(
    [
      crate(root, "zeta", { license: "MIT OR Apache-2.0" }),
      crate(root, "alpha", { source: undefined, repository: "https://example.com/alpha" }),
    ],
    join(root, "kept"),
  );
  assert.equal(
    text,
    [
      "alpha 1.0.0 (MIT)\n\nSource: https://example.com/alpha\n\nalpha's licence\n",
      "zeta 1.0.0 (MIT OR Apache-2.0)\n\nSource: https://crates.io/crates/zeta/1.0.0\n\n" +
        "zeta's Apache\n\nzeta's MIT\n\nzeta's notice\n",
    ].join(`\n${"=".repeat(72)}\n\n`),
  );
});

test("a crate that publishes no licence file takes the texts kept for its repository", (t) => {
  const root = folder(t, {
    "objc2/Cargo.toml": "",
    "kept/objc2/LICENSE.md": "the repository's statement",
    "kept/objc2/MIT.txt": "the MIT licence",
  });
  const repository = "https://github.com/madsmtm/objc2";
  assert.equal(
    crateNotices([crate(root, "objc2", { repository })], join(root, "kept")),
    "objc2 1.0.0 (MIT)\n\nSource: https://crates.io/crates/objc2/1.0.0\n\n" +
      `Its crate publishes no licence file: these are its repository's, ${repository}.\n\n` +
      "the repository's statement\n\nthe MIT licence\n",
  );
});

test("a crate with no licence file, and none kept for its repository, is refused in words", (t) => {
  const root = folder(t, { "bare/Cargo.toml": "", "kept/other/LICENSE": "another's" });
  const kept = join(root, "kept");
  assert.throws(
    () => crateNotices([crate(root, "bare", { repository: "https://github.com/x/bare" })], kept),
    {
      message: `bare 1.0.0 (MIT) publishes no licence file, and none is kept for its repository, https://github.com/x/bare, in ${kept}.`,
    },
  );
  assert.throws(() => crateNotices([crate(root, "bare")], kept), /its repository, unnamed, in /);
});
