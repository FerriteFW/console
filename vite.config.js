import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

// Ferrite's fonts and logo are used from the ferrite checkout next to this one (../ferrite), not copied.
const ferrite = fileURLToPath(new URL("../ferrite", import.meta.url));
// Console's version (package.json), for the .ferrite codeplug's manifest.
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

export default defineConfig({
  plugins: [svelte()],
  define: { __CONSOLE_VERSION__: JSON.stringify(pkg.version) },
  resolve: { alias: { "@ferrite": ferrite } },
  clearScreen: false,
  // Tauri's dev server convention: a fixed port the shell loads (src-tauri/tauri.conf.json devUrl).
  server: { port: 1420, strictPort: true, fs: { allow: [".", ferrite] } },
  build: { target: "es2022", assetsInlineLimit: 0 },
});
