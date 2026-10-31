// The single-file build's embedded public files (vite.config.js): path -> base64; empty in other builds.
declare module "virtual:embedded" {
  const files: Record<string, string>;
  export default files;
}
