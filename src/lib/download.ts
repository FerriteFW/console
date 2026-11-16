// A file "downloaded": in a browser an <a download> link; in the desktop app the shell's save_download, which writes
// it to the Downloads folder (the app's webview drops <a download> links: CHIRP export did nothing there, and the
// backup a write saves first never landed; Nov 16, 2026).
import { isTauri } from "./transport/native";

/** Saves `blob` as `name` in the downloads: where it went (the desktop app's path, or the name in a browser). Throws
 *  when the desktop app couldn't write it. */
export async function saveDownload(name: string, blob: Blob): Promise<string> {
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return await invoke<string>("save_download", bytes, { headers: { "x-name": name } });
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return name;
}
