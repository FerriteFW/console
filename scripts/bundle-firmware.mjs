// The Install page's bundled files: the Ferrite release and the reader image, copied into public/firmware/ with a
// manifest of their SHA-256s (UPD-15), which the page checks before using either. Never committed: the release
// build runs this, from the checkouts next to this one.
// A release image signed by Ferrite's CI has <image>.minisig beside it: copied too, and its text goes in the
// manifest entry as `minisig`, which Console checks against Ferrite's public key (core/src/signature.rs).
//   node scripts/bundle-firmware.mjs [ferrite.btf] [reader.btf]
// Defaults: ../ferrite/target/ferrite-tx.btf (tools/mkbtf.sh tx) and ../ferrite/target/ferrite-reader.btf
// (tools/mkbtf.sh reader: Ferrite's read-only reader, ferrite decision 264). The old C reader still works:
//   node scripts/bundle-firmware.mjs ../ferrite/target/ferrite-tx.btf ../fw/build/target/hwtest.btf
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [ferrite = join(root, "../ferrite/target/ferrite-tx.btf"), reader = join(root, "../ferrite/target/ferrite-reader.btf")] = process.argv.slice(2);
const out = join(root, "public/firmware");
// Only what the manifest lists: older runs' leftovers (bench or test images) never ride along.
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

function entry(path) {
  const b = readFileSync(path);
  writeFileSync(join(out, basename(path)), b);
  const e = { file: basename(path), sha256: createHash("sha256").update(b).digest("hex"), bytes: b.length };
  if (existsSync(`${path}.minisig`)) {
    e.minisig = readFileSync(`${path}.minisig`, "utf8");
    writeFileSync(join(out, `${basename(path)}.minisig`), e.minisig);
  }
  return e;
}

// The version Ferrite carries ("v0.1.0"), read from its workspace (the image itself is encrypted in the .btf).
const cargo = readFileSync(join(root, "../ferrite/Cargo.toml"), "utf8");
const version = `v${cargo.match(/^version\s*=\s*"([^"]+)"/m)?.[1] ?? "?"}`;
// The reader's version: Ferrite's for its own reader (built from the same workspace), "hwtest" for the C one.
const readerVersion = basename(reader).startsWith("ferrite-reader") ? `ferrite-reader ${version}` : "hwtest";
const manifest = { ferrite: { version, ...entry(ferrite) }, reader: { version: readerVersion, ...entry(reader) } };
writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 1) + "\n");
const signed = (e) => (e.minisig ? " (signed)" : "");
console.log(`public/firmware: ${manifest.ferrite.file} (${version})${signed(manifest.ferrite)}, ${manifest.reader.file}${signed(manifest.reader)}`);
