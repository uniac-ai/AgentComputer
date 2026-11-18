// Which of this repository's packages each package may import, as the structure's table has it:
// a package knows only what is below it. It reads the sources, every `import`, `export … from`
// and `import()`, so it needs no build. Third-party packages and Node's own are not judged.
//
// The provider knows the kinds only by the seam, and each kind knows only the seam of it; this
// computer may know the parts, a container's kind only the client of what runs inside it. The
// program's own `src` is where they are put together, and may take any of them.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// out/test/imports.test.js → the repository.
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (...path: string[]) => JSON.parse(readFileSync(join(root, ...path), "utf8"));

/** Each package of the workspace with sources, by name: its folder. */
const packages = new Map<string, string>(
  (read("package.json").workspaces as string[])
    .flatMap((pattern) =>
      pattern.endsWith("/*")
        ? readdirSync(join(root, pattern.slice(0, -2))).map(
            (one) => `${pattern.slice(0, -2)}/${one}`,
          )
        : [pattern],
    )
    .filter((folder) => existsSync(join(root, folder, "package.json")))
    .map((folder) => [read(folder, "package.json").name as string, folder]),
);
/** This repository's own names: every package of the workspace, and the program's. */
const ours = [read("package.json").name as string, ...packages.keys()];

/**
 * What each package may import of this repository's own: a package by its name, any of it, or one
 * subpath of one, that alone.
 */
const MAY: Record<string, string[]> = {
  "@agentorg/computer-contract": [],
  "@agentorg/computer-base": [],
  "@agentorg/exec": [],
  "@agentorg/computer-sdk": ["@agentorg/computer-contract", "@agentorg/computer-base"],
  "@agentorg/computer-browser": ["@agentorg/computer-contract", "@agentorg/computer-base"],
  "@agentorg/computer-screen": ["@agentorg/computer-contract", "@agentorg/computer-base"],
  "@agentorg/computer-inside": [
    "@agentorg/exec",
    "@agentorg/computer-browser",
    "@agentorg/computer-screen",
    "@agentorg/computer-contract",
    "@agentorg/computer-base",
  ],
  "@agentorg/computer-provider": ["@agentorg/computer-contract", "@agentorg/computer-base"],
  "@agentorg/computer-this-computer": [
    "@agentorg/computer-provider/seam",
    "@agentorg/computer-inside",
    "@agentorg/computer-browser",
    "@agentorg/computer-screen",
    "@agentorg/computer-contract",
    "@agentorg/computer-base",
  ],
  "@agentorg/computer-containers": [
    "@agentorg/computer-provider/seam",
    "@agentorg/computer-inside/client",
    "@agentorg/computer-contract",
    "@agentorg/computer-base",
  ],
};
/** The program, its own `src`: where the pieces are put together. It may take any of them. */
const PROGRAM = read("package.json").name as string;

/** Every source file below `folder`. */
const sources = (folder: string): string[] =>
  readdirSync(folder).flatMap((entry) => {
    const path = join(folder, entry);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(?:[cm]?[jt]sx?)$/.test(entry) ? [path] : [];
  });
/** What a file imports, as written. */
const imports = (file: string) => {
  const text = readFileSync(file, "utf8");
  return [
    ...text.matchAll(/\bfrom\s*["']([^"']+)["']/g),
    ...text.matchAll(/^\s*import\s*["']([^"']+)["']/gm),
    ...text.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g),
  ].map((match) => match[1] as string);
};
/** The package of ours a specifier names, or `undefined` for anyone else's. */
const ourName = (specifier: string) =>
  ours.find((name) => specifier === name || specifier.startsWith(`${name}/`));
/** Each package with sources, the program's among them: its name, folder, and every import. */
const sourced = [...packages, [PROGRAM, "."] as [string, string]]
  .filter(([, folder]) => existsSync(join(root, folder, "src")))
  .map(([name, folder]) => ({
    name,
    // The program's own folder is its `src`: the packages around it aren't its to reach into.
    folder: folder === "." ? "src" : folder,
    found: sources(join(root, folder, "src")).flatMap((file) =>
      imports(file).map((specifier) => ({ file: relative(root, file), specifier })),
    ),
  }));

test("each package imports of this repository only what the table lets it", () => {
  assert.deepEqual(
    Object.keys(MAY).filter((name) => !sourced.some((one) => one.name === name)),
    [],
    "every package the table names is here, with sources",
  );
  const refused = sourced.flatMap(({ name, found }) =>
    name in MAY
      ? found
          .filter(({ specifier }) => {
            const named = ourName(specifier);
            const may = MAY[name] ?? [];
            return (
              named !== undefined &&
              named !== name &&
              !may.includes(named) &&
              !may.includes(specifier)
            );
          })
          .map(({ file, specifier }) => `${file} imports ${specifier}`)
      : [],
  );
  assert.deepEqual(refused, []);
});

test("no package reaches outside its own folder, or into the Mac app's packages", () => {
  const mac = ["@agentorg/mac", "@agentorg/mac-window"];
  const refused = sourced.flatMap(({ name, folder, found }) =>
    found
      .filter(({ file, specifier }) => {
        if (specifier.startsWith(".")) {
          const target = resolve(root, dirname(file), specifier);
          return !target.startsWith(join(root, folder) + sep);
        }
        const named = ourName(specifier);
        return named !== undefined && named !== name && mac.includes(named);
      })
      .map(({ file, specifier }) => `${file} imports ${specifier}`),
  );
  assert.deepEqual(refused, []);
});

test("the test reads what the packages import", () => {
  const sdk = sourced.find(({ name }) => name === "@agentorg/computer-sdk");
  assert.deepEqual(
    [...new Set(sdk?.found.map(({ specifier }) => ourName(specifier)).filter(Boolean))].sort(),
    ["@agentorg/computer-base", "@agentorg/computer-contract"],
  );
});
