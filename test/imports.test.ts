// Which of this repository's packages each package may import, as the structure's table has it:
// a package knows only what is below it. It reads the sources, every `import`, `export … from`
// and `import()`, so it needs no build. Third-party packages and Node's own are not judged.
//
// The program's own `src` has no rule yet: it is still the provider, the kinds and the inside in
// one. Until those are packages, the table's limits on them aren't held here. These edges the
// table forbids are in the code today:
// - `src/container.ts`, the containers kind, imports the browser;
// - `src/computers.ts`, the provider, imports the screen;
// - the provider tells the kinds apart by name, and imports this computer's setup, connection and
//   acting.
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

/** What each package may import of this repository's own, by name. */
const MAY: Record<string, string[]> = {
  "@agentorg/computer-contract": [],
  "@agentorg/computer-base": [],
  "@agentorg/exec": [],
  "@agentorg/computer-sdk": ["@agentorg/computer-contract", "@agentorg/computer-base"],
};

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
/** Each package with sources: its name, folder, and every import of its sources. */
const sourced = [...packages]
  .filter(([, folder]) => existsSync(join(root, folder, "src")))
  .map(([name, folder]) => ({
    name,
    folder,
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
            return named !== undefined && named !== name && !MAY[name]?.includes(named);
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
