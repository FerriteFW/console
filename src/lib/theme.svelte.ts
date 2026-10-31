// The theme: Light, Dark, or Auto (follow the system). `mode` is the choice (kept in localStorage); the page gets the
// one it resolves to as <html data-theme>, and Auto follows the system's setting as it changes. A `?theme=` in the
// address (screenshots, tests) wins for that visit.

export type ThemeMode = "auto" | "light" | "dark";

const KEY = "theme";
const system = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null;

function stored(): ThemeMode {
  try {
    const t = new URLSearchParams(location.search).get("theme") ?? localStorage.getItem(KEY);
    return t === "light" || t === "dark" || t === "auto" ? t : "auto";
  } catch {
    return "auto";
  }
}

class Theme {
  mode = $state<ThemeMode>(stored());
  /** What's shown now: the choice, or the system's under Auto. */
  shown = $state<"light" | "dark">("dark");

  constructor() {
    this.apply();
    system?.addEventListener("change", () => this.apply());
  }

  set(mode: ThemeMode) {
    this.mode = mode;
    try {
      localStorage.setItem(KEY, mode);
    } catch {
      /* not kept */
    }
    this.apply();
  }

  private apply() {
    this.shown = this.mode === "auto" ? (system?.matches === false ? "light" : "dark") : this.mode;
    document.documentElement.dataset.theme = this.shown;
  }
}

export const theme = new Theme();
