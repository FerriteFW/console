import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { fileURLToPath } from "node:url";

// Ferrite's fonts and logo are used from the ferrite checkout next to this one (../ferrite), not copied.
const ferrite = fileURLToPath(new URL("../ferrite", import.meta.url));

export default defineConfig({
  plugins: [svelte()],
  resolve: { alias: { "@ferrite": ferrite } },
  clearScreen: false,
  // Tauri's dev server convention: a fixed port the shell loads (src-tauri/tauri.conf.json devUrl).
  server: { port: 1420, strictPort: true, fs: { allow: [".", ferrite] } },
  build: { target: "es2022", assetsInlineLimit: 0 },
});
