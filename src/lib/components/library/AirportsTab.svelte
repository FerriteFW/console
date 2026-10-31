<script lang="ts">
  // Airports near a place (OurAirports, tiled by 2-character field from data.ferritefw.dev: sites.svelte.ts): their
  // VHF airband frequencies with their uses, added as AM channels, RX only (Ferrite never transmits on airband),
  // named "ICAO TYPE" in 16 characters ("CYVR TWR 119.55" when an airport has two of a type). The common
  // frequencies not tied to an airport come from the fixed "Airband (common)" set. The footer has the data's date,
  // its offline copy and its attribution.
  import { library, type FixedSet } from "../../library.svelte";
  import { channels } from "../../channels.svelte";
  import { airportSites as data, Sites } from "../../sites.svelte";
  import { airportName, airportType, libraryFixedItems, near, type LibraryItem } from "../../core";
  import PlacePicker from "./PlacePicker.svelte";
  import DataFooter from "./DataFooter.svelte";
  import ZoneTarget, { zoneName, type Target } from "./ZoneTarget.svelte";

  let { onadded }: { onadded: () => void } = $props();

  library.loadFixed();
  data.start();
  $effect(() => {
    const p = library.place;
    if (p) data.look(p.lat, p.lon, library.radius);
  });

  let picked = $state<Set<string>>(new Set());
  let common = $state(false);
  let target = $state<Target>({ kind: "each", name: "Airports", existing: 0 });

  /** The fixed set of airband frequencies not tied to one airport. */
  const commonSet = $derived<FixedSet | undefined>(library.fixed?.find((s) => s.name === "Airband"));

  /** The rows for this place and radius (not an earlier place's while the new one loads). */
  const result = $derived.by(() => {
    const p = library.place;
    const d = data.near;
    return p && d && d.key === Sites.key(p.lat, p.lon, library.radius) ? d : null;
  });

  type Freq = { khz: number; type: string };
  type Airport = { key: string; c: string; l: [number, number]; freqs: Freq[] };
  /** The rows (one per frequency) as airports: by name and position, frequencies in order. */
  const airports = $derived.by(() => {
    const by = new Map<string, Airport>();
    for (const r of result?.sites ?? []) {
      const key = `${r.name}|${r.lat}|${r.lon}`;
      let a = by.get(key);
      if (!a) by.set(key, (a = { key, c: r.name, l: [r.lat, r.lon], freqs: [] }));
      const khz = r.f / 2;
      a.freqs.push({ khz, type: airportType(r.type, Math.round(khz)) });
    }
    const list = [...by.values()];
    for (const a of list) a.freqs.sort((x, y) => x.khz - y.khz);
    const coords = new Float64Array(list.length * 2);
    list.forEach((a, i) => {
      coords[2 * i] = a.l[0];
      coords[2 * i + 1] = a.l[1];
    });
    return { list, coords };
  });
  const found = $derived.by(() => {
    const p = library.place;
    if (!p) return [];
    return near(p, library.radius, airports.coords, 300).map(({ i, km }) => ({ a: airports.list[i], km }));
  });
  const nCommon = $derived(common ? (commonSet?.frequencies.length ?? 0) : 0);
  const nChannels = $derived(found.filter((f) => picked.has(f.a.key)).reduce((n, f) => n + f.a.freqs.length, 0) + nCommon);

  const failed = $derived(result?.failed ?? []);
  /** Nothing to show at all: the data couldn't be reached and nothing is kept. */
  const down = $derived(!!result && !result.sources.length && failed.length > 0);
  const here = $derived(new Set(found.length ? ["airports"] : []));
  const total = $derived(data.listed[0]?.rows);

  function toggle(k: string) {
    const n = new Set(picked);
    if (n.has(k)) n.delete(k);
    else n.add(k);
    picked = n;
  }

  function add() {
    const zones = channels.table.zones;
    const items: LibraryItem[] = [];
    const sel = found.filter((f) => picked.has(f.a.key));
    for (const f of sel) {
      const seen = new Map<string, number>();
      for (const q of f.a.freqs) seen.set(q.type, (seen.get(q.type) ?? 0) + 1);
      for (const q of f.a.freqs) {
        items.push({
          name: airportName(f.a.c, q.type, Math.round(q.khz), (seen.get(q.type) ?? 0) > 1),
          rx: q.khz / 1000,
          mode: "AM",
          power: "Low",
          rx_only: true,
          zone: zoneName(target, f.a.c, zones),
          pos: f.a.l, // the airport's position (LINK-53: the channel's)
        });
      }
    }
    if (common && commonSet) {
      const set = $state.snapshot(commonSet);
      items.push(...libraryFixedItems(set, set.frequencies.map((_, i) => i), zoneName(target, "Airband", zones)));
    }
    const what = sel.length === 1 ? sel[0].a.c : `${sel.length} airports`;
    library.add(items, common && !sel.length ? "common airband frequencies" : what);
    picked = new Set();
    onadded();
  }
