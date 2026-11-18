//! The brand the app is built under, from `../brand.json`: its names reach the code as constants,
//! so that the app's code names no client. `tauri.conf.json` and `provider.plist` carry the same
//! values, as a test checks, since Tauri and macOS read those files themselves.

use std::fs;

fn main() {
    println!("cargo:rerun-if-changed=../brand.json");
    let read = fs::read_to_string("../brand.json").expect("the brand file, ../brand.json");
    let brand: serde_json::Value = serde_json::from_str(&read).expect("../brand.json is JSON");
    let text = |pointer: &str| {
        brand.pointer(pointer).and_then(|value| value.as_str()).map(str::to_string).unwrap_or_else(
            || panic!("../brand.json has no text at {pointer}"),
        )
    };
    for (name, pointer) in [
        ("BRAND_NAME", "/name"),
        ("BRAND_IDENTIFIER", "/identifier"),
        ("BRAND_DATA_FOLDER", "/dataFolder"),
        ("BRAND_CLIENT", "/client"),
        ("BRAND_OPEN_LABEL", "/open/label"),
        ("BRAND_OPEN_LAUNCHER", "/open/launcher"),
        ("BRAND_SETUP_IN", "/setupIn"),
        ("BRAND_CONTROLS_ENTRY", "/controls/entry"),
    ] {
        println!("cargo:rustc-env={name}={}", text(pointer));
    }
    // The launcher's arguments, one string with a unit separator between each.
    let args = brand.pointer("/open/args").and_then(|args| args.as_array()).map(|args| {
        args.iter().map(|arg| arg.as_str().expect("an argument is text")).collect::<Vec<_>>()
    });
    let args = args.expect("../brand.json has open.args").join("\u{1f}");
    println!("cargo:rustc-env=BRAND_OPEN_ARGS={args}");
    tauri_build::build()
}
