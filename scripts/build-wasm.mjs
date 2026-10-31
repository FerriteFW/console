// Builds the Rust core for the browser: cargo (wasm32), then wasm-bindgen's JS glue into src/core-wasm/ (not in git).
// Needs the wasm32-unknown-unknown target (rust-toolchain.toml adds it) and wasm-bindgen-cli at the exact version
// wasm/Cargo.toml pins: `cargo install wasm-bindgen-cli --version 0.2.129 --locked`.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

const want = readFileSync("wasm/Cargo.toml", "utf8").match(/wasm-bindgen = "=([^"]+)"/)[1];
let have = "";
try {
  have = execFileSync("wasm-bindgen", ["--version"], { encoding: "utf8" }).trim().split(" ")[1];
} catch {
  console.error(`wasm-bindgen not found: cargo install wasm-bindgen-cli --version ${want} --locked`);
  process.exit(1);
}
if (have !== want) {
  console.error(`wasm-bindgen ${have}, the crate pins ${want}: cargo install wasm-bindgen-cli --version ${want} --locked`);
  process.exit(1);
}
const run = (cmd, args) => execFileSync(cmd, args, { stdio: "inherit" });
// The `wasm` profile (Cargo.toml): release, cut for size.
// Source paths the core keeps (panic locations) shown relative, not as this machine's folders: the checkouts'
// parent becomes ".", the home folder (cargo's registry, rustup's sources) "~". The last matching prefix wins.
const remap = [`--remap-path-prefix=${homedir()}=~`, `--remap-path-prefix=${resolve(process.cwd(), "..")}=.`];
process.env.RUSTFLAGS = [process.env.RUSTFLAGS, ...remap].filter(Boolean).join(" ");
run("cargo", ["build", "-p", "ferrite-console-wasm", "--target", "wasm32-unknown-unknown", "--profile", "wasm"]);
run("wasm-bindgen", [
  "target/wasm32-unknown-unknown/wasm/ferrite_console_wasm.wasm",
  "--target", "web", "--out-dir", "src/core-wasm", "--out-name", "core",
  // A third of the file, only for stack traces. Stripped here, not by cargo (strip = "symbols"), which would drop
  // target_features too and turn wasm-bindgen's returns back to the slower, larger glue without multivalue.
  "--remove-name-section", "--remove-producers-section",
]);
