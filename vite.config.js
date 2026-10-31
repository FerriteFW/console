import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { fileURLToPath } from "node:url";
import { readFileSync, readdirSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { viteSingleFile } from "vite-plugin-singlefile";

// Ferrite's fonts and logo are used from the ferrite checkout next to this one (../ferrite), not copied.
const ferrite = fileURLToPath(new URL("../ferrite", import.meta.url));
// Console's version (package.json), for the .ferrite codeplug's manifest.
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

// public/'s runtime files (the bundled firmware, the fixed channel sets) for the single-file build, as
// "virtual:embedded": path -> base64. Opened from disk (file://) the page can't fetch them; appfetch.ts reads them
// from here instead. Every other build gets an empty map and fetches as usual.
function embedded(single) {
  const id = "virtual:embedded";
  return {
    name: "ferrite-embedded",
    resolveId: (x) => (x === id ? "\0" + id : null),
    load(x) {
      if (x !== "\0" + id) return null;
      const files = {};
      if (single) {
        for (const dir of ["firmware", "data"]) {
          const d = new URL(`./public/${dir}/`, import.meta.url);
          if (!existsSync(d)) continue;
          for (const f of readdirSync(d)) files[`${dir}/${f}`] = readFileSync(new URL(f, d)).toString("base64");
        }
      }
      return `export default ${JSON.stringify(files)};`;
    },
  };
}

// What each build carries of public/firmware (scripts/bundle-firmware.mjs: the Ferrite release and the reader).
// The downloads (the desktop app: --mode app; the single file: --mode single) keep the release; the website build
// (the default) drops it and keeps only the reader (the Install wizard's backup step), so the page offers a file to
// pick until it fetches the GitHub release.
function webFirmware(keep) {
  return {
    name: "ferrite-web-firmware",
    apply: "build",
    closeBundle() {
      if (keep) return;
      const dir = new URL("./dist/firmware/", import.meta.url);
      const m = new URL("manifest.json", dir);
      if (!existsSync(m)) return;
      const manifest = JSON.parse(readFileSync(m, "utf8"));
      if (manifest.ferrite) {
        for (const f of [manifest.ferrite.file, `${manifest.ferrite.file}.minisig`]) rmSync(new URL(f, dir), { force: true });
        delete manifest.ferrite;
        writeFileSync(m, JSON.stringify(manifest, null, 1) + "\n");
      }
    },
  };
}

// `vite build --mode single` (npm run build:single): Console as one HTML file that runs opened from disk, everything
// inlined (scripts, styles, fonts, the wasm core, the firmware), in dist-single/.
export default defineConfig(({ mode }) => ({
  // Relative asset paths in the single file, so BASE_URL ("./") also prefixes the embedded paths appfetch.ts strips.
  base: mode === "single" ? "./" : "/",
  plugins: [svelte(), embedded(mode === "single"), webFirmware(mode === "app" || mode === "single"), ...(mode === "single" ? [viteSingleFile()] : [])],
  define: { __CONSOLE_VERSION__: JSON.stringify(pkg.version) },
  resolve: { alias: { "@ferrite": ferrite } },
  clearScreen: false,
  // Tauri's dev server convention: a fixed port the shell loads (src-tauri/tauri.conf.json devUrl).
  server: { port: 1420, strictPort: true, fs: { allow: [".", ferrite] } },
  build:
    mode === "single"
      ? { target: "es2022", outDir: "dist-single", assetsInlineLimit: 100_000_000, copyPublicDir: false }
      : { target: "es2022", assetsInlineLimit: 0 },
}));
