// The app Cua Driver is inside, where it is in one: the Mac holds the driver's grants under the
// outermost app, and lists them in System Settings by that app's name.
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { basename, join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

/**
 * The outermost app the driver is inside, which the Mac holds its grants under, and, where the
 * driver is that app's own program, as CuaDriver's is, its place there.
 */
const IN_APP = /^(.*?\/[^/]+\.app)\/Contents\/(MacOS\/[^/]+$)?/;

/** One string in an app's Info.plist, where it has it. */
export async function infoValue(app: string, key: string) {
  const plist = join(app, "Contents", "Info.plist");
  try {
    return (
      await exec("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", plist])
    ).stdout.trim();
  } catch {
    return undefined;
  }
}

/**
 * The app the driver is inside, where it is in one: its name, as System Settings lists the grants
 * and as the person is sent to it, and whether the driver is its own program. None where the
 * driver's path can't be followed, as when it has gone.
 */
export async function driverApp(program: string) {
  let path: string;
  try {
    path = realpathSync(program);
  } catch {
    return undefined;
  }
  const found = IN_APP.exec(path);
  if (!found) return undefined;
  const app = found[1] as string;
  const name =
    (await infoValue(app, "CFBundleDisplayName")) ??
    (await infoValue(app, "CFBundleName")) ??
    basename(app, ".app");
  return { app, name, own: found[2] !== undefined };
}
