// The developer tools (the demo radio, the bridge, the readback harness): in `npm run dev` and in a build made with
// VITE_DEV_TOOLS=1 (the e2e tests' build), never in a release build (`npm run build`, the desktop app).
export const DEV_TOOLS: boolean = import.meta.env.DEV || import.meta.env.VITE_DEV_TOOLS === "1";
