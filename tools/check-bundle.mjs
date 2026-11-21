// UPD-27: a release build bundles only a signed reader and restorer. Console 0.9.5 refuses an unsigned bundled
// image, so a build made with ../ferrite/target's local ones would break Install, backup and Back to stock for
// everyone (the 0.9.5 review, Nov 21, 2026). tools/desktop-build.sh runs this unless UNSIGNED=1.
//   node tools/check-bundle.mjs public/firmware/manifest.json
import { readFileSync } from "node:fs";
const m = JSON.parse(readFileSync(process.argv[2], "utf8"));
const unsigned = ["reader", "restorer"].filter((k) => !m[k]?.minisig);
if (unsigned.length) {
  console.error(`bundle: not signed: ${unsigned.join(", ")}. Give FIRMWARE= the CI release's files, or UNSIGNED=1 for a local test build.`);
  process.exit(1);
}
