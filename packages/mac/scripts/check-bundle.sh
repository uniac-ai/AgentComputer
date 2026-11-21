#!/usr/bin/env bash
# The built app, checked file by file, as the Mac job and the release run check it: run from the
# repository's root, after `npm run app --workspace @agentorg/mac`. It needs a Mac, and no grant,
# person or signing identity: nothing of the app is registered or opened.
set -euxo pipefail
# The names the app is built under, from its brand file.
name="$(node -p "require('./packages/mac/brand.json').name")"
id="$(node -p "require('./packages/mac/brand.json').identifier")"
app="packages/mac/src-tauri/target/release/bundle/macos/$name.app"
plist="$app/Contents/Info.plist"
agent="$app/Contents/Library/LaunchAgents/$id.provider.plist"
read_key() { plutil -extract "$2" raw "$1"; }
pinned() { node -p "require('./packages/mac/$1')$2"; }
codesign --verify --deep --strict "$app"
test "$(read_key "$plist" CFBundleIdentifier)" = "$id"
# The app's version is the program's.
test "$(read_key "$plist" CFBundleShortVersionString)" = "$(node -p "require('./package.json').version")"
test "$(read_key "$plist" LSUIElement)" = true
test "$(read_key "$plist" CFBundleIconFile)" = icon.icns
cmp "$app/Contents/Resources/icon.icns" packages/mac/src-tauri/icons/icon.icns
# The background item: the one plist, as kept, naming the app's own program.
test "$(ls "$app/Contents/Library/LaunchAgents")" = "$id.provider.plist"
cmp "$agent" packages/mac/src-tauri/provider.plist
test -x "$app/$(read_key "$agent" BundleProgram)"
# Only the app's own program and Node in Contents/MacOS: the driver stays a resource.
test "$(ls "$app/Contents/MacOS" | tr '\n' ' ')" = "$name node "
# Each program the provider runs, signed on its own, with the hardened runtime.
for program in "$app/Contents/MacOS/node" "$app/Contents/Resources/cua-driver"; do
  codesign --verify --strict "$program"
  codesign -dv "$program" 2>&1 | grep -E "flags=0x[0-9a-f]+\([a-z,]*runtime"
done
# The service is this repository's program, as built here.
test "$(node -p "require('./$app/Contents/Resources/agentcomputer/package.json').version")" = "$(node -p "require('./package.json').version")"
cmp "$app/Contents/Resources/agentcomputer/dist/agentcomputer.js" dist/agentcomputer.js
# The notices of the crates the app's own program is built from, as the assembly wrote them, the
# lockfile's Tauri among them.
notices="Resources/licenses/$(tr '[:upper:]' '[:lower:]' <<<"$name")/THIRD_PARTY_LICENSES.txt"
cmp "$app/Contents/$notices" "packages/mac/src-tauri/target/assembly/bundle/$notices"
grep -q "^tauri $(awk '/^name = "tauri"$/ { getline; print $3 }' packages/mac/src-tauri/Cargo.lock | tr -d '"') (" "$app/Contents/$notices"
test "$("$app/Contents/MacOS/node" --version)" = "v$(pinned assembly.json .node.version)"
test "$("$app/Contents/Resources/cua-driver" --version)" = "cua-driver $(pinned assembly.json .driver.version)"
# The agents' pointer: the one theme, read back by the release's own compiler as the driver
# loads it, its id its file's name, with every action.
test "$(ls "$app/Contents/Resources/cursor-themes")" = "$id.pointer.cua-theme"
release="packages/mac/src-tauri/target/assembly/downloads/$(pinned assembly.json ".driver.file.replace(/[.]tar[.]gz$/, '')")"
inspected="$("$release/unpacked/$(pinned assembly.json .driver.compiler)" inspect "$app/Contents/Resources/cursor-themes/$id.pointer.cua-theme")"
grep -x "id: $id.pointer" <<<"$inspected"
grep -x "actions: 12" <<<"$inspected"
# The bundled Node runs JavaScript, and loads the terminal's native module, under its
# hardened runtime and entitlements.
"$app/Contents/MacOS/node" -e 'require(process.argv[1])' "$PWD/$app/Contents/Resources/agentcomputer/node_modules/node-pty"
# The app's own program runs and reaches macOS's background items, in a way that needs
# no grant. Nothing is registered here: macOS says so, or, as on CI's runners, that it
# knows no such item and won't unregister it.
said="$("$app/Contents/MacOS/$name" unregister 2>&1 || true)"
case "$said" in "the background item "*) ;; *) exit 1 ;; esac
# What a release signs, signing.json's programs: every Mach-O file in the bundle, the app's own
# program among them, each with its entitlements file, or none; each listed is there; and the
# bundle is the app's own.
set +x
test "$(node -p "require('./packages/mac/signing.json').bundle")" = "$name.app"
listed="$(node -p "Object.keys(require('./packages/mac/signing.json').programs).join('\n')")"
while IFS= read -r -d '' file; do
  path="${file#"$app/"}"
  if file -b "$file" | grep -q '^Mach-O'; then
    grep -qxF "$path" <<<"$listed" || { echo "$path isn't in signing.json" >&2; exit 1; }
  fi
done < <(find "$app" -type f -print0)
while IFS= read -r path; do
  test -e "$app/$path" || { echo "signing.json's $path isn't in the bundle" >&2; exit 1; }
done <<<"$listed"
for entitlements in $(node -p "Object.values(require('./packages/mac/signing.json').programs).filter(Boolean).join(' ')"); do
  plutil -lint "$entitlements"
done
echo "signing.json lists every Mach-O file the bundle carries, and nothing else"
