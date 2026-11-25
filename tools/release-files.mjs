#!/usr/bin/env node
// A release's files, from tools/desktop-build.sh's target/desktop/ (DEVELOPING.md, "Releases"):
//   node tools/release-files.mjs --ffw ferrite-0.9.0.ffw [--protocol 1] [--notes ../docs/release-notes | --no-notes]
// -> target/desktop/release/: the installers under their release names, the update bundles and their signatures,
// Tauri's latest.json (Console's own updates, UPD-26: macOS, Apple silicon and Intel, and the Linux AppImage; Windows' portable .exe has none and
// links to the download) and feed.json (UPD-25, format `ferrite-feed-1`: the latest Ferrite and Console), which goes
// to ferritefw.dev/releases/latest.json with the .ffw beside it. The feed carries the last 5 Ferrite releases' notes
// (UPD-25.2, `ferrite.notes`, from the docs repo's release-notes/X.Y.Z.md: tools/release-notes.mjs), so Update shows
// the notes of the very release it offers; Consoles before 0.9.8 ignore the field.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { releaseNotes } from "./release-notes.mjs";

const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const here = new URL("..", import.meta.url).pathname;
const version = JSON.parse(readFileSync(join(here, "package.json"), "utf8")).version;
const tag = `v${version}`;
const from = join(here, "target/desktop");
const out = join(from, "release");
const dl = `https://github.com/FerriteFW/console/releases/download/${tag}`;
const site = "https://ferritefw.dev/releases";

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const files = readdirSync(from);
const one = (re, what) => {
  const f = files.filter((x) => re.test(x));
  if (f.length !== 1) throw new Error(`${what}: ${f.length ? f.join(", ") : "none"} in target/desktop (one wanted)`);
  return f[0];
};
const put = (src, name) => (copyFileSync(join(from, src), join(out, name)), name);

const dmg = put(one(new RegExp(`_${version}_.*\\.dmg$`), "the .dmg"), `Ferrite-Console-${version}-macos-universal.dmg`);
const appimage = put(one(new RegExp(`_${version}_.*\\.AppImage$`), "the AppImage"), `Ferrite-Console-${version}-linux-x86_64.AppImage`);
const rpm = put(one(new RegExp(`-${version}-.*\\.rpm$`), "the .rpm"), `Ferrite-Console-${version}-linux-x86_64.rpm`);
const exe = put(one(/portable\.exe$/, "the portable .exe"), `Ferrite-Console-${version}-windows-x64-portable.exe`);
const app = put(one(/\.app\.tar\.gz$/, "the macOS update bundle"), `Ferrite-Console-${version}-macos-universal.app.tar.gz`);
const sig = (f) => readFileSync(join(from, f), "utf8").trim();
const appSig = sig(one(/\.app\.tar\.gz\.sig$/, "its signature"));
const imgSig = sig(one(new RegExp(`_${version}_.*\\.AppImage\\.sig$`), "the AppImage's signature"));

writeFileSync(
  join(out, "latest.json"),
  JSON.stringify(
    {
      version,
      notes: `Ferrite Console ${version}: https://github.com/FerriteFW/console/releases/tag/${tag}`,
      pub_date: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
      platforms: {
        // one universal app (Apple silicon and Intel): the same bundle for both
        "darwin-aarch64": { signature: appSig, url: `${dl}/${app}` },
        "darwin-x86_64": { signature: appSig, url: `${dl}/${app}` },
        "linux-x86_64": { signature: imgSig, url: `${dl}/${appimage}` },
      },
    },
    null,
    1,
  ) + "\n",
);

const ffw = opt("--ffw");
if (ffw) {
  if (!existsSync(ffw)) throw new Error(`no ${ffw}`);
  const bytes = readFileSync(ffw);
  const m = /(\d+\.\d+\.\d+)/.exec(basename(ffw));
  if (!m) throw new Error(`${ffw}: no version in the name`);
  const file = `ferrite-${m[1]}.ffw`;
  copyFileSync(ffw, join(out, file));
  const notes = args.includes("--no-notes") ? undefined : releaseNotes(opt("--notes", join(here, "../docs/release-notes")), m[1]);
  const feed = {
    format: "ferrite-feed-1",
    ferrite: { version: m[1], protocol: Number(opt("--protocol", "1")), file, url: `${site}/${file}`, sha256: createHash("sha256").update(bytes).digest("hex"), notes },
    console: { version },
  };
  writeFileSync(join(out, "feed.json"), JSON.stringify(feed, null, 1) + "\n");
}
console.log([dmg, appimage, rpm, exe, app, "latest.json", ...(ffw ? ["feed.json"] : [])].join("\n"));
