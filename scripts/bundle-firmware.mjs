// The Install page's bundled files: the Ferrite release and the hwtest reader image, copied into public/firmware/
// with a manifest of their SHA-256s (UPD-15), which the page checks before using either. Never committed: the
// release build runs this, from the checkouts next to this one.
//   node scripts/bundle-firmware.mjs [ferrite.btf] [reader.btf]
// Defaults: ../ferrite/target/ferrite-tx.btf (tools/mkbtf.sh tx) and ../fw/build/target/hwtest.btf.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [ferrite = join(root, "../ferrite/target/ferrite-tx.btf"), reader = join(root, "../fw/build/target/hwtest.btf")] = process.argv.slice(2);
const out = join(root, "public/firmware");
mkdirSync(out, { recursive: true });

function entry(path) {
  const b = readFileSync(path);
  writeFileSync(join(out, basename(path)), b);
  return { file: basename(path), sha256: createHash("sha256").update(b).digest("hex"), bytes: b.length };
}

// The version Ferrite carries ("v0.1.0"), read from its workspace (the image itself is encrypted in the .btf).
const cargo = readFileSync(join(root, "../ferrite/Cargo.toml"), "utf8");
const version = `v${cargo.match(/^version\s*=\s*"([^"]+)"/m)?.[1] ?? "?"}`;
const manifest = { ferrite: { version, ...entry(ferrite) }, reader: { version: "hwtest", ...entry(reader) } };
writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 1) + "\n");
console.log(`public/firmware: ${manifest.ferrite.file} (${version}), ${manifest.reader.file}`);
