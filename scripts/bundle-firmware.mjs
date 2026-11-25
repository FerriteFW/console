// The Install and Update pages' bundled files: the Ferrite release and the reader image, copied into
// public/firmware/ with a manifest of their SHA-256s (UPD-15), which the pages check before using either. Never
// committed: the release build runs this, from the checkouts next to this one.
// The Ferrite release is its update file, .ffw (ferrite decision 335: the image and its SPI parts; a CI release's
// signature is inside it, checked by core/src/ffw.rs). A local build's .ffw is unsigned: Console takes it only with
// "Allow unsigned files" on. A bare image signed by Ferrite's CI (the reader) has <image>.minisig beside it: copied
// too, and its text goes in the manifest entry as `minisig` (core/src/signature.rs).
//   node scripts/bundle-firmware.mjs [ferrite.ffw] [reader.btf] [restorer.btf]
// Defaults: ../ferrite/target/ferrite-tx.ffw (tools/mkbtf.sh tx) and ../ferrite/target/ferrite-reader.btf
// (tools/mkbtf.sh reader: Ferrite's read-only reader, ferrite decision 264). The old C reader still works:
//   node scripts/bundle-firmware.mjs ../ferrite/target/ferrite-tx.btf ../fw/build/target/hwtest.btf
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [
  ferrite = join(root, "../ferrite/target/ferrite-tx.ffw"),
  reader = join(root, "../ferrite/target/ferrite-reader.btf"),
  // BACKUP-13: the restorer (Back to stock without Ferrite running), when there is one
  restorer = join(root, "../ferrite/target/ferrite-restorer.btf"),
] = process.argv.slice(2);
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

// The version Ferrite carries ("v0.1.0"): a .ffw's manifest says it; else read from its workspace (the image itself
// is encrypted in the .btf).
let version;
if (!ferrite.endsWith(".ffw")) {
  const cargo = readFileSync(join(root, "../ferrite/Cargo.toml"), "utf8");
  version = `v${cargo.match(/^version\s*=\s*"([^"]+)"/m)?.[1] ?? "?"}`;
} else {
  // manifest.json is the zip's first entry, stored: its bytes follow the 30-byte local header and the name.
  const z = readFileSync(ferrite);
  const at = 30 + z.readUInt16LE(26) + z.readUInt16LE(28);
  version = `v${JSON.parse(z.subarray(at, at + z.readUInt32LE(18)).toString("utf8")).version}`;
}
// The reader's version: Ferrite's for its own reader (built from the same workspace), "hwtest" for the C one.
const readerVersion = basename(reader).startsWith("ferrite-reader") ? `ferrite-reader ${version}` : "hwtest";
const manifest = { ferrite: { version, ...entry(ferrite) }, reader: { version: readerVersion, ...entry(reader) } };
if (existsSync(restorer)) manifest.restorer = { version: `ferrite-restorer ${version}`, ...entry(restorer) };
writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 1) + "\n");
const signed = (e) => (e.minisig || e.file.endsWith(".ffw") ? (e.file.endsWith(".ffw") ? " (its signature inside, if a release)" : " (signed)") : "");
console.log(
  `public/firmware: ${manifest.ferrite.file} (${version})${signed(manifest.ferrite)}, ${manifest.reader.file}${signed(manifest.reader)}` +
    (manifest.restorer ? `, ${manifest.restorer.file}${signed(manifest.restorer)}` : ", no restorer"),
);
