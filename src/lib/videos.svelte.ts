// Videos (the More › Videos page, and the one Firmware Update plays while it runs): ferritefw.dev/video/index.json,
// the website's own list (as its /watch/ page), so a new video needs no new Console. Offline: none, and the page says
// where to watch them.
export const VIDEO_BASE = "https://ferritefw.dev/video/";

import { isTauri } from "./transport/native";
import { debugLog } from "./debuglog";

/** Whether this browser or desktop plays the videos (H.264 MP4). Linux's desktop app asks the shell first: WebKitGTK
 *  without GStreamer's pieces can hang on a `<video>` with no error to catch (`media_ok`), so none is created. */
async function canPlay(): Promise<boolean> {
  try {
    const v = document.createElement("video");
    if (!v.canPlayType('video/mp4; codecs="avc1.42E01E"')) return false;
    if (isTauri()) {
      const { invoke } = await import("@tauri-apps/api/core");
      return (await invoke<boolean>("media_ok")) === true;
    }
    return true;
  } catch {
    return false;
  }
}

export type Video = { file: string; title: string; length: string; line: string };

class Videos {
  list = $state<Video[]>([]);
  /** The video an update plays (index.json's `update`), or null. */
  update = $state<string | null>(null);
  state = $state<"idle" | "loading" | "ready" | "failed">("idle");
  /** Videos play here (canPlay); false until checked, so nothing plays before the check. */
  playable = $state(false);

  /** Fetches the list once (again after a failure). */
  async load(): Promise<void> {
    if (this.state === "loading" || this.state === "ready") return;
    this.state = "loading";
    try {
      this.playable = await canPlay();
      if (!this.playable) debugLog("videos: this system can't play them (no GStreamer video support?): links only");
      const r = await fetch(`${VIDEO_BASE}index.json`, { cache: "no-cache" });
      if (!r.ok) throw new Error(`${r.status}`);
      const j = (await r.json()) as { update?: string; videos?: Video[] };
      this.list = (j.videos ?? []).filter((v) => typeof v.file === "string" && /^[a-z0-9-]+$/.test(v.file));
      this.update = typeof j.update === "string" && /^[a-z0-9-]+$/.test(j.update) ? j.update : null;
      this.state = "ready";
    } catch {
      this.state = "failed";
    }
  }

  mp4(file: string) {
    return `${VIDEO_BASE}${file}.mp4`;
  }
  poster(file: string) {
    return `${VIDEO_BASE}${file}.jpg`;
  }
}

export const videos = new Videos();
