<script lang="ts">
  // Airports near a place (NeonPlug's airports.json): their VHF airband frequencies with types, added as AM
  // channels, RX only (Ferrite never transmits on airband), named "ICAO TYPE" in 16 characters.
  import { library, type Airport } from "../../library.svelte";
  import { channels } from "../../channels.svelte";
  import { airportName, airportType, near, type LibraryItem } from "../../core";
  import PlacePicker from "./PlacePicker.svelte";
  import ZoneTarget, { zoneName, type Target } from "./ZoneTarget.svelte";

  let { onadded }: { onadded: () => void } = $props();

  /** Common and itinerant aircraft frequencies (RadioReference's list, as NeonPlug has it). */
  const COMMON: [number, string][] = [
    [121.5, "Guard 121.5"],
    [122.7, "Unicom 122.7"],
    [122.725, "Unicom 122.725"],
    [122.75, "Air-Air 122.75"],
    [122.8, "Unicom 122.8"],
    [122.85, "Multicom 122.85"],
    [122.9, "Multicom 122.9"],
    [122.925, "Multicom 122.92"],
    [122.95, "Unicom 122.95"],
    [122.975, "Unicom 122.975"],
    [123.0, "Unicom 123.0"],
    [123.025, "Helo A-A 123.02"],
    [123.05, "Unicom 123.05"],
    [123.075, "Unicom 123.075"],
    [123.1, "SAR 123.1"],
    [123.45, "Air-Air 123.45"],
  ];

  library.loadAirports();
  let picked = $state<Set<string>>(new Set());
  let common = $state(false);
  let target = $state<Target>({ kind: "each", name: "Airports", existing: 0 });

  type Freq = { khz: number; type: string };
  const freqs = (a: Airport): Freq[] => {
    const list = typeof a.f === "number" ? [a.f] : typeof a.f[0] === "number" && a.f.length === 2 && typeof a.f[1] === "string" ? [a.f as [number, string]] : (a.f as (number | [number, string])[]);
    return list.map((f) => (typeof f === "number" ? { khz: f, type: airportType("", f) } : { khz: f[0], type: airportType(f[1] ?? "", f[0]) }));
  };

  const found = $derived.by(() => {
    const d = library.airports;
    const p = library.place;
    if (!d || !p) return [];
    return near(p, library.radius, d.coords, 300).map(({ i, km }) => ({ a: d.rows[i], km, freqs: freqs(d.rows[i]) }));
  });
  const nChannels = $derived(found.filter((f) => picked.has(f.a.c)).reduce((n, f) => n + f.freqs.length, 0) + (common ? COMMON.length : 0));

  function toggle(c: string) {
    const n = new Set(picked);
    if (n.has(c)) n.delete(c);
    else n.add(c);
    picked = n;
  }

  function add() {
    const zones = channels.table.zones;
    const items: LibraryItem[] = [];
    const sel = found.filter((f) => picked.has(f.a.c));
    for (const f of sel) {
      const seen = new Map<string, number>();
      for (const q of f.freqs) seen.set(q.type, (seen.get(q.type) ?? 0) + 1);
      for (const q of f.freqs) {
        items.push({
          name: airportName(f.a.c, q.type, q.khz, (seen.get(q.type) ?? 0) > 1),
          rx: q.khz / 1000,
          mode: "AM",
          power: "Low",
          rx_only: true,
          zone: zoneName(target, f.a.c, zones),
        });
      }
    }
    if (common) {
      for (const [mhz, name] of COMMON) {
        items.push({ name, rx: mhz, mode: "AM", power: "Low", rx_only: true, zone: zoneName(target, "Aircraft", zones) });
      }
    }
    const what = sel.length === 1 ? sel[0].a.c : `${sel.length} airports`;
    library.add(items, common && !sel.length ? "common aircraft frequencies" : what);
    picked = new Set();
    onadded();
  }
</script>

<PlacePicker />
{#if !library.airports}
  <p class="sub">Loading airports…{#if library.loading}&nbsp;{Math.round(library.loading.done / 1024)} KB{/if}</p>
{:else if !library.place}
  <p class="sub">{library.airports.rows.length.toLocaleString()} airports with VHF frequencies. Give a place to list the ones near it.</p>
{:else}
  <div class="head">
    <span>{found.length} {found.length === 1 ? "airport" : "airports"} within {library.radius} km</span>
    <span class="spacer"></span>
    <button class="btn quiet sm" disabled={!found.length} onclick={() => (picked = new Set(found.map((f) => f.a.c)))}>All</button>
    <button class="btn quiet sm" onclick={() => (picked = new Set())}>None</button>
  </div>
  <div class="list" aria-label="Airports">
    {#each found as f (f.a.c)}
      <label class="ap" class:on={picked.has(f.a.c)}>
        <input type="checkbox" checked={picked.has(f.a.c)} onchange={() => toggle(f.a.c)} aria-label={f.a.c} />
        <b class="icao">{f.a.c}</b>
        <span class="km">{f.km < 10 ? f.km.toFixed(1) : Math.round(f.km)} km</span>
        <span class="fs">
          {#each f.freqs as q, j (j)}<span class="chip"><span class="mhz">{(q.khz / 1000).toFixed(3)}</span> {q.type}</span>{/each}
        </span>
      </label>
    {:else}
      <p class="sub pad">No airport with VHF frequencies within {library.radius} km.</p>
    {/each}
  </div>
{/if}
<label class="common"><input type="checkbox" bind:checked={common} /> Also the {COMMON.length} common aircraft frequencies (Guard 121.5, Unicom, air-to-air, SAR)</label>
<div class="foot">
  <ZoneTarget bind:value={target} each="One zone per airport" />
  <span class="spacer"></span>
  <span class="sub">AM, RX only</span>
  <button class="btn primary" disabled={!nChannels} onclick={add}>Add {nChannels} {nChannels === 1 ? "channel" : "channels"}</button>
</div>

<style>
  .head {
    display: flex;
    gap: 6px;
    align-items: center;
    font-size: 12px;
    color: var(--sub);
  }
  .sm {
    padding: 3px 10px;
    font-size: 12px;
  }
  .list {
    flex: 1;
    min-height: 120px;
    overflow: auto;
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 4px;
  }
  .ap {
    display: grid;
    grid-template-columns: auto 64px 64px 1fr;
    gap: 10px;
    align-items: baseline;
    padding: 5px 6px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 13px;
  }
  .ap:hover {
    background: var(--raised);
  }
  .ap.on {
    background: var(--focus);
  }
  .km {
    color: var(--sub);
    font-size: 12px;
    text-align: right;
  }
  .fs {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 6px;
  }
  .chip {
    font-size: 11px;
    color: var(--sub);
    border: 1px solid var(--line);
    border-radius: 5px;
    padding: 0 5px;
  }
  .mhz {
    color: var(--text);
  }
  .common {
    display: flex;
    gap: 8px;
    align-items: center;
    font-size: 13px;
  }
  .foot {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    align-items: center;
    border-top: 1px solid var(--line);
    padding-top: 12px;
  }
  .spacer {
    flex: 1;
  }
  .sub {
    color: var(--sub);
    font-size: 12px;
  }
  .pad {
    padding: 12px;
  }
</style>
