// What the service keeps in its data folder, every file readable only by its owner.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const newToken = () => randomBytes(32).toString("base64url");
export const digestOf = (token: string) => createHash("sha256").update(token).digest("hex");
export const sameToken = (token: string, digest: string) =>
  timingSafeEqual(Buffer.from(digestOf(token), "hex"), Buffer.from(digest, "hex"));

export function writePrivate(file: string, text: string) {
  writeFileSync(`${file}.tmp`, text, { mode: 0o600, flush: true });
  renameSync(`${file}.tmp`, file);
  chmodSync(file, 0o600);
}

export const privateFolder = (dir: string) => {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
};

/** The control token, made at first start and kept for the person to read. */
export function controlToken(data: string): string {
  const file = join(data, "control-token");
  try {
    return readFileSync(file, "utf8").trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const token = newToken();
  writePrivate(file, `${token}\n`);
  return token;
}
