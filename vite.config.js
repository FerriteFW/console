import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { fileURLToPath } from "node:url";
import { readFileSync, readdirSync, existsSync } from "node:fs";
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

// `vite build --mode single` (npm run build:single): Console as one HTML file that runs opened from disk, everything
// inlined (scripts, styles, fonts, the wasm core, the firmware), in dist-single/.
export default defineConfig(({ mode }) => ({
  // Relative asset paths in the single file, so BASE_URL ("./") also prefixes the embedded paths appfetch.ts strips.
  base: mode === "single" ? "./" : "/",
  plugins: [svelte(), embedded(mode === "single"), ...(mode === "single" ? [viteSingleFile()] : [])],
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
