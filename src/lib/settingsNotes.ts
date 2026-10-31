// Radio Settings' words around the core's view (pure: unit-tested in tests/unit/settingsNotes.test.ts). The core
// says which settings the link never changes ("changes only on the radio": LINK-5, LINK-7) and which menu items are
// shown on the radio only (a group's note); this says why, in a line each, and turns the items Console edits
// elsewhere (the range presets, MENU 0 1 4) into links there.
import type { SettingItem, SettingsGroup } from "./core";

/** The core's note on a setting the link never writes (core/src/settings.rs RADIO_ONLY). */
export const RADIO_ONLY = "changes only on the radio";

/** Why each deliberate one is set on the radio only, by its name as the menu shows it. */
const WHY: [RegExp, string][] = [
  [/^region$/i, "Set on the radio, for safety: the region decides where it may transmit."],
  [/^extend tx$/i, "Set on the radio, for safety: it widens where the radio may transmit."],
  [/^(pin lock|change pin)$/i, "Set on the radio: the PIN never goes over the link."],
  [/^channel-only mode$/i, "Part of the PIN lock: set on the radio, never over the link."],
  [/^cable port$/i, "Set on the radio: changing it here would cut this connection."],
  [/^kiss( tnc| port)?$/i, "Set on the radio: turning KISS on here would cut this connection (the port goes to a TNC program)."],
];

/** Dry TX (TX-48): in no record, shown in the Transmit group's note. */
const DRY_TX = "Bench key-ups with no RF (the power amplifier held at zero), never saved: the PC may turn it on, only the radio turns it off.";

/** A read-only setting's one-line reason: the deliberate ones say why; any other note stays the core's. */
export function readonlyReason(i: Pick<SettingItem, "name" | "note">): string {
  if (i.note !== RADIO_ONLY) return i.note;
  return WHY.find(([re]) => re.test(i.name.trim()))?.[1] ?? "Set on the radio only.";
}

/** A row Radio Settings links elsewhere (`kind: "link"`, `href`), beside the core's own kinds. */
export type Row = Omit<SettingItem, "kind"> & { kind: SettingItem["kind"] | "link"; href?: string };
export type Group = Omit<SettingsGroup, "items"> & { items: Row[] };

const row = (path: string, name: string, value: string, note: string, href?: string, kind: Row["kind"] = "link"): Row => ({
  id: path,
  path,
  name,
  sub: "",
  help: note,
  value,
  changed: false,
  kind,
  choices: [],
  hint: "",
  note,
  href,
});

const PRESETS_HREF = "#/channels?tab=presets";
const DTMF_HREF = "#/settings-dtmf";

/** The view's groups as Radio Settings shows them: reasons on the read-only rows, and the names the group notes give
 *  as "Shown on the radio only" that Console has more to say about as rows of their own (the range presets and the
 *  skip list: links to Channels & Zones › Range presets; Dry TX: what it is), and the DTMF memories (DTMF-12: a link
 *  to their tab, in Transmit beside the dialer's settings). `presets` and `dtmf` are how many the editors hold, null
 *  when not read. */
export function present(groups: SettingsGroup[], presets: number | null, dtmf: number | null = null): Group[] {
  return groups.map((g) => {
    const items: Row[] = g.items.map((i) => (i.kind === "readonly" ? { ...i, note: readonlyReason(i) } : i));
    if (g.path === "0 8") {
      // After the dialer's settings (0 8 5 x), under their heading: the memories are the dialer's, not a menu item.
      const value = dtmf === null ? "Edit them" : `Edit ${dtmf === 1 ? "1 memory" : `${dtmf} memories`}`;
      const at = items.findLastIndex((i) => i.path.startsWith("0 8 5 "));
      const sub = at >= 0 ? items[at].sub : "";
      const note = "On Radio Settings › DTMF memories: 16 sequences with their names, read and written there.";
      items.splice(at + 1, 0, { ...row("", "DTMF memories", value, note, DTMF_HREF), id: "dtmf-memories", sub });
    }
    const m = /^Shown on the radio only: (.*)\.$/.exec(g.note);
    if (!m) return { ...g, items };
    const rest: string[] = [];
    for (const name of m[1].split(", ")) {
      if (g.path === "0 1" && name === "Range presets") {
        const value = presets === null ? "Edit them" : `Edit ${presets === 1 ? "1 preset" : `${presets} presets`}`;
        items.push(row("0 1 4", name, value, "On Channels & Zones › Range presets: read and written with the channels.", PRESETS_HREF));
      } else if (g.path === "0 1" && name === "Skip list") {
        items.push(row("0 1 5", name, "Range presets", "This scan's skips, held only while it scans: nothing to set. Each range's own skips stay with its preset.", PRESETS_HREF));
      } else if (name === "Dry TX") {
        const sub = items.find((x) => x.path.startsWith("0 8 8 "))?.sub ?? "";
        items.push({ ...row("0 8 8 5", name, "Off at power-on", DRY_TX, undefined, "readonly"), sub });
      } else rest.push(name);
    }
    items.sort((a, b) => (a.path && b.path ? cmpPath(a.path, b.path) : 0));
    return { ...g, items, note: rest.length ? `Shown on the radio only: ${rest.join(", ")}.` : "" };
  });
}

/** Menu numbers in the menu's order ("0 1 4" before "0 1 10"). */
function cmpPath(a: string, b: string): number {
  const x = a.split(" ").map(Number);
  const y = b.split(" ").map(Number);
  for (let k = 0; k < Math.max(x.length, y.length); k++) {
    const d = (x[k] ?? -1) - (y[k] ?? -1);
    if (d) return d;
  }
  return 0;
}
