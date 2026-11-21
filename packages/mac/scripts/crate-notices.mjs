// The notices of the crates the app's own program is built from, in the format of the program's
// THIRD_PARTY_LICENSES.txt: a section for each, headed `name version (licence)`, saying where its
// source is, with its licence files and NOTICE as the crate publishes them. The crates are those
// `cargo metadata` resolves for Apple silicon that the app's crate reaches by its normal and build
// dependencies, never by its dev-dependencies. A crate that publishes no licence file takes the
// texts kept in ../crate-licences under its repository's name; with neither, nothing is made.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const SEPARATOR = `\n${"=".repeat(72)}\n\n`;
const LICENCE = /^(licen[cs]e|copying|unlicense|notice|copyright)/i;
const CRATES_IO = "registry+https://github.com/rust-lang/crates.io-index";

/** The files of a folder, by name, that `wanted` takes, each with its path. */
const filesOf = (folder, wanted = () => true) =>
  readdirSync(folder)
    .filter((name) => wanted(name) && statSync(join(folder, name)).isFile())
    .sort()
    .map((name) => join(folder, name));

/** Of `cargo metadata`'s answer, the packages the root reaches but by dev-dependencies. */
export function crates(metadata) {
  const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
  const reached = new Set();
  const next = [metadata.resolve.root];
  while (next.length > 0)
    for (const dependency of nodes.get(next.pop()).deps)
      if (!reached.has(dependency.pkg) && dependency.dep_kinds.some(({ kind }) => kind !== "dev")) {
        reached.add(dependency.pkg);
        next.push(dependency.pkg);
      }
  return metadata.packages.filter(({ id }) => reached.has(id));
}

/** The notices of these crates, each section's texts from the crate's own folder, or `kept`. */
export function crateNotices(packages, kept) {
  const sections = packages.map(({ name, version, license, manifest_path, repository, source }) => {
    const heading = `${name} ${version} (${license})`;
    let files = filesOf(dirname(manifest_path), (file) => LICENCE.test(file));
    let from = "";
    if (files.length === 0) {
      const own = repository && basename(repository.replace(/(\.git)?\/*$/, ""));
      try {
        files = filesOf(join(kept, own));
      } catch {
        files = [];
      }
      if (!own || files.length === 0)
        throw new Error(
          `${heading} publishes no licence file, and none is kept for its repository, ${repository ?? "unnamed"}, in ${kept}.`,
        );
      from = `Its crate publishes no licence file: these are its repository's, ${repository}.\n\n`;
    }
    const where = source === CRATES_IO ? `https://crates.io/crates/${name}/${version}` : repository;
    const texts = files.map((file) => readFileSync(file, "utf8").trim()).join("\n\n");
    return [heading, `${heading}\n\nSource: ${where}\n\n${from}${texts}\n`];
  });
  return sections
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([, section]) => section)
    .join(SEPARATOR);
}
