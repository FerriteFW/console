import { mount } from "svelte";
import "./app.css";
import App from "./App.svelte";
import { DEV_TOOLS } from "./lib/devtools";
import { debugWatch } from "./lib/debuglog";

debugWatch();

// The desktop app's webview opens no links itself (the update notice's download link and the user guide did
// nothing, Nov 17, 2026): an https link goes to the system's browser (the shell's open_url).
import { isTauri } from "./lib/transport/native";
if (isTauri()) {
  document.addEventListener(
    "click",
    (e) => {
      const a = (e.target as HTMLElement | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || !/^https:\/\//.test(a.href)) return;
      e.preventDefault();
      void import("@tauri-apps/api/core").then(({ invoke }) => invoke("open_url", { url: a.href })).catch((err) => console.error("open_url:", err));
    },
    true,
  );
}
import logo from "@ferrite/assets/logo/ferrite-icon.svg?url";

const icon = document.createElement("link");
icon.rel = "icon";
icon.href = logo;
document.head.append(icon);

// The theme (Light, Dark or Auto), applied before the app mounts.
import "./lib/theme.svelte";

// LINK-19.4: the Live View screen alone, for the completeness test (src/lib/harness).
if (DEV_TOOLS && new URLSearchParams(location.search).has("readback-harness")) {
  import("./lib/harness/ReadbackHarness.svelte").then((m) => mount(m.default, { target: document.getElementById("app")! }));
} else {
  mount(App, { target: document.getElementById("app")! });
}
