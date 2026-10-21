// Builds the Rust core for the browser: cargo (wasm32), then wasm-bindgen's JS glue into src/core-wasm/ (not in git).
// Needs the wasm32-unknown-unknown target (rust-toolchain.toml adds it) and wasm-bindgen-cli at the exact version
// wasm/Cargo.toml pins: `cargo install wasm-bindgen-cli --version 0.2.129 --locked`.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

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
run("cargo", ["build", "-p", "ferrite-console-wasm", "--target", "wasm32-unknown-unknown", "--release"]);
run("wasm-bindgen", [
  "target/wasm32-unknown-unknown/release/ferrite_console_wasm.wasm",
  "--target", "web", "--out-dir", "src/core-wasm", "--out-name", "core",
]);
