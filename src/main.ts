import { mount } from "svelte";
import "./app.css";
import App from "./App.svelte";
import { DEV_TOOLS } from "./lib/devtools";
import { debugWatch } from "./lib/debuglog";

debugWatch();
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