</script>

<PlacePicker />
{#if !library.place}
  <p class="sub">
    {#if total}
      {total.toLocaleString()} airport frequencies worldwide (VHF airband). Give a place to list the airports near it.
    {:else if data.topError}
      Airports' VHF airband frequencies worldwide. Give a place to list the airports near it. (The data isn't reachable right now: {data.topError}.)
    {:else}
      Loading the airports' index…
    {/if}
  </p>
{:else if down}
  <div class="msg" role="status">
    <b>Airports aren't available right now.</b>
    <span>{failed[0].error}. Places you looked at before, and airports saved for offline, still work.</span>
    <button class="btn quiet sm" onclick={() => data.retry()}>Try again</button>
  </div>
{:else if !result}
  <p class="sub">Loading airports near the place…</p>
{:else}
  <div class="head">
    <span>{found.length} {found.length === 1 ? "airport" : "airports"} within {library.radius} km</span>
    <span class="spacer"></span>
    <button class="btn quiet sm" disabled={!found.length} onclick={() => (picked = new Set(found.map((f) => f.a.key)))}>All</button>
    <button class="btn quiet sm" onclick={() => (picked = new Set())}>None</button>
  </div>
  {#if failed.length}<p class="warn">{failed.map((f) => f.error).join(" · ")}</p>{/if}
  <div class="list" aria-label="Airports">
    {#each found as f (f.a.key)}
      <label class="ap" class:on={picked.has(f.a.key)}>
        <input type="checkbox" checked={picked.has(f.a.key)} onchange={() => toggle(f.a.key)} aria-label={f.a.c} />
        <b class="icao">{f.a.c}</b>
        <span class="km">{f.km < 10 ? f.km.toFixed(1) : Math.round(f.km)} km</span>
        <span class="fs">
          {#each f.a.freqs as q, j (j)}<span class="chip"><span class="mhz">{(q.khz / 1000).toFixed(3)}</span> {q.type}</span>{/each}
        </span>
      </label>
    {:else}
      <p class="sub pad">No airport with VHF frequencies within {library.radius} km.</p>
    {/each}
  </div>
{/if}
{#if commonSet}
  <label class="common"><input type="checkbox" bind:checked={common} /> Also the {commonSet.frequencies.length} common airband frequencies (emergency 121.5, air-to-air, multicom, en route: the Airband set)</label>
{/if}
<div class="foot">
  <ZoneTarget bind:value={target} each="One zone per airport" />
  <span class="spacer"></span>
  <span class="sub">AM, RX only</span>
  <button class="btn primary" disabled={!nChannels} onclick={add}>Add {nChannels} {nChannels === 1 ? "channel" : "channels"}</button>
</div>
<DataFooter {data} {here} />

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
  .msg {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 10px;
    align-items: center;
    padding: 10px 12px;
    border: 1px solid var(--line);
    border-radius: 8px;
    font-size: 13px;
  }
  .warn {
    margin: 0;
    font-size: 12px;
    color: var(--red);
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
