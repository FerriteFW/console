// Console's own files (public/: the bundled firmware, the fixed channel sets). The single-file build carries them
// inside the page (vite.config.js, "virtual:embedded"), since a page opened from disk can't fetch them; every other
// build fetches them as usual.
import embedded from "virtual:embedded";

const files = embedded as Record<string, string>;

/** `path` relative to the page ("firmware/manifest.json"). */
export async function appFetch(path: string, init?: RequestInit): Promise<Response> {
  const b64 = files[path.replace(/^\.?\//, "")];
  if (b64 === undefined) return fetch(path, init);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Response(bytes);
}
