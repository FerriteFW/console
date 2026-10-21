import { mount } from "svelte";
import "./app.css";
import App from "./App.svelte";
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

mount(App, { target: document.getElementById("app")! });
