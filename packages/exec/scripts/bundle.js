// Single files with nothing to install: `agentexec.js` for a host to run, and `lib.js` for one to
// mount. The licences of what is bundled into them go beside them, each with its NOTICE.
import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";

const bundle = (entry, outfile, banner = "") =>
  build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    outfile,
    metafile: true,
    banner: { js: banner },
    legalComments: "none",
  });
const results = [
  await bundle("src/main.ts", "dist/agentexec.js", "#!/usr/bin/env node"),
  await bundle("src/lib.ts", "dist/lib.js"),
];
copyFileSync("out/src/lib.d.ts", "dist/lib.d.ts");

const folders = new Set();
for (const input of results.flatMap(({ metafile }) => Object.keys(metafile.inputs))) {
  const match = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(input);
  if (match) folders.add(match[1]);
}
const sections = [...folders].sort().map((folder) => {
  const { name, version, license } = JSON.parse(readFileSync(join(folder, "package.json"), "utf8"));
  const entries = readdirSync(folder);
  const file = entries.find((entry) => /^(licen[cs]e|copying)/i.test(entry));
  if (!file && !existsSync(join(folder, "LICENSE")))
    return `${name} ${version} (${license})\nSee https://www.npmjs.com/package/${name}\n`;
  // Its NOTICE, when it has one, after its licence.
  const notice = entries.find((entry) => /^notice(\.|$)/i.test(entry));
  const texts = [file, ...(notice ? [notice] : [])].map((entry) =>
    readFileSync(join(folder, entry), "utf8").trim(),
  );
  return `${name} ${version} (${license})\n\n${texts.join("\n\n")}\n`;
});
writeFileSync("dist/THIRD_PARTY_LICENSES.txt", sections.join(`\n${"=".repeat(72)}\n\n`));
console.log(`Bundled ${folders.size} packages.`);
