import { mount } from "svelte";
import "./app.css";
import App from "./App.svelte";
import { DEV_TOOLS } from "./lib/devtools";
import logo from "@ferrite/assets/logo/ferrite-icon.svg?url";

const icon = document.createElement("link");
icon.rel = "icon";
icon.href = logo;
document.head.append(icon);

try {
  const t = new URLSearchParams(location.search).get("theme") ?? localStorage.getItem("theme");
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
} catch {
  /* storage blocked: dark */
}

// LINK-19.4: the Live View screen alone, for the completeness test (src/lib/harness).
if (DEV_TOOLS && new URLSearchParams(location.search).has("readback-harness")) {
  import("./lib/harness/ReadbackHarness.svelte").then((m) => mount(m.default, { target: document.getElementById("app")! }));
} else {
  mount(App, { target: document.getElementById("app")! });
}
